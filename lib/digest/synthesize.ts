/**
 * synthesize.ts — Cross-source synthesis composer for the evening email.
 *
 * Takes the per-company article buckets produced by group-by-company.ts and
 * uses Sonnet 4.6 (via Cloudflare AI Gateway) to write a narrative synthesis
 * that connects threads across sources.
 *
 * Output rules:
 *   - Must start with a `#` or `##` header.
 *   - 60–150 words per section.
 *   - Citations inline as [SourceName](url).
 *   - `## Also covered` closing section for thin coverage.
 */

import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { stripModelPreamble } from "@/lib/ai/strip-preamble";
import { editionLabel } from "@/lib/digest/editions";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { insertBeforeAlsoCovered } from "@/lib/digest/thin-coverage";
import type { CompanyBucket } from "@/lib/digest/group-by-company";

// ─── Error class ─────────────────────────────────────────────────────────────

export class SynthesisEmptyError extends Error {
  constructor(reason: string) {
    super(`Synthesis returned no usable content: ${reason}`);
    this.name = "SynthesisEmptyError";
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SynthesisInput {
  /** Per-company article buckets from lib/digest/group-by-company.ts */
  buckets: CompanyBucket[];
  /** User's held tickers (from portfolio). */
  heldSymbols: string[];
  /** User's watchlist tickers. */
  watchlist: string[];
  /**
   * Today's anomaly flags — only symbol + company name are passed.
   * No $ amounts or position sizes (privacy rule).
   */
  anomalies: { symbol: string; companyName: string | null }[];
  /**
   * Heading for the lead macro/market section: "The Session" (evening) or
   * "Overnight & Setup" (morning). Defaults to "The Session".
   */
  sessionHeading?: string;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYNTHESIS_SYSTEM_PROMPT_BASE = `You are synthesizing newsletter coverage for a portfolio investor's day-end recap. Write one section per company/topic that surfaces what mattered TODAY across sources, with citations.

CRITICAL OUTPUT RULES:
- First character must be \`#\`. No preamble, no narration ("I'll now...", "Good, here is..."), no closing commentary.
- Use ## CompanyName as section headers (or ## Macro for the no-symbol bucket).
- Cite sources inline as [SourceName](url) — the SourceName link is mandatory whenever you reference any claim.
- Connect threads ACROSS sources where they exist. If only one source mentions something, say so ("Only Vital Knowledge flagged X today").
- Skip companies/topics with thin coverage (1 article, no portfolio relevance) — weave them into a closing "## Also covered" line at the end.
- 60-150 words per section. Skip if no meaningful synthesis is possible.
- DO NOT include P&L numbers, position sizes, or anything that would reveal what the user owns. Write as if for an analyst peer.

COVERAGE-CHARACTERIZATION RULES (HARD):
- Do NOT label any source as having mentioned a symbol "indirectly", "only briefly", "in passing", "tangentially", "without focus", or any synonym. You cannot reliably tell from the bucket's article summaries whether a symbol was the lead topic or one of many tickers in a long list. If a symbol appears in a source's bucket entry, that source covered it — narrate WHAT the source said about it (drawn from the summary you were given), not HOW PROMINENTLY it said it.
- If you have nothing concrete to say beyond "Source X mentioned this", either (a) write a substantive section anchored on the summary text you were given, or (b) move the symbol to "## Also covered" with the citation but no characterization of coverage-depth.
- Specifically forbidden phrasings: "only mentioned indirectly", "mentioned in passing", "no real focus on", "appeared only as a footnote", "briefly noted", "not the focus of any source".

HELD-TICKER PRIORITIZATION:
- Every held ticker (in the "Held tickers" list above the buckets) that has ANY coverage in today's buckets MUST get its own \`##\` section, however brief. Do NOT relegate held tickers to "## Also covered" — even single-article coverage of a held name warrants a focused section with the citation and what was said. The user's portfolio context makes held-name coverage load-bearing.

TIMEFRAME & THREAD COHERENCE (HARD):
- A single company section may draw on articles from DIFFERENT trading days and with OPPOSING sentiment. When it does, attribute each price move or claim to its specific day ("rose Thursday as money rotated into financials; fell ~5% Friday in the broad selloff") instead of fusing them into one cause-and-effect sentence. A name being up one day and down the next is NOT a contradiction — name the days so the reader sees two sessions, not one muddled one.
- Keep a structural / longer-horizon thread (e.g. an IPO-underwriting fee catalyst, a pending deal, a product cycle) SEPARATE from a same-day tactical move (e.g. today's selloff). Put them in separate sentences and do not imply one caused the other unless a source explicitly says so.
- Do not invent a sector or market driver a source did not state. If a held name fell but no source attributes the move to its sector, say it fell with the broad market — do not assert an unsourced reason (e.g. "as the selloff hit brokers/banks") that no article supports.

ATTRIBUTION & PROVENANCE (HARD):
- A source's summary sometimes RELAYS a third party's views rather than voicing the source's own opinion — a podcast guest, an interview subject, or a quoted analyst (the summary will say so, e.g. "TMT Breakout summarizes Gavin Baker's podcast remarks"). When it does, attribute the view to the ORIGINATOR, not the newsletter: write "Gavin Baker (via TMT Breakout) argued ..." — never "TMT Breakout argued ..." as if it were the newsletter's own call.
- Do not strip a named originator out of a relayed view. And do not invent an originator when the summary names none — a summary with no relay attribution IS the source's own view.`;

function buildSystemPrompt(sessionHeading: string): string {
  return `${SYNTHESIS_SYSTEM_PROMPT_BASE}

EDITION COLLAPSING (HARD):
- Some bucket lines carry an edition tag like [dawn], [midday], [recap], [morning_wrap], [eod_wrap], [one-off note]. Tagged articles are installments of ONE publication's daily cycle: dawn → midday → recap narrate the SAME trading session as it develops, and later editions supersede earlier ones.
- Tell each session's story ONCE, chronologically. Treat the latest edition as the authoritative account; pull from earlier editions only what the later ones dropped. Never present two editions of the same publication as independent sources agreeing with each other — they are the same desk.
- An intraday reversal (up at midday, down by the close) is one narrative beat ("reversed in the afternoon as …"), not two contradictory reports.

OUTPUT SECTION ORDER (HARD):
- First section: \`## ${sessionHeading}\` — the macro / market-wide narrative drawn from the Macro bucket and the session-arc commentary.
- Then one section per company with meaningful coverage. The header MUST begin with the ticker symbol exactly as given in the bucket heading — \`## NVDA (NVIDIA Corp)\` — because deterministic post-processing matches on the leading ticker.
- Last section: \`## Also covered\`.`;
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

const NO_SYMBOL_BUCKET = "(no symbol)";

/**
 * Render one bucket to a compact markdown block for the user prompt.
 *
 *   ## NVDA (NVIDIA Corp)
 *   - Vital Knowledge (bullish) [https://...]: <summary>
 */
function renderBucket(bucket: CompanyBucket): string {
  const isNoSymbol = bucket.symbol === NO_SYMBOL_BUCKET;
  let heading: string;
  if (isNoSymbol) {
    heading = "## Macro";
  } else if (bucket.companyName) {
    heading = `## ${bucket.symbol} (${bucket.companyName})`;
  } else {
    heading = `## ${bucket.symbol}`;
  }

  const lines: string[] = [heading];
  for (const article of bucket.articles) {
    const sentiment = article.sentiment ?? "neutral";
    const url = article.source_url || article.website_url;
    const urlPart = url ? ` [${url}]` : "";
    const summaryText = article.summary ?? article.subject ?? "(no summary)";
    lines.push(
      `- ${article.source_name}${editionLabel(article.source_name, article.subject)} (${sentiment})${urlPart}: ${summaryText}`,
    );
  }

  return lines.join("\n");
}

/**
 * Build the full user prompt for the synthesis call.
 */
function buildSynthesisPrompt(input: SynthesisInput): string {
  const held =
    input.heldSymbols.length > 0 ? input.heldSymbols.join(", ") : "(none)";
  const watchlist =
    input.watchlist.length > 0 ? input.watchlist.join(", ") : "(none)";
  const anomalyList =
    input.anomalies.length > 0
      ? input.anomalies.map((a) => a.symbol).join(", ")
      : "(none)";

  const renderedBuckets = input.buckets
    .map(renderBucket)
    .join("\n\n");

  return [
    `Held tickers: ${held}`,
    `Watchlist: ${watchlist}`,
    `Today's anomaly flags: ${anomalyList}`,
    "",
    "Per-company buckets (today's articles only):",
    "",
    renderedBuckets,
    "",
    "Render the synthesis now.",
  ].join("\n");
}

// ─── Held-ticker enforcement ─────────────────────────────────────────────────

const STUB_SUMMARY_CHAR_CAP = 240;

function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

function renderHeldStub(bucket: CompanyBucket): string {
  const heading = bucket.companyName
    ? `## ${bucket.symbol} (${bucket.companyName})`
    : `## ${bucket.symbol}`;
  const lines = [heading, ""];
  for (const article of bucket.articles) {
    const url = article.source_url || article.website_url;
    const cite = url ? `[${article.source_name}](${url})` : article.source_name;
    const summary = truncateAtWord(
      (article.summary ?? article.subject ?? "").replace(/\s+/g, " ").trim(),
      STUB_SUMMARY_CHAR_CAP,
    );
    lines.push(`- ${cite}: ${summary}`);
  }
  lines.push("", "*Held-name coverage auto-surfaced from today's sources.*");
  return lines.join("\n");
}

/**
 * Deterministic backstop for the HELD-TICKER PRIORITIZATION prompt rule: the
 * prompt REQUESTS a `##` section for every held name with bucket coverage,
 * but the model intermittently relegates one to "## Also covered" anyway
 * (7/20 digest: held CSX with two-article VK coverage). Prompts request;
 * post-processing enforces — same philosophy as insertCrossFilePointers.
 *
 * Any held bucket (issuerSiblings-aware, so a GOOGL bucket is satisfied by a
 * GOOG heading) with no matching `##` section gets a citation stub — the
 * bucket's own source links + summary excerpts — inserted before
 * "## Also covered" (or appended at the end when that close is absent).
 * Pure; exported for tests.
 */
export function enforceHeldSections(markdown: string, input: SynthesisInput): string {
  const heldSet = new Set(input.heldSymbols.map((s) => s.toUpperCase()));

  // Every ticker-ish token appearing in a `##` heading before any "(".
  const headingTokens = new Set<string>();
  for (const line of markdown.split("\n")) {
    const m = line.match(/^##\s+(.+)$/);
    if (!m) continue;
    for (const tok of m[1].split("(")[0].split(/[\s/,]+/)) {
      const t = tok.trim().toUpperCase();
      if (t.length > 0 && /^[A-Z0-9.\-]+$/.test(t)) headingTokens.add(t);
    }
  }

  const stubs: string[] = [];
  const missing: string[] = [];
  for (const bucket of input.buckets) {
    if (bucket.symbol === NO_SYMBOL_BUCKET) continue;
    const family = issuerSiblings(bucket.symbol).map((s) => s.toUpperCase());
    if (!family.some((s) => heldSet.has(s))) continue;
    if (family.some((s) => headingTokens.has(s))) continue;
    if (bucket.articles.length === 0) continue;
    missing.push(bucket.symbol);
    stubs.push(renderHeldStub(bucket));
  }
  if (stubs.length === 0) return markdown;

  console.warn(
    `[synthesize] held-ticker section missing for ${missing.join(", ")} — auto-surfaced citation stub(s)`,
  );

  const stubBlock = stubs.join("\n\n");
  return insertBeforeAlsoCovered(markdown, stubBlock);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run the cross-source synthesis pass using Sonnet 4.6.
 *
 * Throws `SynthesisEmptyError` when:
 *   - The model output was truncated (`finishReason === "length"`).
 *   - After preamble-stripping, the first non-empty line has no `#` header.
 *   - The cleaned text is under 200 characters.
 *
 * @throws SynthesisEmptyError
 */
export async function synthesize(input: SynthesisInput): Promise<string> {
  const prompt = buildSynthesisPrompt(input);
  const sessionHeading = input.sessionHeading ?? "The Session";

  let result: Awaited<ReturnType<typeof generateTextForFeature>>;
  try {
    result = await generateTextForFeature("dailyDigestSynthesis", {
      system: buildSystemPrompt(sessionHeading),
      prompt,
      // 8192, not 4096: the structured contract (## Session + one ## section per
      // covered name + ## Also covered) over a 25-40 article window regularly
      // exceeds 4096 output tokens — observed live 2026-06-09, where truncation
      // tripped the finishReason guard and silently degraded every heavy day to
      // the per-source fallback layout.
      maxOutputTokens: 8192,
    });
  } catch (e) {
    if (e instanceof AIRefusalError) {
      console.warn(`[synthesize] Model refused (${e.modelId}); treating as empty synthesis`);
      throw new SynthesisEmptyError("model refusal");
    }
    throw e;
  }

  // ── Validation ────────────────────────────────────────────────────────────

  // 1. Truncation guard — if the model ran out of tokens the output is incomplete.
  if (result.finishReason === "length") {
    throw new SynthesisEmptyError("output truncated by max tokens");
  }

  // 2. Strip any model preamble before structural validation.
  const stripped = stripModelPreamble(result.text);

  // 3. Strict header check.
  //    stripModelPreamble is pass-through when no markdown marker is found (it
  //    returns the full input with firstReal=0). For synthesis we require at
  //    least one `#` or `##` header as the first content line.
  const firstNonEmpty = stripped
    .split("\n")
    .find((line) => line.trim().length > 0);
  if (!firstNonEmpty || !firstNonEmpty.trim().startsWith("#")) {
    throw new SynthesisEmptyError("output has no markdown headers");
  }

  // 4. Minimum length guard.
  if (stripped.length < 200) {
    throw new SynthesisEmptyError(
      `output too short (${stripped.length} chars)`,
    );
  }

  // 5. Deterministic held-ticker backstop (prompt rule → enforced).
  return enforceHeldSections(stripped, input);
}

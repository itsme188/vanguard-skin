/**
 * synthesize.ts — Cross-source synthesis composer for the evening email.
 *
 * Takes the per-company article buckets produced by group-by-company.ts and
 * uses Sonnet 4.6 (via Cloudflare AI Gateway) to write a narrative synthesis
 * that connects threads across sources.
 *
 * Output rules:
 *   - Must start with a `#` or `##` header.
 *   - Concise takeaway-first paragraphs; shared sector stories grouped.
 *   - Citations inline as [SourceName](url).
 *   - `## Also covered` closing section for thin coverage.
 */

import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { stripModelPreamble } from "@/lib/ai/strip-preamble";
import { DIGEST_EDITORIAL_RULES, retainSuppliedSourceLinks } from "./synthesis-editorial";
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

const SYNTHESIS_SYSTEM_PROMPT_BASE = `You are synthesizing newsletter coverage for a portfolio investor's day-end recap. Surface what mattered TODAY across sources, with citations.

${DIGEST_EDITORIAL_RULES}

CRITICAL OUTPUT RULES:
- First character must be \`#\`. No preamble, no narration ("I'll now...", "Good, here is..."), no closing commentary.
- Use descriptive ## headings for shared sector/topic stories and ## TICKER (CompanyName) for substantive company-specific sections.
- DO NOT include P&L numbers, position sizes, or anything that would reveal what the user owns. Write as if for an analyst peer.

TIMEFRAME & THREAD COHERENCE (HARD):
- A single company section may draw on articles from DIFFERENT trading days and with OPPOSING sentiment. When it does, attribute each price move or claim to its specific day ("rose Thursday as money rotated into financials; fell ~5% Friday in the broad selloff") instead of fusing them into one cause-and-effect sentence. A name being up one day and down the next is NOT a contradiction — name the days so the reader sees two sessions, not one muddled one.
- Keep a structural / longer-horizon thread (e.g. an IPO-underwriting fee catalyst, a pending deal, a product cycle) SEPARATE from a same-day tactical move (e.g. today's selloff). Put them in separate sentences and do not imply one caused the other unless a source explicitly says so.
- Do not invent a sector or market driver a source did not state. If no source states the cause of a move, leave the cause unstated — do not assert an unsourced reason (e.g. "as the selloff hit brokers/banks") that no article supports.

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
- Then substantive company developments and grouped sector/theme stories, ordered by importance. Company-specific headers begin with the ticker; sector/topic headers are descriptive.
- An optional \`## Also covered\` may contain additional substantive takeaways, never a ticker roster.`;
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

export { boundSynthesisBuckets, DEFAULT_SYNTHESIS_LIMITS } from "./synthesis-budget";
import { boundSynthesisBuckets, renderBucket, synthesisCoverageNotice, type BoundedSynthesisBuckets } from "./synthesis-budget";

/**
 * Build the full user prompt for the synthesis call from an ALREADY-BOUNDED
 * bucket set (see boundSynthesisBuckets). Overflow symbols get one compact
 * line so the model knows they exist without being handed content it would
 * be tempted to write a section from. Exported so tests can pin the size.
 */
export function buildSynthesisPrompt(
  input: SynthesisInput,
  bounded: BoundedSynthesisBuckets,
): string {
  const held =
    input.heldSymbols.length > 0 ? input.heldSymbols.join(", ") : "(none)";
  const watchlist =
    input.watchlist.length > 0 ? input.watchlist.join(", ") : "(none)";
  const anomalyList =
    input.anomalies.length > 0
      ? input.anomalies.map((a) => a.symbol).join(", ")
      : "(none)";

  const renderedBuckets = bounded.priority
    .map(renderBucket)
    .join("\n\n");

  const lines = [
    `Held tickers: ${held}`,
    `Watchlist: ${watchlist}`,
    `Today's anomaly flags: ${anomalyList}`,
    "",
    "Per-company buckets (today's articles only):",
    "",
    renderedBuckets,
    "",
  ];

  if (bounded.overflowSymbols.length > 0) {
    lines.push(
      `Also mentioned today (no section needed; list under "## Also covered" if relevant): ${bounded.overflowSymbols.join(", ")}`,
      "",
    );
  }

  lines.push("Render the synthesis now.");
  return lines.join("\n");
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
  const bounded = boundSynthesisBuckets(input.buckets, {
    heldSymbols: input.heldSymbols,
    watchlist: input.watchlist,
    anomalySymbols: input.anomalies.map((a) => a.symbol),
  });
  const prompt = buildSynthesisPrompt(input, bounded);
  const sessionHeading = input.sessionHeading ?? "The Session";
  let result: Awaited<ReturnType<typeof generateTextForFeature>>;
  try {
    result = await generateTextForFeature("dailyDigestSynthesis", {
      system: buildSystemPrompt(sessionHeading),
      prompt,
      // Allow the bounded company sections room to complete; mirror in Worker.
      maxOutputTokens: 16384,
    });
  } catch (e) {
    if (e instanceof AIRefusalError) {
      console.warn(`[synthesize] Model refused (${e.modelId}); treating as empty synthesis`);
      throw new SynthesisEmptyError("model refusal");
    }
    throw e;
  }

  // ── Validation ────────────────────────────────────────────────────────────

  // Always log the call's shape: a "length" finish is ambiguous at the SDK
  // level (see below), so the next production run has to be diagnosable from
  // the log line alone.
  const outputTokens = result.usage?.outputTokens ?? null;
  const textLength = result.text?.length ?? 0;
  console.warn(
    `[synthesize] prompt ${prompt.length} chars · buckets kept ${bounded.priority.length}, ` +
      `overflow ${bounded.overflowSymbols.length} · finish ${result.finishReason} · ` +
      `usage in=${result.usage?.inputTokens ?? "?"} out=${outputTokens ?? "?"} · text ${textLength} chars`,
  );

  // The SDK's length finish does not identify which model limit was reached.
  if (result.finishReason === "length") {
    throw new SynthesisEmptyError(
      `output truncated at a model length limit (${outputTokens ?? "unknown"} output tokens; prompt ${prompt.length} chars)`,
    );
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

  // Editorial grouping/omission must survive post-processing.
  const complete = retainSuppliedSourceLinks(stripped, input.buckets.flatMap(b => b.articles));
  const notice = synthesisCoverageNotice(bounded);
  return notice ? `${complete}\n\n${notice}` : complete;
}

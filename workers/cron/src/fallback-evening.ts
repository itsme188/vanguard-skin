/**
 * Cloud-fallback evening email — runs when the Mac primary path fails.
 *
 * Flow:
 *   1. Load R2 snapshot. Require schemaVersion >= 2 (v1 has no useful content).
 *   2. Determine recipient: settings.evening_email_recipients → BRIEFING_EMAIL_TO.
 *   3. Determine `since`: settings.last_digest_sent_at ?? (now - 24h).
 *   4. Fetch articles via snapshot meta (same approach as fallback-digest).
 *   5. If schemaVersion >= 3 AND vanguardHoldings + securityBetas are present:
 *        fetch SPY + Vanguard-symbol last-2-closes from Yahoo and compute
 *        anomalies inline (ported from lib/digest/anomalies.ts, no DB access).
 *        Yahoo failure is swallowed — anomaly block gracefully omitted.
 *   6. Compose body: synthesis (AI) if >= 5 articles, otherwise per-source.
 *   7. Assemble markdown: [anomalyBlock, body] filtered + joined with "---".
 *   8. If empty → return {kind: "skipped"}.
 *   9. Send via Resend with fromLocalPart: "evening".
 *
 * Privacy: anomaly output emits only public market data (ticker, % move, beta).
 * No $ amounts, share counts, or portfolio-size language.
 */

import { generateText, generateObject, jsonSchema } from "ai";
import { loadLatestSnapshot, type Snapshot, type RecentArticleMeta } from "./state";
import { sendEmail } from "./resend";
import { generateWithFailover } from "./ai";
import { briefingToHtml } from "./html";
import { todayET } from "./dst";
import {
  fetchAndProcessNewArticles,
  type FallbackEnv,
  type FallbackResult,
  type ProcessedArticle,
} from "./fallback-digest";
import { editionLabel } from "./editions";
import { issuerSiblings } from "./fallback-earnings";

// Evening live-fetch cap, sized against the 50-subrequest Workers free-tier
// ceiling AND the anomaly block's batched Yahoo calls:
//   ≤29 source list + 6×(getMessage + Claude) + ≤2 Yahoo spark chunks
//   + 1 synthesis + 1 Resend = ≤46 subrequests.
// Lower than the digest's 10 because the evening ALSO spends Yahoo subrequests
// on the anomaly block; the morning digest does not. Reliability (the email
// ships) beats completeness (every afternoon article) for a fallback path.
const MAX_ARTICLES_PER_RUN_EVENING = 6;

/**
 * Convert a freshly-fetched + Claude-processed article into the RecentArticleMeta
 * shape the evening's per-source/synthesis renderers consume, so live-fetched
 * mail flows through the same rendering path as snapshot articles. Synthetic
 * negative ids can't collide with real snapshot ids.
 */
function processedToMeta(p: ProcessedArticle, idx: number): RecentArticleMeta {
  return {
    id: -1 - idx,
    source_id: -1,
    source_name: p.source_name,
    gmail_message_id: p.gmail_message_id,
    received_at: p.received_at,
    subject: p.subject,
    sender: "",
    summary: p.summary || null,
    key_themes: p.key_themes.length ? JSON.stringify(p.key_themes) : null,
    sentiment: p.sentiment,
    sentiment_score: null,
    mentioned_symbols: null,
    portfolio_relevance: p.portfolio_relevance || null,
    source_url: p.source_url,
    website_url: null,
    processed_at: todayET(),
    ai_model: null,
  };
}

// ── Yahoo last-2-closes (lightweight, no reaction window needed) ──────────────

interface Last2Closes {
  prior: number;
  today: number;
}

// Chunk size for the multi-symbol spark request. 50 symbols keeps each request
// URL comfortably bounded (~350 chars) and means even a 100-name book costs
// only 2 subrequests — versus one chart request PER symbol, which at 71
// Vanguard holdings was 72 subrequests, OVER the 50-subrequest Workers
// free-tier ceiling, so the anomaly block silently never produced output and
// (worse) left no budget for the evening's live Gmail fetch.
const YAHOO_SPARK_CHUNK = 50;

/**
 * Fetch the two most recent daily closes for MANY symbols using Yahoo's
 * multi-symbol `spark` endpoint, in ceil(N/50) requests. Returns a Map keyed by
 * symbol; a symbol Yahoo omits or returns <2 closes for is simply absent
 * (caller skips it). Never throws — a failed chunk contributes nothing, so a
 * Yahoo outage degrades to "no anomaly block" rather than a failed email.
 */
export async function fetchLast2ClosesBatch(
  symbols: string[],
): Promise<Map<string, Last2Closes>> {
  const out = new Map<string, Last2Closes>();
  const unique = [...new Set(symbols.filter((s) => s && s.length > 0))];

  for (let i = 0; i < unique.length; i += YAHOO_SPARK_CHUNK) {
    const chunk = unique.slice(i, i + YAHOO_SPARK_CHUNK);
    const url =
      `https://query1.finance.yahoo.com/v8/finance/spark` +
      `?symbols=${chunk.map((s) => encodeURIComponent(s)).join(",")}` +
      `&range=7d&interval=1d`;

    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) continue;

      // Spark returns a flat object keyed by the requested symbol:
      //   { "SPY": { timestamp: [...], close: [n, n, ...] }, "AAPL": {...} }
      const data = (await res.json()) as Record<
        string,
        { close?: Array<number | null> } | undefined
      >;

      for (const sym of chunk) {
        const closes = (data[sym]?.close ?? []).filter(
          (c): c is number => c != null,
        );
        if (closes.length < 2) continue;
        out.set(sym, {
          prior: closes[closes.length - 2],
          today: closes[closes.length - 1],
        });
      }
    } catch (err) {
      console.warn("[fallback-evening] Yahoo spark chunk failed:", err);
      // contribute nothing for this chunk; the rest still resolve
    }
  }

  return out;
}

// ── Anomaly computation (ported from lib/digest/anomalies.ts) ─────────────────

// Mirror of lib/digest/anomalies.ts trigger constants. Kept in sync with the
// Mac engine; values MUST match. See design doc 2026-06-01.
const MIN_ABS_MOVE_PCT = 3.0;
const MIN_RESIDUAL_Z = 2.0;
const RESIDUAL_STD_EPSILON = 0.1;

interface AnomalyFlag {
  symbol: string;
  actualPct: number;
  spyPct: number;
  beta: number;
  expectedPct: number;
  residualPct: number;
  zScore: number | null;
  directionFlipped: boolean;
}

/**
 * Pure two-gate anomaly evaluation — mirrors lib/digest/anomalies.ts.
 * `closesMap` must contain "SPY". Returns null when inputs are empty or SPY is
 * missing/invalid. A name is flagged when |move| >= 3% AND (residualStd unusable
 * OR zScore >= 2). Degraded mode (null/tiny residualStd) flags on the floor alone.
 */
export function evaluateAnomalies(
  vanguardHoldings: NonNullable<Snapshot["vanguardHoldings"]>,
  securityBetas: NonNullable<Snapshot["securityBetas"]>,
  closesMap: Map<string, Last2Closes>,
): AnomalyFlag[] | null {
  if (vanguardHoldings.length === 0 || securityBetas.length === 0) return null;

  const spyCloses = closesMap.get("SPY");
  if (!spyCloses || spyCloses.prior === 0) return null;
  const spyPct = ((spyCloses.today - spyCloses.prior) / spyCloses.prior) * 100;

  const lookback60 = securityBetas.filter((b) => b.lookbackDays === 60);
  const betaMap = new Map<number, number>(lookback60.map((b) => [b.securityId, b.beta]));
  const residualStdMap = new Map<number, number | null>(
    lookback60.map((b) => [b.securityId, b.residualStd ?? null]),
  );

  const flags: AnomalyFlag[] = [];

  for (const holding of vanguardHoldings) {
    if (holding.symbol === "SPY") continue;
    const beta = betaMap.get(holding.securityId);
    if (beta == null) continue;

    const closes = closesMap.get(holding.symbol);
    if (!closes || closes.prior === 0) continue;

    const actualPct = ((closes.today - closes.prior) / closes.prior) * 100;
    const expectedPct = spyPct * beta;
    const residualPct = actualPct - expectedPct;

    if (Math.abs(actualPct) < MIN_ABS_MOVE_PCT) continue;

    let zScore: number | null = null;
    const residualStd = residualStdMap.get(holding.securityId) ?? null;
    if (residualStd != null && residualStd > RESIDUAL_STD_EPSILON) {
      zScore = Math.abs(residualPct) / residualStd;
      if (zScore < MIN_RESIDUAL_Z) continue;
    }

    const directionFlipped =
      Math.abs(expectedPct) > 0.1 &&
      Math.sign(actualPct) !== 0 &&
      Math.sign(expectedPct) !== 0 &&
      Math.sign(actualPct) !== Math.sign(expectedPct);

    flags.push({ symbol: holding.symbol, actualPct, spyPct, beta, expectedPct, residualPct, zScore, directionFlipped });
  }

  // Dedup by symbol (multiple accounts may hold same security)
  const seen = new Set<string>();
  const deduped = flags.filter((f) => {
    if (seen.has(f.symbol)) return false;
    seen.add(f.symbol);
    return true;
  });

  // Symbol tie-break keeps the ordering deterministic and byte-identical to the
  // Mac engine (lib/digest/anomalies.ts) on exact z-score ties.
  const sortKey = (f: AnomalyFlag): number =>
    f.zScore ?? Math.abs(f.actualPct) / MIN_ABS_MOVE_PCT;
  deduped.sort((a, b) => sortKey(b) - sortKey(a) || a.symbol.localeCompare(b.symbol));
  return deduped;
}

/**
 * Compute anomaly flags for Vanguard holdings using snapshot data + Yahoo closes.
 * Returns null on any Yahoo failure — caller should log and skip the block.
 */
async function computeAnomaliesFromSnapshot(
  vanguardHoldings: NonNullable<Snapshot["vanguardHoldings"]>,
  securityBetas: NonNullable<Snapshot["securityBetas"]>,
): Promise<AnomalyFlag[] | null> {
  if (vanguardHoldings.length === 0 || securityBetas.length === 0) return null;

  const symbols = [...new Set(vanguardHoldings.map((h) => h.symbol))];
  const allSymbols = ["SPY", ...symbols.filter((s) => s !== "SPY")];
  const closesMap = await fetchLast2ClosesBatch(allSymbols);

  return evaluateAnomalies(vanguardHoldings, securityBetas, closesMap);
}

function signedPct(value: number, decimals = 1): string {
  const rounded = parseFloat(value.toFixed(decimals));
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${rounded.toFixed(decimals)}%`;
}

function formatAnomalyBlock(flags: AnomalyFlag[]): string {
  if (flags.length === 0) return "";

  const lines: string[] = [
    "## Significant Moves in Vanguard Holdings (vs. expected)",
    "",
  ];

  for (const flag of flags) {
    const signedActual = signedPct(flag.actualPct);
    const signedExpected = signedPct(flag.expectedPct);
    const signedSpy = signedPct(flag.spyPct);
    const reason = flag.directionFlipped
      ? "Direction flipped."
      : flag.zScore != null
        ? `${flag.zScore.toFixed(1)}σ move.`
        : `${signedActual} move.`;
    lines.push(
      `- **${flag.symbol}** ${signedActual} — expected ${signedExpected} (beta ${flag.beta.toFixed(1)} × SPY ${signedSpy}). ${reason}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

// ── Article rendering ─────────────────────────────────────────────────────────

function renderPerSource(articles: RecentArticleMeta[]): string {
  if (articles.length === 0) return "";
  const lines: string[] = [];
  for (const a of articles) {
    const sentiment = a.sentiment ?? "neutral";
    lines.push(`## ${a.source_name.toUpperCase()} · *${sentiment}*`);
    const url = a.source_url || a.website_url;
    lines.push(url ? `### [${a.subject}](${url})` : `### ${a.subject}`);
    lines.push("");
    if (a.summary) {
      lines.push(a.summary);
      lines.push("");
    }
    if (a.portfolio_relevance) {
      lines.push(`> **Portfolio relevance**: ${a.portfolio_relevance}`);
      lines.push("");
    }
    const themes = parseJsonArray(a.key_themes);
    if (themes.length > 0) {
      lines.push(`*${themes.join(" · ")}*`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n").trim();
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ── AI synthesis ──────────────────────────────────────────────────────────────

/** Group articles by company using their mentioned_symbols field. */
function bucketByCompany(
  articles: RecentArticleMeta[],
): Record<string, RecentArticleMeta[]> {
  const buckets: Record<string, RecentArticleMeta[]> = {};
  for (const a of articles) {
    const symbols = parseJsonArray(a.mentioned_symbols);
    if (symbols.length === 0) {
      (buckets["(macro/other)"] ??= []).push(a);
    } else {
      for (const sym of symbols) {
        (buckets[sym.toUpperCase()] ??= []).push(a);
      }
    }
  }
  return buckets;
}

// ── Held-ticker enforcement backstop ─────────────────────────────────────────
// Worker adaptation of lib/digest/synthesize.ts::enforceHeldSections (2026-07-20):
// the prompt REQUESTS a ## section per held name with coverage, but the model
// intermittently buries one in "## Also covered" (7/20 Mac digest: held CSX).
// Prompts request; post-processing enforces. Not byte-parity — the Worker's
// bucket shape (Record<symbol, RecentArticleMeta[]>) differs from the Mac's
// CompanyBucket[], but the semantics mirror: any held bucket
// (issuerSiblings-aware) with no matching ## heading gets a deterministic
// citation stub inserted before "## Also covered".

const STUB_SUMMARY_CHAR_CAP = 240;
const NO_SYMBOL_BUCKET = "(macro/other)";

function truncateStubText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > cap * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function enforceHeldSections(
  markdown: string,
  buckets: Record<string, RecentArticleMeta[]>,
  heldSymbols: string[],
): string {
  const heldSet = new Set(heldSymbols.map((s) => s.toUpperCase()));

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
  for (const [symbol, articles] of Object.entries(buckets)) {
    if (symbol === NO_SYMBOL_BUCKET) continue;
    const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
    if (!family.some((s) => heldSet.has(s))) continue;
    if (family.some((s) => headingTokens.has(s))) continue;
    if (articles.length === 0) continue;
    missing.push(symbol);
    const lines = [`## ${symbol}`, ""];
    for (const a of articles) {
      const url = a.source_url || a.website_url;
      const cite = url ? `[${a.source_name}](${url})` : a.source_name;
      const summary = truncateStubText(
        (a.summary ?? a.subject ?? "").replace(/\s+/g, " ").trim(),
        STUB_SUMMARY_CHAR_CAP,
      );
      lines.push(`- ${cite}: ${summary}`);
    }
    lines.push("", "*Held-name coverage auto-surfaced from today's sources.*");
    stubs.push(lines.join("\n"));
  }
  if (stubs.length === 0) return markdown;

  console.warn(
    `[fallback-evening] held-ticker section missing for ${missing.join(", ")} — auto-surfaced citation stub(s)`,
  );

  const stubBlock = stubs.join("\n\n");
  const alsoMatch = markdown.match(/^## Also covered\s*$/m);
  if (alsoMatch && alsoMatch.index !== undefined) {
    return (
      markdown.slice(0, alsoMatch.index) + stubBlock + "\n\n" + markdown.slice(alsoMatch.index)
    );
  }
  return `${markdown.trimEnd()}\n\n${stubBlock}`;
}

// Exported for testability (pins the synthesis prompt's coherence rules).
export function buildSynthesisPrompt(
  buckets: Record<string, RecentArticleMeta[]>,
  snap: Snapshot,
): string {
  const holdingsList = snap.heldSymbols.join(", ") || "(none)";
  const dateStr = todayET();

  const bucketLines: string[] = [];
  for (const [sym, arts] of Object.entries(buckets)) {
    bucketLines.push(`### ${sym}`);
    for (const a of arts) {
      bucketLines.push(`**${a.source_name}${editionLabel(a.source_name, a.subject)}**: ${a.subject}`);
      if (a.summary) bucketLines.push(a.summary);
      if (a.portfolio_relevance) bucketLines.push(`> ${a.portfolio_relevance}`);
      bucketLines.push("");
    }
  }

  return `You are a financial analyst writing an evening recap email (${dateStr}) for a portfolio manager.

Portfolio holdings: ${holdingsList}

Today's research feed — grouped by company/topic:

${bucketLines.join("\n")}

Write a concise markdown evening recap with EXACTLY this section order:
1. \`## The Session\` — the macro / market-wide narrative of the day (2-4 sentences).
2. One \`## SYM\` section per relevant holding with significant coverage — the header MUST begin with the ticker symbol. One tight paragraph each: what was said, what it means for the position.
3. \`## Also covered\` — one closing line for everything thin.

EDITION COLLAPSING (follow strictly):
- Some source names carry an edition tag like [dawn], [midday], [recap], [morning_wrap], [eod_wrap]. Tagged articles are installments of ONE publication's daily cycle; later editions supersede earlier ones. Tell each session's story ONCE — never present two editions of the same publication as independent sources agreeing with each other.

TIMEFRAME & THREAD COHERENCE (HARD):
- A single company section may draw on articles from DIFFERENT trading days and with OPPOSING sentiment. When it does, attribute each price move or claim to its specific day ("rose Thursday as money rotated into financials; fell ~5% Friday in the broad selloff") instead of fusing them into one cause-and-effect sentence. A name being up one day and down the next is NOT a contradiction — name the days so the reader sees two sessions, not one muddled one.
- Keep a structural / longer-horizon thread (e.g. an IPO-underwriting fee catalyst, a pending deal, a product cycle) SEPARATE from a same-day tactical move (e.g. today's selloff). Put them in separate sentences and do not imply one caused the other unless a source explicitly says so.
- Do not invent a sector or market driver a source did not state. If a held name fell but no source attributes the move to its sector, say it fell with the broad market — do not assert an unsourced reason (e.g. "as the selloff hit brokers/banks") that no article supports.

ATTRIBUTION & PROVENANCE (HARD):
- A source's summary sometimes RELAYS a third party's views rather than voicing the source's own opinion — a podcast guest, an interview subject, or a quoted analyst (the summary will say so, e.g. "TMT Breakout summarizes Gavin Baker's podcast remarks"). When it does, attribute the view to the ORIGINATOR, not the newsletter: write "Gavin Baker (via TMT Breakout) argued ..." — never "TMT Breakout argued ..." as if it were the newsletter's own call.
- Do not strip a named originator out of a relayed view. And do not invent an originator when the summary names none — a summary with no relay attribution IS the source's own view.

Output markdown only. No preamble, no sign-off.`;
}

/**
 * Mirrors the Mac-side validation in `lib/ai/strip-preamble.ts`. Worker is bundled
 * separately and can't import from the Mac codebase — duplication is intentional.
 */
function stripModelPreamble(text: string): string {
  const lines = text.split("\n");
  let firstReal = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    if (/^(#|\||[-*+]\s|>\s|---|```)/.test(trimmed)) {
      firstReal = i;
      break;
    }
  }
  return lines.slice(firstReal).join("\n").trim();
}

const SYNTHESIS_MIN_CHARS = 200;

async function synthesizeViaAI(
  env: FallbackEnv,
  articles: RecentArticleMeta[],
  snap: Snapshot,
): Promise<string | null> {
  const buckets = bucketByCompany(articles);
  const prompt = buildSynthesisPrompt(buckets, snap);
  const catalog = snap.modelCatalog ?? [];
  try {
    const result = await generateWithFailover(env, "fallbackEvening", catalog, (model) =>
      generateText({
        model,
        // 8192 mirrors lib/digest/synthesize.ts — the structured section
        // contract regularly exceeds 4096 output tokens on heavy days, and the
        // truncation guard would otherwise degrade the cloud email every time.
        maxOutputTokens: 8192,
        prompt,
      }),
    );

    // Mirror Mac's strict validation in lib/digest/synthesize.ts:
    //   1. Truncation guard, 2. preamble strip, 3. header check, 4. min length.
    // On any failure return null so the caller falls back to per-source layout.
    if (result.finishReason === "length") {
      console.warn("[fallback-evening] synthesis truncated by max tokens");
      return null;
    }

    const stripped = stripModelPreamble(result.text ?? "");
    const firstNonEmpty = stripped.split("\n").find((line) => line.trim().length > 0);
    if (!firstNonEmpty || !firstNonEmpty.trim().startsWith("#")) {
      console.warn("[fallback-evening] synthesis has no markdown header");
      return null;
    }

    if (stripped.length < SYNTHESIS_MIN_CHARS) {
      console.warn(
        `[fallback-evening] synthesis too short (${stripped.length} chars)`,
      );
      return null;
    }

    return enforceHeldSections(stripped, buckets, snap.heldSymbols ?? []);
  } catch (err) {
    console.warn("[fallback-evening] synthesis failed:", err);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultSince(): string {
  return new Date(Date.now() - 86_400_000).toISOString();
}

function formatDateForTitle(now: Date = new Date()): string {
  return now.toLocaleDateString("en-US", {
    timeZone: "America/New_York", // Worker runs in UTC — render the ET market day
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function filterSinceArticles(
  articles: RecentArticleMeta[],
  since: string,
): RecentArticleMeta[] {
  // Normalize `since` to a comparable prefix (YYYY-MM-DD HH:MM:SS)
  // received_at is stored as "YYYY-MM-DD HH:MM:SS"; since may be ISO-Z.
  // Both normalize to a comparable form via Date comparison.
  let sinceMs: number;
  try {
    sinceMs = new Date(since).getTime();
  } catch {
    sinceMs = Date.now() - 86_400_000;
  }
  return articles.filter((a) => {
    const artMs = new Date(a.received_at.replace(" ", "T") + "Z").getTime();
    return artMs >= sinceMs;
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runFallbackEvening(
  env: FallbackEnv,
  opts: { dryRun?: boolean } = {},
): Promise<FallbackResult & { htmlLength?: number; reason?: string }> {
  // ── Pre-flight checks ────────────────────────────────────────────────────
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_DOMAIN) {
    return { kind: "error", error: "RESEND_API_KEY / RESEND_FROM_DOMAIN missing" };
  }

  // ── Load snapshot ────────────────────────────────────────────────────────
  let snap: Snapshot | null;
  try {
    snap = await loadLatestSnapshot(env.ARCHIVE);
  } catch (err) {
    return {
      kind: "error",
      error: `snapshot load failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!snap) {
    return { kind: "error", error: "snapshot missing" };
  }

  // ── Recipient resolution ─────────────────────────────────────────────────
  const rawRecipients = snap.settings.evening_email_recipients;
  let recipient: string;
  if (rawRecipients && rawRecipients.trim().length > 0) {
    // Normalize comma-separated: trim each, rejoin with ", "
    recipient = rawRecipients
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0)
      .join(", ");
  } else if (env.BRIEFING_EMAIL_TO) {
    recipient = env.BRIEFING_EMAIL_TO;
  } else {
    return { kind: "error", error: "recipient missing: no evening_email_recipients in snapshot and BRIEFING_EMAIL_TO is unset" };
  }

  // ── Since timestamp ──────────────────────────────────────────────────────
  const sinceSnapshot = snap.settings.last_digest_sent_at ?? defaultSince();

  // ── Articles: live-fetched (today) + snapshot (frozen at 2am) ────────────
  // The snapshot froze at 2am, so the bulk of an evening recap — newsletters
  // that landed during the day — is invisible to a snapshot-only reader. Live
  // fetch today's mail (same path as the digest) and put it on top.
  const fetchResult = await fetchAndProcessNewArticles(env, snap, {
    maxArticles: MAX_ARTICLES_PER_RUN_EVENING,
  });
  const freshMeta = fetchResult.processed.map(processedToMeta);

  const snapshotInWindow = filterSinceArticles(
    snap.recentArticlesMeta as RecentArticleMeta[],
    sinceSnapshot,
  );

  // fetchAndProcessNewArticles already dedups against snapshot gmail_message_ids,
  // so fresh + snapshot are disjoint; fresh on top (most recent).
  const articlesInWindow = [...freshMeta, ...snapshotInWindow];

  // Observability: a "no content" skip is otherwise a black box. Record what the
  // worker actually saw so a future "evening didn't send" is diagnosable.
  console.log(
    `[fallback-evening] snapshot v${snap.schemaVersion} (${snap.snapshotDate}, gen ${snap.generatedAt}); ` +
      `since=${sinceSnapshot}; recentMeta=${snap.recentArticlesMeta.length}; ` +
      `fresh=${freshMeta.length}; snapshotInWindow=${snapshotInWindow.length}; ` +
      `listErrors=${fetchResult.listErrors}; articleErrors=${fetchResult.articleErrors}`,
  );

  // ── Anomaly block (schemaVersion 3 only) ─────────────────────────────────
  let anomalyBlock = "";
  if (
    snap.schemaVersion >= 3 &&
    snap.vanguardHoldings &&
    snap.vanguardHoldings.length > 0 &&
    snap.securityBetas &&
    snap.securityBetas.length > 0
  ) {
    try {
      const flags = await computeAnomaliesFromSnapshot(
        snap.vanguardHoldings,
        snap.securityBetas,
      );
      if (flags && flags.length > 0) {
        anomalyBlock = formatAnomalyBlock(flags);
      }
    } catch (err) {
      console.warn("[fallback-evening] anomaly computation failed:", err);
      // gracefully omit — don't fail the whole email
    }
  }

  // ── Body: synthesis or per-source ────────────────────────────────────────
  let body = "";
  if (articlesInWindow.length >= 5) {
    const synthesized = await synthesizeViaAI(env, articlesInWindow, snap);
    body = synthesized ?? renderPerSource(articlesInWindow);
  } else {
    body = renderPerSource(articlesInWindow);
  }

  // ── Assemble full markdown ────────────────────────────────────────────────
  const sections = [anomalyBlock, body].filter((s) => s && s.trim().length > 0);
  const fullMd = sections.join("\n\n---\n\n").trim();

  if (!fullMd) {
    // No content. Distinguish a genuinely quiet evening from an upstream
    // wipeout (Gmail outage, subrequest cap, billing hold) — the same
    // silent-swallow guard the digest carries, so a failed fetch doesn't read
    // as "nothing happened today". (Sibling-fallback rule, CLAUDE.md 5/31.)
    if (fetchResult.listErrors > 0 || fetchResult.articleErrors > 0) {
      return {
        kind: "error",
        error: `evening produced no content: listErrors=${fetchResult.listErrors}, articleErrors=${fetchResult.articleErrors}, lastError=${fetchResult.lastError ?? "unknown"}`,
      } as FallbackResult & { reason?: string };
    }
    return { kind: "skipped", reason: "no content" } as FallbackResult & { reason: string };
  }

  // ── HTML + subject ────────────────────────────────────────────────────────
  const now = new Date();
  const title = `Evening Recap — ${formatDateForTitle(now)}`;
  const footer = `(fallback delivery, state snapshot ${snap.snapshotDate}) — Mac was offline.`;
  const html = briefingToHtml(fullMd, title, footer);

  if (opts.dryRun) {
    return { kind: "success", htmlLength: html.length };
  }

  let send: Awaited<ReturnType<typeof sendEmail>>;
  try {
    send = await sendEmail(env, {
      to: recipient,
      subject: `📊 ${title}`,
      html,
      fromLocalPart: "evening",
    });
  } catch (err) {
    return {
      kind: "error",
      error: `resend send failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { kind: "success", sentMessageId: send.id };
}

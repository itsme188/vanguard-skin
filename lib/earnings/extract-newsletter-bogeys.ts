/**
 * Auto-extract earnings bogeys (EPS/revenue consensus + whisper numbers)
 * for upcoming reporters from newsletter text.
 *
 * Sibling of lib/alerts/extract-newsletter-levels.ts (price levels) and
 * lib/earnings/extract-bogeys.ts (multi-symbol PDF bogeys) — same
 * mark-scanned discipline as the former, same ExtractedBogey field
 * vocabulary + issuer-family fan-out as the latter.
 *
 * Pipeline: getUnscannedArticles → per-article symbol pre-filter (only
 * call Claude when the article's text actually mentions one of the
 * upcoming held/watchlist reporters) → Claude call → extractJsonArray +
 * parseLargeUSD parsing → upsertBogey (source='newsletter') → mark
 * scanned.
 */

import type Database from "better-sqlite3";
import { generateTextForFeature } from "@/lib/ai/generate";
import { resolveFeatureModel } from "@/lib/ai/models";
import { upsertBogey } from "@/lib/mutations/earnings-bogeys";
import { extractJsonArray } from "@/lib/ai/extract-json";
import { coercePercent, parseLargeUSD } from "@/lib/format";
import { coveredForEvents } from "@/lib/queries/briefing-symbols";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// Max chars per article sent to Claude. Bogey mentions are almost always in
// prose context near the top of a preview newsletter, not buried deep in a
// long weekly — matches the newsletterLevelExtraction precedent.
const MAX_ARTICLE_CHARS = 30_000;

// Max articles to process per extraction run (safety cap on cost + runtime).
const DEFAULT_BATCH_SIZE = 10;

// Claude concurrency cap.
const CONCURRENCY = 3;

// Upcoming-reporter window: [today, today+14d].
const WINDOW_DAYS_AHEAD = 14;

export interface ArticleInput {
  id: number;
  source_name: string;
  subject: string;
  received_at: string;
  raw_text: string;
}

export interface UpcomingReporter {
  symbol: string;
  event_id: number;
  event_date: string;
}

export interface ExtractedBogey {
  symbol: string;
  eps_consensus: number | null;
  eps_whisper: number | null;
  revenue_consensus: number | null;
  revenue_whisper: number | null;
  expected_move_pct: number | null;
  /** Forward-looking company/author guidance prose — never a bogey number. */
  guidance_notes: string | null;
  notes: string | null;
}

/**
 * Build the Claude extraction prompt. Pure function — unit-testable.
 * Only the reporters passed in (already filtered to symbols mentioned in
 * this specific article) are listed, so the model can't wander onto an
 * unrelated ticker.
 */
export function buildExtractionPrompt(
  article: ArticleInput,
  reporters: UpcomingReporter[]
): string {
  const reportersList = reporters
    .map((r) => `${r.symbol} (reports ${r.event_date})`)
    .join("\n");

  const truncatedText =
    article.raw_text.length > MAX_ARTICLE_CHARS
      ? article.raw_text.slice(0, MAX_ARTICLE_CHARS) + "\n[truncated]"
      : article.raw_text;

  return [
    `Extract earnings bogeys (consensus + whisper numbers) this newsletter author gives for the following UPCOMING reporters ONLY. Ignore every other ticker mentioned.`,
    ``,
    `UPCOMING REPORTERS (only extract for these):`,
    reportersList || "(none)",
    ``,
    `NEWSLETTER:`,
    `Source: ${article.source_name}`,
    `Subject: ${article.subject}`,
    `Received: ${article.received_at}`,
    ``,
    `CONTENT:`,
    truncatedText,
    ``,
    `INSTRUCTIONS:`,
    `Return a JSON array (and nothing else — no markdown fence, no preamble). Each element captures the bogeys the author gives for ONE of the listed upcoming reporters.`,
    ``,
    `Schema per element:`,
    `{`,
    `  "symbol": string,                    // must match one of the listed reporters (or a same-issuer share class)`,
    `  "eps_consensus": number | null,`,
    `  "eps_whisper": number | null,         // above/below-consensus number traders are positioning for`,
    `  "revenue_consensus": number | null,   // RAW dollars, not abbreviated (e.g. 40200000000, not "$40.2B")`,
    `  "revenue_whisper": number | null,     // RAW dollars`,
    `  "expected_move_pct": number | null,   // expected/implied earnings move the author states, as an absolute percent ("±6%" -> 6)`,
    `  "guidance_notes": string | null,      // forward-looking guidance/metrics as SHORT text: company guides, next-quarter guide bogeys, ARR/cRPO/margin bogeys. Never a bogey number field. <300 chars`,
    `  "notes": string | null                // brief paraphrase of the author's reasoning, <200 chars`,
    `}`,
    ``,
    `KNOWN FORMATS:`,
    `Some authors (e.g. TMT Breakout's "Buyside Bogeys") post a compact per-ticker block:`,
    ``,
    `  CRWD — 4:10p / 5:00p`,
    `  FQ2 NN ARR: ~$305M+ vs. guide of $285M`,
    `  FQ3 ARR: slightly ahead vs. Street @ $6.122B (NN ARR $331M)`,
    `  FY'27 Rev Guide: 23% vs street at 21-22%`,
    `  NVDA — 4:15p / 5:00p`,
    `  FQ2 Revenue: ~$95B vs. guide of $91B and Street @ $92.4B`,
    `  FQ3 Revenue Guide: $108.5B+ vs. Street @ $105B`,
    ``,
    `Read that shape as follows:`,
    `- The LEADING figure on a line is the buyside/whisper number — "FQ2 Revenue: ~$95B" means revenue_whisper = 95000000000.`,
    `- "Street @" / "street at" / "consensus" is the SELL-SIDE consensus — "Street @ $92.4B" means revenue_consensus = 92400000000.`,
    `- "guide of" / "prior guide" / "the guide" is COMPANY guidance, never a bogey number. Summarize it in guidance_notes.`,
    `- ONLY the CURRENT-quarter Revenue and EPS lines map to revenue_*/eps_*. The current quarter is the one that is about to be reported.`,
    `- NEXT-quarter guide lines ("FQ3 Revenue Guide", "FY'27 Rev Guide") and non-GAAP metric lines (ARR, NN ARR, cRPO, RPO, GM, gross/operating margin) go into guidance_notes as short text — they are forward-looking, not this quarter's print. Other commentary goes in notes.`,
    `- A header like "4:15p / 5:00p" is the print time / call time. Ignore it — it is not a number to extract.`,
    `- A block like this usually carries SEVERAL numbers per ticker. Capture every one of them: the whisper, the consensus, and each guide/metric line in guidance_notes.`,
    ``,
    `RULES:`,
    `- Only extract for the listed upcoming reporters.`,
    `- Use null (not 0) for any field the author doesn't give a number for.`,
    `- Numbers are RAW dollars: convert "$40.2B" to 40200000000.`,
    `- If the article gives no forward-looking numbers for any listed reporter, return [].`,
    `- Return ONLY the JSON array. No other text.`,
  ].join("\n");
}

/**
 * Parse Claude's response into validated bogey objects. Tolerant of
 * conversational preamble/trailer via extractJsonArray, and of stringified
 * abbreviated numbers ("$40.2B") via parseLargeUSD. Returns [] on any parse
 * failure — a garbled response is treated as "no bogeys found", not a
 * retry-worthy failure (only the AI call itself gates the scanned marker).
 */
export function parseExtractionResponse(raw: string): ExtractedBogey[] {
  const jsonText = extractJsonArray(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedBogey[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const symbol = typeof obj.symbol === "string" ? obj.symbol.trim().toUpperCase() : "";
    if (!symbol) continue;

    out.push({
      symbol,
      eps_consensus: coerceNumber(obj.eps_consensus),
      eps_whisper: coerceNumber(obj.eps_whisper),
      revenue_consensus: coerceNumber(obj.revenue_consensus),
      revenue_whisper: coerceNumber(obj.revenue_whisper),
      expected_move_pct: coercePercent(obj.expected_move_pct),
      guidance_notes: normalizeStringField(obj.guidance_notes),
      notes: normalizeStringField(obj.notes),
    });
  }
  return out;
}

/**
 * Trim + collapse a blank/whitespace-only string to null. Feeds
 * upsertBogey's preserveExisting has-content check downstream — a model
 * response of `notes: ""` must read as "no content", not as a value that
 * advances provenance while COALESCE-preserving the OLD notes forever
 * (2026-08-28 fix; upsertBogey normalizes defensively too).
 */
function normalizeStringField(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed.slice(0, 500);
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" || typeof v === "string" || v == null) {
    return parseLargeUSD(v as string | number | null | undefined);
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Tickers that are also ordinary English words — a bare `\bSYMBOL\b` test on
// these matches ordinary prose constantly, regardless of how short (or long)
// the symbol is. Gating on LENGTH instead of this stoplist is wrong: it
// silently gates real 3-char tickers too (TSM, AMD, GS, ...), leaving the
// feature permanently silent for major holdings whose newsletter mentions
// never carry a $cashtag or a finance-cue word. Curated to real collisions
// only — every one of these is also an actual NYSE/Nasdaq ticker.
export const AMBIGUOUS_TICKER_WORDS = new Set([
  "A", "AIR", "ALL", "AM", "AN", "ANY", "ARE", "AT", "BE", "BIG", "BY",
  "CAN", "CAR", "COST", "DAY", "DO", "EAT", "FOR", "GO", "GOOD", "HAS",
  "HE", "IT", "KEY", "LOVE", "LOW", "MAIN", "MAN", "MET", "NEXT", "NICE",
  "NOW", "ON", "ONE", "OR", "OUT", "PLAY", "PRO", "REAL", "RUN", "SEE",
  "SO", "TAP", "TELL", "TWO", "UP", "WELL", "WIN", "YOU",
]);

// Finance-context cues that, immediately following an ambiguous-word symbol,
// make the mention unambiguous even without a cashtag ("IT earnings", "IT
// reports").
const AMBIGUOUS_TICKER_CONTEXT_CUES = "EARNINGS|REPORTS?|PRINTS?|EPS|Q[1-4]";

/**
 * Pure symbol-mention test. Guards against common-English-word tickers (IT,
 * ALL, ON, NOW, SO, KEY, ...) via an explicit stoplist (`AMBIGUOUS_TICKER_WORDS`),
 * NOT symbol length: length-gating every symbol <= 3 chars silently blocked
 * real 3-char tickers (TSM, AMD, GS, IBM, CAT, ...) from ever matching in
 * ordinary prose ("TSM beat on both lines"), leaving the feature permanently
 * silent for exactly the major holdings it exists for.
 *
 * For a symbol IN the stoplist, require either a `$SYMBOL` cashtag or the
 * symbol immediately followed by a finance-context cue (earnings/reports/
 * prints/EPS/Qn). Every other symbol — regardless of length — uses a plain
 * case-sensitive-in-uppercase-text word-boundary test.
 */
export function isSymbolMentioned(text: string, symbol: string): boolean {
  const upperSymbol = symbol.toUpperCase();
  const escaped = escapeRegExp(upperSymbol);
  const upperText = text.toUpperCase();

  if (!AMBIGUOUS_TICKER_WORDS.has(upperSymbol)) {
    return new RegExp(`\\b${escaped}\\b`).test(upperText);
  }

  const cashtagRe = new RegExp(`\\$${escaped}\\b`);
  const contextRe = new RegExp(
    `\\b${escaped}(?=\\s*(?:${AMBIGUOUS_TICKER_CONTEXT_CUES})\\b)`
  );
  return cashtagRe.test(upperText) || contextRe.test(upperText);
}

/**
 * Fetch upcoming earnings reporters in [today, today+14d] scoped to
 * covered events only (coveredForEvents: held/watchlist family OR the
 * event itself is armed — spec §4.1). Excludes superseded calendar_events
 * rows.
 */
function getUpcomingReporters(
  db: Database.Database,
  opts: { today?: string } = {},
): UpcomingReporter[] {
  const today = opts.today ?? todayET();
  const endDate = addDays(today, WINDOW_DAYS_AHEAD);

  const rows = db
    .prepare(
      `SELECT id AS event_id, symbol, event_date
       FROM calendar_events
       WHERE event_type = 'earnings'
         AND symbol IS NOT NULL
         AND event_date >= ? AND event_date <= ?
         AND COALESCE(superseded, 0) = 0`
    )
    .all(today, endDate) as { event_id: number; symbol: string; event_date: string }[];

  if (rows.length === 0) return [];

  const covered = coveredForEvents(db, rows.map((r) => ({ symbol: r.symbol, eventId: r.event_id })));

  return rows
    .filter((r) => covered.has(r.event_id))
    .map((r) => ({
      symbol: r.symbol.toUpperCase(),
      event_id: r.event_id,
      event_date: r.event_date,
    }));
}

/** Test seam — the function stays private to the module's callers. */
export const __getUpcomingReportersForTests = getUpcomingReporters;

/**
 * Per-article symbol pre-filter: only the reporters actually mentioned in
 * this article's text (issuer-family aware, so a GOOGL mention matches a
 * GOOG reporter row) get passed to the prompt. An article that mentions
 * none of the tracked reporters skips the AI call entirely.
 */
function filterReportersMentionedInArticle(
  article: ArticleInput,
  reporters: UpcomingReporter[]
): UpcomingReporter[] {
  return reporters.filter((r) =>
    issuerSiblings(r.symbol).some((sym) => isSymbolMentioned(article.raw_text, sym))
  );
}

function getUnscannedArticles(
  db: Database.Database,
  opts: { sinceDays?: number; batchSize?: number }
): ArticleInput[] {
  const sinceDays = opts.sinceDays ?? 30;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  return db
    .prepare(
      `SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text
       FROM research_articles a
       JOIN research_sources rs ON rs.id = a.source_id
       WHERE a.bogeys_scanned_at IS NULL
         AND a.received_at >= datetime('now', '-${sinceDays} days')
         AND a.raw_text IS NOT NULL AND length(a.raw_text) > 200
       ORDER BY a.received_at DESC
       LIMIT ?`
    )
    .all(batchSize) as ArticleInput[];
}

function markArticleScanned(db: Database.Database, articleId: number): void {
  db.prepare(
    "UPDATE research_articles SET bogeys_scanned_at = datetime('now') WHERE id = ?"
  ).run(articleId);
}

/**
 * Run bogey extraction on a single article against the full set of
 * upcoming reporters. Marks the article scanned regardless of whether any
 * bogeys were found or matched — only a genuine AI-call failure skips the
 * marker (retries next run).
 */
export async function extractBogeysFromArticle(
  db: Database.Database,
  article: ArticleInput,
  reporters: UpcomingReporter[]
): Promise<{ bogeysStored: number; eventsMatched: number }> {
  const mentioned = filterReportersMentionedInArticle(article, reporters);

  if (mentioned.length === 0) {
    markArticleScanned(db, article.id);
    return { bogeysStored: 0, eventsMatched: 0 };
  }

  let responseText: string;
  try {
    const { text } = await generateTextForFeature("newsletterBogeyExtraction", {
      maxOutputTokens: 2048,
      prompt: buildExtractionPrompt(article, mentioned),
    });
    responseText = text;
  } catch (err) {
    console.warn(
      `[earnings/extract-newsletter-bogeys] Claude failed for article ${article.id}:`,
      err instanceof Error ? err.message : err
    );
    // Don't mark scanned — transient failures should retry on next run.
    return { bogeysStored: 0, eventsMatched: 0 };
  }

  if (!responseText.trim()) {
    markArticleScanned(db, article.id);
    return { bogeysStored: 0, eventsMatched: 0 };
  }

  const extracted = parseExtractionResponse(responseText);
  const bySymbol = new Map(mentioned.map((r) => [r.symbol, r]));
  // Mirrors app/api/earnings/bogeys/upload/route.ts:149 — never record
  // FEATURE_MODELS[key] directly (it's a tier token); resolve the concrete
  // model id actually resolved for this feature.
  const { modelId } = resolveFeatureModel("newsletterBogeyExtraction");

  let bogeysStored = 0;
  let eventsMatched = 0;

  for (const bogey of extracted) {
    // Issuer-family fan-out: the model may echo back a sibling share class
    // (GOOGL) for a reporter row keyed on GOOG.
    let matched: UpcomingReporter | undefined;
    for (const sym of issuerSiblings(bogey.symbol)) {
      const candidate = bySymbol.get(sym.toUpperCase());
      if (candidate) {
        matched = candidate;
        break;
      }
    }
    if (!matched) continue;

    upsertBogey(db, {
      event_id: matched.event_id,
      source: "newsletter",
      source_label: article.source_name,
      research_article_id: article.id,
      eps_consensus: bogey.eps_consensus,
      eps_whisper: bogey.eps_whisper,
      revenue_consensus_usd: bogey.revenue_consensus,
      revenue_whisper_usd: bogey.revenue_whisper,
      expected_move_pct: bogey.expected_move_pct,
      guidance_notes: bogey.guidance_notes,
      notes: bogey.notes,
      ai_extraction_model: modelId,
      // Newsletter rows key on (event, 'newsletter', source_name), so a LATER
      // issue of the same newsletter conflicts with the earlier one. Live
      // 2026-08-26: an issue that mentioned NVDA/CRWD without numbers erased
      // the earlier issue's extracted consensus. Never let a re-scan's null
      // overwrite a stored number.
      preserveExisting: true,
    });
    bogeysStored++;
    eventsMatched++;
  }

  markArticleScanned(db, article.id);
  return { bogeysStored, eventsMatched };
}

/**
 * Scan recent unscanned research articles and auto-extract earnings bogeys
 * for any upcoming held/watchlist reporter the author gives numbers for.
 * Called from Task A2's wiring into the research sync pipeline.
 */
export async function extractBogeysFromNewArticles(
  db: Database.Database,
  opts: { sinceDays?: number; batchSize?: number } = {}
): Promise<{
  articlesScanned: number;
  bogeysStored: number;
  eventsMatched: number;
}> {
  const reporters = getUpcomingReporters(db);
  if (reporters.length === 0) {
    return { articlesScanned: 0, bogeysStored: 0, eventsMatched: 0 };
  }

  const articles = getUnscannedArticles(db, opts);
  if (articles.length === 0) {
    return { articlesScanned: 0, bogeysStored: 0, eventsMatched: 0 };
  }

  let bogeysStored = 0;
  let eventsMatched = 0;

  // Process with concurrency cap.
  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const batch = articles.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((a) => extractBogeysFromArticle(db, a, reporters))
    );
    for (const r of results) {
      bogeysStored += r.bogeysStored;
      eventsMatched += r.eventsMatched;
    }
  }

  return {
    articlesScanned: articles.length,
    bogeysStored,
    eventsMatched,
  };
}

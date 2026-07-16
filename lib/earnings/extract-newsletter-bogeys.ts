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
import { parseLargeUSD } from "@/lib/format";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
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
    `  "notes": string | null                // brief paraphrase of the author's reasoning, <200 chars`,
    `}`,
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
      notes: typeof obj.notes === "string" ? obj.notes.slice(0, 500) : null,
    });
  }
  return out;
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

// Symbols this short collide with common English words often enough that a
// bare \bSYMBOL\b test false-positives constantly (IT, ALL, ON, NOW, SO,
// KEY, ...). Above this length, collisions with real English words are rare
// enough that the plain boundary test is fine on its own.
const SHORT_SYMBOL_MAX_LEN = 3;

// Finance-context cues that, immediately following a short symbol, make the
// mention unambiguous even without a cashtag ("IT earnings", "IT reports").
const SHORT_SYMBOL_CONTEXT_CUES = "EARNINGS|REPORTS?|PRINTS?|EPS|Q[1-4]";

/**
 * Pure symbol-mention test. Guards against common-English-word tickers
 * (IT, ALL, ON, NOW, SO, KEY, ...) at length <= 3: a bare `\bSYMBOL\b` test
 * on such a symbol matches ordinary prose constantly. For those short
 * symbols, require either a `$SYMBOL` cashtag or the symbol immediately
 * followed by a finance-context cue (earnings/reports/prints/EPS/Qn).
 * Symbols of length >= 4 use the plain word-boundary test — collisions with
 * real English words are rare at that length.
 */
export function isSymbolMentioned(text: string, symbol: string): boolean {
  const escaped = escapeRegExp(symbol.toUpperCase());
  const upperText = text.toUpperCase();

  if (symbol.length > SHORT_SYMBOL_MAX_LEN) {
    return new RegExp(`\\b${escaped}\\b`).test(upperText);
  }

  const cashtagRe = new RegExp(`\\$${escaped}\\b`);
  const contextRe = new RegExp(`\\b${escaped}(?=\\s*(?:${SHORT_SYMBOL_CONTEXT_CUES})\\b)`);
  return cashtagRe.test(upperText) || contextRe.test(upperText);
}

/**
 * Fetch upcoming earnings reporters in [today, today+14d] scoped to
 * held/watchlist symbols only (getSymbolStatus, issuer-family aware).
 * Excludes superseded calendar_events rows.
 */
function getUpcomingReporters(db: Database.Database): UpcomingReporter[] {
  const today = todayET();
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

  const symbols = Array.from(new Set(rows.map((r) => r.symbol.toUpperCase())));
  const statuses = getSymbolStatus(db, symbols);

  return rows
    .filter((r) => {
      const status = statuses[r.symbol.toUpperCase()];
      return status === "held" || status === "watchlist";
    })
    .map((r) => ({
      symbol: r.symbol.toUpperCase(),
      event_id: r.event_id,
      event_date: r.event_date,
    }));
}

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
      notes: bogey.notes,
      ai_extraction_model: modelId,
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

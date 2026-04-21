import type Database from "better-sqlite3";
import { generateText } from "ai";
import { getModelForFeature } from "@/lib/ai/provider";
import { upsertLevel } from "@/lib/mutations/security-levels";
import type {
  LevelType,
  LevelDirection,
  LevelTimeframe,
  LevelActionHint,
} from "@/lib/types";

// Max chars per article sent to Claude. Long newsletters get truncated —
// level mentions are almost always in prose context, not buried in tables.
const MAX_ARTICLE_CHARS = 25_000;

// Max articles to process per extraction run (safety cap on cost + runtime).
const DEFAULT_BATCH_SIZE = 10;

// Claude concurrency cap. Sonnet rate limits are generous but being a good citizen.
const CONCURRENCY = 3;

export interface ArticleInput {
  id: number;
  source_name: string;
  subject: string;
  received_at: string;
  raw_text: string;
}

export interface RelevantSymbol {
  symbol: string;
  security_id: number;
  current_price: number | null;
  relationship: "held" | "watchlist";
}

/**
 * Build the Claude extraction prompt. Pure function — unit-testable.
 * Asks Sonnet to return strict JSON. We filter to user's held + watchlist
 * symbols to avoid the model producing noise about tickers the user doesn't
 * track.
 */
export function buildExtractionPrompt(
  article: ArticleInput,
  relevantSymbols: RelevantSymbol[]
): string {
  const symbolsList = relevantSymbols
    .map(
      (s) =>
        `${s.symbol}${s.current_price ? ` (current $${s.current_price.toFixed(2)})` : ""} [${s.relationship}]`
    )
    .join("\n");

  const truncatedText = article.raw_text.length > MAX_ARTICLE_CHARS
    ? article.raw_text.slice(0, MAX_ARTICLE_CHARS) + "\n[truncated]"
    : article.raw_text;

  return [
    `Extract any specific price levels this newsletter author names for the following symbols ONLY. Ignore every other ticker mentioned.`,
    ``,
    `USER'S TRACKED SYMBOLS (only extract levels for these):`,
    symbolsList || "(none — the user tracks no relevant symbols)",
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
    `Return a JSON array (and nothing else — no markdown fence, no preamble). Each element is one price level the author specifically named for one of the tracked symbols. Levels must be actionable: a specific dollar price with direction/intent.`,
    ``,
    `Schema per element:`,
    `{`,
    `  "symbol": string,              // must match a tracked symbol exactly`,
    `  "level_type": "support" | "resistance" | "entry" | "exit" | "stop" | "scale_in",`,
    `  "price": number,`,
    `  "direction": "bullish" | "bearish" | null,   // what a hit on this level implies`,
    `  "action_hint": "new_position" | "scale_in" | "trim" | "close" | "watch" | null,`,
    `  "thesis": string,              // paraphrase the author's reasoning, <120 chars`,
    `  "timeframe": "day" | "week" | "month" | null,`,
    `  "confidence": "high" | "medium" | "low"   // how specific + unambiguous the author was`,
    `}`,
    ``,
    `RULES:`,
    `- Only extract levels for the tracked symbols listed above.`,
    `- If the author gives a range (e.g. "580-585"), pick the more specific endpoint and note in thesis.`,
    `- Past performance references ("held 580 in March") are NOT levels — skip them unless the author says they're still watching that level.`,
    `- Vague commentary ("I'd be interested below") without a specific price is NOT a level — skip.`,
    `- If there are no valid levels, return [].`,
    `- Return ONLY the JSON array. No other text.`,
  ].join("\n");
}

interface ExtractedLevel {
  symbol: string;
  level_type: LevelType;
  price: number;
  direction: LevelDirection | null;
  action_hint: LevelActionHint | null;
  thesis: string;
  timeframe: LevelTimeframe | null;
  confidence: "high" | "medium" | "low";
}

/**
 * Parse Claude's response into validated level objects. Tolerant of minor
 * formatting slop (e.g. markdown code fences) — returns [] on any parse failure.
 */
export function parseExtractionResponse(raw: string): ExtractedLevel[] {
  // Strip possible markdown fence
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const valid: ExtractedLevel[] = [];
  const levelTypes: LevelType[] = ["support", "resistance", "entry", "exit", "stop", "scale_in"];

  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.symbol !== "string" || !obj.symbol) continue;
    if (typeof obj.level_type !== "string" || !levelTypes.includes(obj.level_type as LevelType)) continue;
    if (typeof obj.price !== "number" || !isFinite(obj.price) || obj.price <= 0) continue;
    if (typeof obj.confidence !== "string") continue;
    if (!["high", "medium", "low"].includes(obj.confidence)) continue;

    valid.push({
      symbol: obj.symbol,
      level_type: obj.level_type as LevelType,
      price: obj.price,
      direction: obj.direction === "bullish" || obj.direction === "bearish" ? obj.direction : null,
      action_hint: typeof obj.action_hint === "string"
        ? (["new_position", "scale_in", "trim", "close", "watch"].includes(obj.action_hint)
          ? (obj.action_hint as LevelActionHint)
          : null)
        : null,
      thesis: typeof obj.thesis === "string" ? obj.thesis.slice(0, 500) : "",
      timeframe: typeof obj.timeframe === "string" && ["day", "week", "month"].includes(obj.timeframe)
        ? (obj.timeframe as LevelTimeframe)
        : null,
      confidence: obj.confidence as "high" | "medium" | "low",
    });
  }

  return valid;
}

/**
 * Fetch symbols the user holds OR watchlists, with current prices.
 * These are the only symbols we extract levels for — everything else is noise.
 */
export function getRelevantSymbols(db: Database.Database): RelevantSymbol[] {
  return db
    .prepare(
      `SELECT DISTINCT s.id AS security_id, s.symbol,
              p.close_price AS current_price,
              CASE WHEN h.security_id IS NOT NULL THEN 'held' ELSE 'watchlist' END AS relationship
       FROM securities s
       LEFT JOIN (
         SELECT DISTINCT security_id FROM holdings WHERE quantity > 0
       ) h ON h.security_id = s.id
       LEFT JOIN (
         SELECT security_id FROM watchlist WHERE is_active = 1
       ) w ON w.security_id = s.id
       LEFT JOIN (
         SELECT security_id, close_price
         FROM prices p1
         WHERE date = (SELECT MAX(date) FROM prices p2 WHERE p2.security_id = p1.security_id)
       ) p ON p.security_id = s.id
       WHERE h.security_id IS NOT NULL OR w.security_id IS NOT NULL`
    )
    .all() as RelevantSymbol[];
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
       WHERE a.levels_extracted_at IS NULL
         AND a.received_at >= datetime('now', '-${sinceDays} days')
         AND a.raw_text IS NOT NULL AND length(a.raw_text) > 200
       ORDER BY a.received_at DESC
       LIMIT ?`
    )
    .all(batchSize) as ArticleInput[];
}

function markArticleScanned(db: Database.Database, articleId: number): void {
  db.prepare(
    "UPDATE research_articles SET levels_extracted_at = datetime('now') WHERE id = ?"
  ).run(articleId);
}

/**
 * Run extraction on a single article. Marks the article scanned regardless of
 * whether levels were found. Only confidence >= medium gets inserted (low-confidence
 * extractions are more likely false positives than useful signal).
 */
export async function extractLevelsFromArticle(
  db: Database.Database,
  article: ArticleInput,
  relevantSymbols: RelevantSymbol[]
): Promise<{ inserted: number; skipped: number }> {
  const bySymbol = new Map(relevantSymbols.map((s) => [s.symbol.toUpperCase(), s]));

  let responseText: string;
  try {
    const { text } = await generateText({
      model: getModelForFeature("newsletterLevelExtraction"),
      maxOutputTokens: 2048,
      prompt: buildExtractionPrompt(article, relevantSymbols),
    });
    responseText = text;
  } catch (err) {
    console.warn(`[levels/extract] Claude failed for article ${article.id}:`, err instanceof Error ? err.message : err);
    // Don't mark scanned — transient failures should retry on next run
    return { inserted: 0, skipped: 0 };
  }

  if (!responseText.trim()) {
    markArticleScanned(db, article.id);
    return { inserted: 0, skipped: 0 };
  }

  const extracted = parseExtractionResponse(responseText);
  let inserted = 0;
  let skipped = 0;

  for (const lvl of extracted) {
    if (lvl.confidence === "low") {
      skipped++;
      continue;
    }
    const sym = bySymbol.get(lvl.symbol.toUpperCase());
    if (!sym) {
      // Claude returned a symbol not in our tracked list — discard
      skipped++;
      continue;
    }
    upsertLevel(db, {
      security_id: sym.security_id,
      level_type: lvl.level_type,
      price: lvl.price,
      direction: lvl.direction,
      action_hint: lvl.action_hint,
      source: "newsletter",
      source_article_id: article.id,
      source_author: article.source_name,
      thesis: lvl.thesis,
      timeframe: lvl.timeframe,
      // Newsletter-extracted levels stage in pending_review. The user approves
      // or rejects on /dashboard/levels/review before the scan arms them.
      review_status: "pending_review",
    });
    inserted++;
  }

  markArticleScanned(db, article.id);
  return { inserted, skipped };
}

/**
 * Scan recent unextracted research articles and auto-propose levels for any
 * the author specifically calls out for the user's held / watchlist names.
 * Called from the research sync route and manually from /api/levels/extract.
 */
export async function extractLevelsFromNewArticles(
  db: Database.Database,
  opts: { sinceDays?: number; batchSize?: number } = {}
): Promise<{
  articlesScanned: number;
  levelsInserted: number;
  levelsSkipped: number;
}> {
  const relevantSymbols = getRelevantSymbols(db);
  if (relevantSymbols.length === 0) {
    return { articlesScanned: 0, levelsInserted: 0, levelsSkipped: 0 };
  }

  const articles = getUnscannedArticles(db, opts);
  if (articles.length === 0) {
    return { articlesScanned: 0, levelsInserted: 0, levelsSkipped: 0 };
  }

  let levelsInserted = 0;
  let levelsSkipped = 0;

  // Process with concurrency cap
  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const batch = articles.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((a) => extractLevelsFromArticle(db, a, relevantSymbols))
    );
    for (const r of results) {
      levelsInserted += r.inserted;
      levelsSkipped += r.skipped;
    }
  }

  return {
    articlesScanned: articles.length,
    levelsInserted,
    levelsSkipped,
  };
}

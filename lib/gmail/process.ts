import type Database from "better-sqlite3";
import { jsonSchema } from "ai";
import { generateObjectForFeature } from "@/lib/ai/generate";
import { resolveFeatureModel } from "@/lib/ai/models";
import { verifyMentions } from "@/lib/research/verify-mentions";
import { truncateForPrompt } from "./prompt-caps";
import { sanitizeModelSummary, sanitizeThemeList } from "@/lib/gmail/theme-sanitize";
import { subjectSymbolBackstop } from "@/lib/gmail/subject-symbol-backstop";
import { getHeldStockSymbols } from "@/lib/queries/briefing-symbols";
import { getActiveWatchlistStockSymbols } from "@/lib/queries/watchlist";

interface UnprocessedArticle {
  id: number;
  source_id: number;
  subject: string;
  sender: string;
  raw_text: string;
  source_name: string;
  processing_prompt: string | null;
  allow_off_topic: number;
}

interface ProcessedResult {
  summary: string;
  key_themes: string[];
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  sentiment_score: number;
  mentioned_symbols: string[];
  portfolio_relevance: string;
  is_portfolio_relevant: boolean;
}

/**
 * Process unprocessed research articles with Claude Sonnet.
 * Extracts: summary, key themes, sentiment, mentioned tickers, portfolio relevance.
 * Links mentioned symbols to existing securities in the portfolio.
 */
export async function processUnprocessedArticles(
  db: Database.Database
): Promise<{ processed: number; failed: number }> {
  const articles = db
    .prepare(
      `SELECT a.id, a.source_id, a.subject, a.sender, a.raw_text,
              s.name as source_name, s.processing_prompt,
              COALESCE(s.allow_off_topic, 0) as allow_off_topic
       FROM research_articles a
       JOIN research_sources s ON a.source_id = s.id
       WHERE a.processed_at IS NULL
         AND COALESCE(a.is_relevant, 1) = 1
       ORDER BY a.received_at DESC
       LIMIT 20`
    )
    .all() as UnprocessedArticle[];

  if (articles.length === 0) return { processed: 0, failed: 0 };

  // Get current holdings for portfolio context
  const holdings = db
    .prepare(
      `SELECT DISTINCT s.symbol, s.name
       FROM holdings h
       JOIN securities s ON h.security_id = s.id
       WHERE h.quantity > 0
         AND h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id)
       ORDER BY s.symbol`
    )
    .all() as { symbol: string; name: string | null }[];

  const holdingsContext = holdings
    .map((h) => `${h.symbol}${h.name ? ` (${h.name})` : ""}`)
    .join(", ");

  // Held + watchlist symbol universe for the deterministic subject-line
  // backstop (subjectSymbolBackstop) — same held/watchlist shape as
  // lib/calendar/sync.ts's scan-set union. Computed once for the whole
  // batch since it doesn't vary per article.
  const knownSymbols = new Set(
    [...getHeldStockSymbols(db), ...getActiveWatchlistStockSymbols(db)].map((s) =>
      s.toUpperCase()
    )
  );

  const updateArticle = db.prepare(`
    UPDATE research_articles
    SET summary = ?, key_themes = ?, sentiment = ?, sentiment_score = ?,
        mentioned_symbols = ?, portfolio_relevance = ?, ai_model = ?,
        processed_at = datetime('now')
    WHERE id = ?
  `);

  // D3: when Claude votes the article off-topic AND the source isn't opted
  // out of the gate, flip is_relevant=0 + tag the excluded fields so the
  // D5 audit UI can surface and un-filter it. The AI fields above still get
  // written — unfiltering then shows fully-extracted content in the digest
  // without re-processing cost. Source-level `allow_off_topic` is the
  // escape hatch for general-purpose newsletters (Helene Meisler chart
  // commentary, macro-only sources) where the vote would always be false.
  const markOffTopic = db.prepare(`
    UPDATE research_articles
    SET is_relevant = 0,
        excluded_category = 'off_topic',
        excluded_reason = ?
    WHERE id = ?
  `);

  const linkSecurity = db.prepare(`
    INSERT OR IGNORE INTO research_article_securities (article_id, security_id, mention_context, sentiment)
    VALUES (?, ?, ?, ?)
  `);

  const findSecurity = db.prepare(
    `SELECT id FROM securities WHERE symbol = ? LIMIT 1`
  );

  let processed = 0;
  let failed = 0;

  for (const article of articles) {
    try {
      const result = await extractWithClaude(article, holdingsContext);

      // Two-layer mention gate before linking: word-boundary drops substring
      // matches ("HOOD" in "likelihood"), Haiku drops homonyms ("Robin Hood"
      // the outlaw, "NET" as "net income"). See lib/research/verify-mentions.
      const verified = await verifyMentions(
        result.mentioned_symbols,
        article.subject,
        article.raw_text,
      );

      // Deterministic subject-line backstop, union'd in AFTER verifyMentions
      // rather than before: bypasses the AI verification gate entirely
      // (Haiku would happily drop a bare "U" as too ambiguous — exactly the
      // failure mode this backstop exists to catch). See
      // lib/gmail/subject-symbol-backstop.ts for the full story.
      const alreadyVerified = new Set(verified.map((v) => v.symbol));
      const backstopHits = subjectSymbolBackstop(article.subject, knownSymbols).filter(
        (s) => !alreadyVerified.has(s)
      );
      const verifiedSymbols = [...verified.map((v) => v.symbol), ...backstopHits];

      updateArticle.run(
        result.summary,
        JSON.stringify(result.key_themes),
        result.sentiment,
        result.sentiment_score,
        JSON.stringify(verifiedSymbols),
        result.portfolio_relevance,
        resolveFeatureModel("newsletterProcessing").modelId,
        article.id
      );

      if (!result.is_portfolio_relevant && article.allow_off_topic !== 1) {
        const reason =
          result.portfolio_relevance && result.portfolio_relevance.trim().length > 0
            ? result.portfolio_relevance.slice(0, 280)
            : "Claude judged article off-topic";
        markOffTopic.run(reason, article.id);
      }

      for (const { symbol, context } of verified) {
        const sec = findSecurity.get(symbol) as { id: number } | undefined;
        if (sec) {
          linkSecurity.run(article.id, sec.id, context, result.sentiment);
        }
      }
      for (const symbol of backstopHits) {
        const sec = findSecurity.get(symbol) as { id: number } | undefined;
        if (sec) {
          linkSecurity.run(
            article.id,
            sec.id,
            `Subject-line backstop match: "${article.subject.slice(0, 300)}"`,
            result.sentiment
          );
        }
      }

      processed++;
    } catch (err) {
      console.error(
        `[research] Failed to process article ${article.id} ("${article.subject}"):`,
        err instanceof Error ? err.message : err
      );
      failed++;
    }
  }

  return { processed, failed };
}

// ── Claude extraction ───────────────────────────────────────────────

export const ANALYSIS_SCHEMA = jsonSchema<ProcessedResult>({
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "2-3 sentence summary of the article's key points and conclusions.",
    },
    key_themes: {
      type: "array",
      items: { type: "string" },
      description: 'Key themes/topics (e.g., ["fed policy", "tech earnings", "inflation"]) — max 5.',
    },
    sentiment: {
      type: "string",
      enum: ["bullish", "bearish", "neutral", "mixed"],
      description: "Overall market sentiment of the article.",
    },
    sentiment_score: {
      type: "number",
      description: "Sentiment score from -1.0 (very bearish) to 1.0 (very bullish).",
    },
    mentioned_symbols: {
      type: "array",
      items: { type: "string" },
      description: "Stock ticker symbols mentioned (e.g., AAPL, MSFT). Only include actual traded tickers, not generic terms.",
    },
    portfolio_relevance: {
      type: "string",
      description:
        "One sentence on how this article is relevant to the current portfolio holdings, written in second person addressed to the portfolio owner ('relevant to your NVDA position') — never third-person voice.",
    },
    is_portfolio_relevant: {
      type: "boolean",
      description:
        "TRUE when the article touches any held or watchlist ticker OR meaningfully shifts macro/sector context that already affects the portfolio (Fed policy, rates, broad indices, a sector held in the portfolio). FALSE only for clearly off-topic content (single-stock pieces about names not held in the portfolio and that don't read through to held names, crypto/coin-only commentary, lifestyle/non-finance). Default to TRUE when uncertain — prefer to under-filter.",
    },
  },
  required: [
    "summary",
    "key_themes",
    "sentiment",
    "sentiment_score",
    "mentioned_symbols",
    "portfolio_relevance",
    "is_portfolio_relevant",
  ],
});

// sanitizeModelSummary / sanitizeThemeList moved to lib/gmail/theme-sanitize.ts
// (2026-07-23) — that module has zero imports (no better-sqlite3 / AI SDK),
// so it's safe for a "use client" component (Research Feeds' ThemePills) to
// import directly. Re-exported here so every existing server-side importer
// (extractWithClaude below, digest render sites, repair scripts, tests)
// keeps working unchanged.
export { sanitizeModelSummary, sanitizeThemeList };

async function extractWithClaude(
  article: UnprocessedArticle,
  holdingsContext: string
): Promise<ProcessedResult> {
  // Cap very long articles for the prompt. 150k chars (was 15k — long
  // weeklies' summaries only reflected the opening ~15% for months; see
  // lib/gmail/prompt-caps.ts). Worker mirror: workers/cron/src/
  // newsletter-fetch.ts::truncateBodyForPrompt (parity-pinned).
  const text = truncateForPrompt(article.raw_text);

  const { object: _rawObject } = await generateObjectForFeature("newsletterProcessing", {
    maxOutputTokens: 2048,
    schema: ANALYSIS_SCHEMA,
    prompt: `Analyze this financial newsletter article and extract structured data.

Source: ${article.source_name}
Subject: ${article.subject}
From: ${article.sender}

Current portfolio holdings: ${holdingsContext || "(none loaded)"}
${article.processing_prompt ? `\nSource-specific instructions: ${article.processing_prompt}\n` : ""}
Article text:
${text}

ATTRIBUTION (provenance): If this piece is primarily RELAYING a third party's views — a podcast guest, interview subject, or quoted analyst (e.g. the newsletter summarizing someone else's remarks) — the summary MUST name that originator and make the relaying explicit ("TMT Breakout summarizes Gavin Baker's podcast remarks: ..."), and never flatten their view into the newsletter's own first-person voice. When the views are the newsletter author's own, no attribution phrase is needed.

VOICE: the summary and portfolio_relevance fields are read directly by the portfolio owner in their morning email. Address them in second person ("your CSX position", "your semis exposure") or neutral prose; NEVER refer to "the user", "the client", or "the portfolio manager" in third person.`,
  });

  // Normalize. is_portfolio_relevant defaults to true on a missing/null
  // response — under-filter when uncertain, matches the prompt direction.
  // Array fields are type-guarded because jsonSchema() does NOT runtime-
  // validate — the model can return them as comma-joined STRINGS, which
  // survive `.slice()` and corrupt storage (crashed the Worker digest
  // fallback for 1.5h on 2026-07-15; same model, same schema shape).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const object = _rawObject as any as ProcessedResult;
  const themes = sanitizeThemeList(object.key_themes);
  const symbols = Array.isArray(object.mentioned_symbols)
    ? object.mentioned_symbols.filter((s): s is string => typeof s === "string")
    : [];
  return {
    summary: sanitizeModelSummary(object.summary || ""),
    key_themes: themes,
    sentiment: object.sentiment || "neutral",
    sentiment_score: Math.max(-1, Math.min(1, object.sentiment_score || 0)),
    mentioned_symbols: symbols.map((s) => s.toUpperCase().trim()),
    portfolio_relevance: object.portfolio_relevance || "",
    is_portfolio_relevant: object.is_portfolio_relevant !== false,
  };
}


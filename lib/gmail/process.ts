import type Database from "better-sqlite3";
import { generateObject, jsonSchema } from "ai";
import { FEATURE_MODELS } from "@/lib/ai/models";
import { getModelForFeature } from "@/lib/ai/provider";
import { verifyMentions } from "@/lib/research/verify-mentions";

interface UnprocessedArticle {
  id: number;
  source_id: number;
  subject: string;
  sender: string;
  raw_text: string;
  source_name: string;
  processing_prompt: string | null;
}

interface ProcessedResult {
  summary: string;
  key_themes: string[];
  sentiment: "bullish" | "bearish" | "neutral" | "mixed";
  sentiment_score: number;
  mentioned_symbols: string[];
  portfolio_relevance: string;
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
              s.name as source_name, s.processing_prompt
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

  const updateArticle = db.prepare(`
    UPDATE research_articles
    SET summary = ?, key_themes = ?, sentiment = ?, sentiment_score = ?,
        mentioned_symbols = ?, portfolio_relevance = ?, ai_model = ?,
        processed_at = datetime('now')
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
      const verifiedSymbols = verified.map((v) => v.symbol);

      updateArticle.run(
        result.summary,
        JSON.stringify(result.key_themes),
        result.sentiment,
        result.sentiment_score,
        JSON.stringify(verifiedSymbols),
        result.portfolio_relevance,
        FEATURE_MODELS.newsletterProcessing,
        article.id
      );

      for (const { symbol, context } of verified) {
        const sec = findSecurity.get(symbol) as { id: number } | undefined;
        if (sec) {
          linkSecurity.run(article.id, sec.id, context, result.sentiment);
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

const ANALYSIS_SCHEMA = jsonSchema<ProcessedResult>({
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
      description: "One sentence on how this article is relevant to the user's current portfolio holdings.",
    },
  },
  required: [
    "summary",
    "key_themes",
    "sentiment",
    "sentiment_score",
    "mentioned_symbols",
    "portfolio_relevance",
  ],
});

async function extractWithClaude(
  article: UnprocessedArticle,
  holdingsContext: string
): Promise<ProcessedResult> {
  // Truncate very long articles for the prompt
  const text =
    article.raw_text.length > 15_000
      ? article.raw_text.slice(0, 15_000) + "\n...[truncated]"
      : article.raw_text;

  const { object } = await generateObject({
    model: getModelForFeature("newsletterProcessing"),
    maxOutputTokens: 2048,
    schema: ANALYSIS_SCHEMA,
    prompt: `Analyze this financial newsletter article and extract structured data.

Source: ${article.source_name}
Subject: ${article.subject}
From: ${article.sender}

Current portfolio holdings: ${holdingsContext || "(none loaded)"}
${article.processing_prompt ? `\nSource-specific instructions: ${article.processing_prompt}\n` : ""}
Article text:
${text}`,
  });

  // Normalize
  return {
    summary: object.summary || "",
    key_themes: (object.key_themes || []).slice(0, 5),
    sentiment: object.sentiment || "neutral",
    sentiment_score: Math.max(-1, Math.min(1, object.sentiment_score || 0)),
    mentioned_symbols: (object.mentioned_symbols || []).map((s) =>
      s.toUpperCase().trim()
    ),
    portfolio_relevance: object.portfolio_relevance || "",
  };
}


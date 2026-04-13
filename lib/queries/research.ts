import type Database from "better-sqlite3";

export interface ResearchArticle {
  id: number;
  source_id: number;
  source_name: string;
  gmail_message_id: string;
  received_at: string;
  subject: string;
  sender: string;
  summary: string | null;
  key_themes: string | null;
  sentiment: string | null;
  sentiment_score: number | null;
  mentioned_symbols: string | null;
  portfolio_relevance: string | null;
  processed_at: string | null;
  created_at: string;
  source_url: string | null;
  website_url: string | null;
}

export interface ResearchSource {
  id: number;
  name: string;
  sender_email: string | null;
  sender_pattern: string | null;
  subject_pattern: string | null;
  is_active: number;
  fetch_frequency: string;
  max_age_days: number;
  processing_prompt: string | null;
  website_url: string | null;
  created_at: string;
  article_count?: number;
}

export interface ResearchMention {
  article_id: number;
  source_name: string;
  subject: string;
  received_at: string;
  summary: string | null;
  sentiment: string | null;
  mention_context: string | null;
  mention_sentiment: string | null;
}

export function getRecentArticles(
  db: Database.Database,
  options?: {
    sourceId?: number;
    securityId?: number;
    startDate?: string;
    endDate?: string;
    search?: string;
    processedOnly?: boolean;
    limit?: number;
  }
): ResearchArticle[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options?.sourceId) {
    conditions.push("a.source_id = ?");
    params.push(options.sourceId);
  }
  if (options?.securityId) {
    conditions.push(
      "a.id IN (SELECT article_id FROM research_article_securities WHERE security_id = ?)"
    );
    params.push(options.securityId);
  }
  if (options?.startDate) {
    conditions.push("a.received_at >= ?");
    params.push(options.startDate);
  }
  if (options?.endDate) {
    conditions.push("a.received_at <= ?");
    params.push(options.endDate + " 23:59:59");
  }
  if (options?.search) {
    conditions.push("(a.subject LIKE ? OR a.summary LIKE ? OR a.raw_text LIKE ? OR a.mentioned_symbols LIKE ?)");
    const term = `%${options.search}%`;
    params.push(term, term, term, term);
  }
  if (options?.processedOnly) {
    conditions.push("a.processed_at IS NOT NULL");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options?.limit || 50;

  return db
    .prepare(
      `SELECT a.id, a.source_id, s.name as source_name, a.gmail_message_id,
              a.received_at, a.subject, a.sender, a.summary, a.key_themes,
              a.sentiment, a.sentiment_score, a.mentioned_symbols,
              a.portfolio_relevance, a.processed_at, a.created_at,
              a.source_url, s.website_url
       FROM research_articles a
       JOIN research_sources s ON a.source_id = s.id
       ${where}
       ORDER BY a.received_at DESC
       LIMIT ?`
    )
    .all(...params, limit) as ResearchArticle[];
}

/**
 * Build a symbol→securityId map for all securities mentioned in the given articles.
 * One query for the whole batch — avoids N+1 per-article lookups.
 */
export function getSymbolSecurityMap(
  db: Database.Database,
  articleIds: number[]
): Record<string, number> {
  if (articleIds.length === 0) return {};
  const placeholders = articleIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT s.symbol, s.id
       FROM research_article_securities ras
       JOIN securities s ON ras.security_id = s.id
       WHERE ras.article_id IN (${placeholders})`
    )
    .all(...articleIds) as { symbol: string; id: number }[];

  const map: Record<string, number> = {};
  for (const r of rows) {
    map[r.symbol] = r.id;
  }
  return map;
}

export function getArticlesForSecurity(
  db: Database.Database,
  securityId: number,
  limit = 10
): ResearchMention[] {
  return db
    .prepare(
      `SELECT ras.article_id, s.name as source_name, a.subject, a.received_at,
              a.summary, a.sentiment, ras.mention_context, ras.sentiment as mention_sentiment
       FROM research_article_securities ras
       JOIN research_articles a ON ras.article_id = a.id
       JOIN research_sources s ON a.source_id = s.id
       WHERE ras.security_id = ? AND a.processed_at IS NOT NULL
       ORDER BY a.received_at DESC
       LIMIT ?`
    )
    .all(securityId, limit) as ResearchMention[];
}

export function getResearchSources(
  db: Database.Database
): ResearchSource[] {
  return db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM research_articles WHERE source_id = s.id) as article_count
       FROM research_sources s
       ORDER BY s.name`
    )
    .all() as ResearchSource[];
}

export function getArticleById(
  db: Database.Database,
  id: number
): (ResearchArticle & { raw_text: string }) | undefined {
  return db
    .prepare(
      `SELECT a.*, s.name as source_name
       FROM research_articles a
       JOIN research_sources s ON a.source_id = s.id
       WHERE a.id = ?`
    )
    .get(id) as (ResearchArticle & { raw_text: string }) | undefined;
}

export function getRecentArticleSummaries(
  db: Database.Database,
  hours = 24,
  limit = 5
): ResearchArticle[] {
  return db
    .prepare(
      `SELECT a.id, a.source_id, s.name as source_name, a.gmail_message_id,
              a.received_at, a.subject, a.sender, a.summary, a.key_themes,
              a.sentiment, a.sentiment_score, a.mentioned_symbols,
              a.portfolio_relevance, a.processed_at, a.created_at,
              a.source_url, s.website_url
       FROM research_articles a
       JOIN research_sources s ON a.source_id = s.id
       WHERE a.processed_at IS NOT NULL
         AND a.received_at >= datetime('now', '-' || ? || ' hours')
       ORDER BY a.received_at DESC
       LIMIT ?`
    )
    .all(hours, limit) as ResearchArticle[];
}

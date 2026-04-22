import type Database from "better-sqlite3";

export type ResearchDocumentType =
  | "analyst_report"
  | "research_note"
  | "market_analysis"
  | "industry_primer"
  | "other";

export type ResearchDocumentSentiment =
  | "bullish"
  | "bearish"
  | "neutral"
  | "mixed";

export interface ResearchDocument {
  id: number;
  title: string;
  author: string | null;
  source: string | null;
  filename: string;
  file_size_bytes: number | null;
  publication_date: string | null;
  document_type: ResearchDocumentType | null;
  raw_text: string;
  summary: string | null;
  key_points: string | null; // JSON array string
  mentioned_symbols: string | null; // JSON array string
  sentiment: ResearchDocumentSentiment | null;
  target_prices: string | null; // JSON string
  ai_model: string | null;
  char_count: number | null;
  uploaded_at: string;
  processed_at: string;
}

export interface ResearchDocumentSummary {
  id: number;
  title: string;
  author: string | null;
  source: string | null;
  filename: string;
  publication_date: string | null;
  document_type: ResearchDocumentType | null;
  summary: string | null;
  mentioned_symbols: string | null;
  sentiment: ResearchDocumentSentiment | null;
  uploaded_at: string;
  char_count: number | null;
}

export interface ResearchDocumentSearchResult extends ResearchDocumentSummary {
  snippet: string | null; // FTS5 snippet highlighting match context
  key_points: string | null;
}

// ─── Single-document lookup ───────────────────────────────────────

export function getResearchDocument(
  db: Database.Database,
  id: number,
): ResearchDocument | null {
  const row = db
    .prepare(`SELECT * FROM research_documents WHERE id = ?`)
    .get(id) as ResearchDocument | undefined;
  return row ?? null;
}

// ─── List recent documents (no FTS) ───────────────────────────────

export interface ListResearchDocumentsOptions {
  document_type?: ResearchDocumentType;
  limit?: number;
  symbol?: string;
}

export function listResearchDocuments(
  db: Database.Database,
  opts: ListResearchDocumentsOptions = {},
): ResearchDocumentSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.document_type) {
    where.push("document_type = ?");
    params.push(opts.document_type);
  }
  if (opts.symbol) {
    // Match upper-cased symbol inside the JSON array.
    where.push("mentioned_symbols LIKE ?");
    params.push(`%"${opts.symbol.toUpperCase()}"%`);
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  return db
    .prepare(
      `SELECT id, title, author, source, filename, publication_date,
              document_type, summary, mentioned_symbols, sentiment,
              uploaded_at, char_count
       FROM research_documents
       ${whereSql}
       ORDER BY COALESCE(publication_date, uploaded_at) DESC
       LIMIT ?`,
    )
    .all(...params, limit) as ResearchDocumentSummary[];
}

// ─── Full-text search ─────────────────────────────────────────────

export interface SearchResearchDocumentsOptions {
  query?: string;
  symbol?: string;
  document_type?: ResearchDocumentType;
  days_back?: number;
  limit?: number;
}

/**
 * Search across title/author/source/summary/raw_text via FTS5. When `query` is
 * empty we fall back to `listResearchDocuments` filter semantics so the tool
 * can be called with just a symbol + days_back.
 *
 * FTS5 safety: the raw user query is escaped as an FTS5 phrase — we avoid
 * exposing FTS5's own syntax (NEAR, OR, column:, etc.) to reduce surprise.
 * Callers wanting raw FTS5 expressions can pass `rawMatch` (internal only).
 */
export function searchResearchDocuments(
  db: Database.Database,
  opts: SearchResearchDocumentsOptions,
): ResearchDocumentSearchResult[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const hasQuery = !!(opts.query && opts.query.trim());

  if (!hasQuery) {
    // No text query — fall through to regular listing + filters.
    return listResearchDocuments(db, {
      document_type: opts.document_type,
      symbol: opts.symbol,
      limit,
    }).map((d) => ({ ...d, snippet: null, key_points: null }));
  }

  const ftsQuery = `"${opts.query!.trim().replace(/"/g, '""')}"`;

  const where: string[] = ["fts.research_documents_fts MATCH ?"];
  const params: unknown[] = [ftsQuery];

  if (opts.document_type) {
    where.push("rd.document_type = ?");
    params.push(opts.document_type);
  }
  if (opts.symbol) {
    where.push("rd.mentioned_symbols LIKE ?");
    params.push(`%"${opts.symbol.toUpperCase()}"%`);
  }
  if (opts.days_back && opts.days_back > 0) {
    where.push(
      "COALESCE(rd.publication_date, rd.uploaded_at) >= date('now', ?)",
    );
    params.push(`-${Math.floor(opts.days_back)} days`);
  }

  return db
    .prepare(
      `SELECT rd.id, rd.title, rd.author, rd.source, rd.filename,
              rd.publication_date, rd.document_type, rd.summary,
              rd.mentioned_symbols, rd.sentiment, rd.uploaded_at, rd.char_count,
              rd.key_points,
              snippet(research_documents_fts, -1, '<mark>', '</mark>', '…', 20) AS snippet
       FROM research_documents rd
       JOIN research_documents_fts fts ON fts.rowid = rd.id
       WHERE ${where.join(" AND ")}
       ORDER BY fts.rank
       LIMIT ?`,
    )
    .all(...params, limit) as ResearchDocumentSearchResult[];
}

// ─── Aggregate counts ─────────────────────────────────────────────

export function getResearchDocumentCount(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM research_documents`)
    .get() as { n: number };
  return row.n;
}

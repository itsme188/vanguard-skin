import type Database from "better-sqlite3";
import type { EarningsTranscript } from "@/lib/types";
import { escapeLikeTerm } from "./like-escape";

// ─── Shared source-preference ranking ────────────────────────────
//
// "The transcript for a quarter" is defined once, here, and shared by every
// query that picks a single row per (ticker, year, quarter): the freshest,
// most structured source wins (api_ninjas > alpha_vantage > motley_fool),
// and an edgar_8k row (an SEC 8-K cover page, fetched only as a fallback)
// loses to any of them. Inlining this CASE separately per query is how the
// list view drifted from the single-transcript lookups
// (qa:research-transcripts-list--8k-cover-pages-labelled-transcript-duplicate-quarter-cards).
const SOURCE_RANK_SQL = `CASE source
             WHEN 'api_ninjas' THEN 1
             WHEN 'alpha_vantage' THEN 2
             WHEN 'motley_fool' THEN 3
             WHEN 'edgar_8k' THEN 4
           END`;

// ─── Result Types ───────────────────────────────────────────────

export interface TranscriptSummaryEntry {
  id: number;
  ticker: string;
  security_name: string | null;
  year: number;
  quarter: number;
  call_date: string | null;
  source: string;
  summary: string | null;
  guidance: string | null;
  risk_factors: string | null;
  sentiment_label: string | null;
  sentiment_score: number | null;
  has_full_transcript: boolean;
  fetched_at: string;
}

// ─── Query Functions ────────────────────────────────────────────

/**
 * Get a cached transcript by ticker, year, and quarter.
 * Returns the best available source (api_ninjas > alpha_vantage > motley_fool > edgar_8k).
 */
export function getCachedTranscript(
  db: Database.Database,
  ticker: string,
  year: number,
  quarter: number
): EarningsTranscript | null {
  return (
    (db
      .prepare(
        `SELECT * FROM earnings_transcripts
         WHERE UPPER(ticker) = UPPER(?)
           AND year = ? AND quarter = ?
         ORDER BY ${SOURCE_RANK_SQL}
         LIMIT 1`
      )
      .get(ticker.toUpperCase(), year, quarter) as EarningsTranscript) ?? null
  );
}

/**
 * Get the most recent cached transcript for a ticker.
 */
export function getLatestCachedTranscript(
  db: Database.Database,
  ticker: string
): EarningsTranscript | null {
  return (
    (db
      .prepare(
        `SELECT * FROM earnings_transcripts
         WHERE UPPER(ticker) = UPPER(?)
         ORDER BY year DESC, quarter DESC, ${SOURCE_RANK_SQL}
         LIMIT 1`
      )
      .get(ticker.toUpperCase()) as EarningsTranscript) ?? null
  );
}

/**
 * Get all cached transcripts for a security, ordered by date.
 */
export function getTranscriptsForSecurity(
  db: Database.Database,
  securityId: number
): EarningsTranscript[] {
  return db
    .prepare(
      `SELECT * FROM earnings_transcripts
       WHERE security_id = ?
       ORDER BY year DESC, quarter DESC`
    )
    .all(securityId) as EarningsTranscript[];
}

/**
 * Get transcript summaries for the Notes tab earnings timeline.
 * Joins with securities table for display names.
 *
 * `search` is a free-text filter — the Earnings-tab counterpart to
 * `getNotesFiltered`'s `search` (qa:research-notes-earnings--search-box-ignored-regression-3,
 * part 2). The transcript wall is most of that tab's content, so without
 * this the "Search notes..." box only ever trimmed the notes timeline,
 * never the transcript cards stacked below it.
 *
 * UNIFIED SEMANTICS: one box drives both halves of that tab, so both halves
 * must answer the same question — does this row match on IDENTITY (ticker /
 * company name) or on TEXT (the transcript's summary + guidance, the note's
 * prose)? Matching transcripts on identity alone while notes matched on
 * prose alone made one term filter the two halves by different rules:
 * "NFLX" kept the NFLX transcripts but dropped NFLX notes that never spell
 * the ticker, and "guidance" emptied a transcript wall in which every card
 * discusses guidance. Substring LIKE, case-folded on both sides.
 */
export function getTranscriptsSummary(
  db: Database.Database,
  options?: {
    securityId?: number;
    ticker?: string;
    search?: string;
    limit?: number;
  }
): TranscriptSummaryEntry[] {
  // Dedupe to one row per (ticker, year, quarter) BEFORE filtering/limiting —
  // the same best-source preference `getCachedTranscript` and
  // `getLatestCachedTranscript` already use, so the card wall never shows
  // two cards (or the worse one first) for one quarter
  // (qa:research-transcripts-list--8k-cover-pages-labelled-transcript-duplicate-quarter-cards).
  // `et.id DESC` breaks ties deterministically when the same source is
  // re-fetched under a new source_key.
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.securityId) {
    conditions.push("security_id = ?");
    params.push(options.securityId);
  }
  if (options?.ticker) {
    conditions.push("UPPER(ticker) = UPPER(?)");
    params.push(options.ticker);
  }
  const search = options?.search?.trim();
  if (search) {
    // UPPER() on both sides rather than relying on SQLite's ASCII-only
    // default LIKE folding — the same shape getNotesFiltered uses, so the
    // two halves of the Earnings tab can't drift on case handling.
    conditions.push(
      `(UPPER(ticker) LIKE '%' || UPPER(?) || '%' ESCAPE '\\'
        OR UPPER(COALESCE(security_name, '')) LIKE '%' || UPPER(?) || '%' ESCAPE '\\'
        OR UPPER(COALESCE(summary, '')) LIKE '%' || UPPER(?) || '%' ESCAPE '\\'
        OR UPPER(COALESCE(guidance, '')) LIKE '%' || UPPER(?) || '%' ESCAPE '\\')`
    );
    const escaped = escapeLikeTerm(search);
    params.push(escaped, escaped, escaped, escaped);
  }

  const extraWhere = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const limit = options?.limit || 50;

  return db
    .prepare(
      `WITH ranked AS (
         SELECT
           et.id,
           et.ticker,
           et.security_id,
           s.name AS security_name,
           et.year,
           et.quarter,
           et.call_date,
           et.source,
           et.summary,
           et.guidance,
           et.risk_factors,
           et.sentiment_label,
           et.sentiment_score,
           CASE WHEN et.transcript IS NOT NULL AND LENGTH(et.transcript) > 100 THEN 1 ELSE 0 END AS has_full_transcript,
           et.fetched_at,
           ROW_NUMBER() OVER (
             PARTITION BY UPPER(et.ticker), et.year, et.quarter
             ORDER BY ${SOURCE_RANK_SQL}, et.id DESC
           ) AS rn
         FROM earnings_transcripts et
         LEFT JOIN securities s ON et.security_id = s.id
       )
       SELECT
         id, ticker, security_name, year, quarter, call_date, source,
         summary, guidance, risk_factors, sentiment_label, sentiment_score,
         has_full_transcript, fetched_at
       FROM ranked
       WHERE rn = 1
       ${extraWhere}
       ORDER BY year DESC, quarter DESC, UPPER(ticker)
       LIMIT ?`
    )
    .all(...params, limit) as TranscriptSummaryEntry[];
}

/**
 * Every ticker that has at least one cached transcript — deliberately
 * UNFILTERED, and deliberately separate from `getTranscriptsSummary`.
 *
 * The Earnings tab's "Fetch <TICKER> Transcript" buttons are the complement
 * of this set (portfolio tickers minus tickers we already have). Deriving
 * the has-transcript side from the search-filtered transcript wall made
 * already-cached tickers reappear as fetch candidates the moment a filter
 * was active — most clicks then no-op into cache, but an edgar_8k-only name
 * spends a real Alpha Vantage call per click. A filter must never change
 * what is cached.
 */
export function getTickersWithTranscripts(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT UPPER(ticker) AS ticker
       FROM earnings_transcripts
       WHERE ticker IS NOT NULL AND TRIM(ticker) != ''
       ORDER BY ticker`
    )
    .all() as { ticker: string }[];
  return rows.map((r) => r.ticker);
}

/**
 * List all cached ticker/quarter combinations.
 */
export function getCachedQuarters(
  db: Database.Database,
  ticker: string
): { year: number; quarter: number; source: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT year, quarter, source
       FROM earnings_transcripts
       WHERE UPPER(ticker) = UPPER(?)
       ORDER BY year DESC, quarter DESC`
    )
    .all(ticker.toUpperCase()) as { year: number; quarter: number; source: string }[];
}

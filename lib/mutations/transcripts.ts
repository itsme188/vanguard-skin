import type Database from "better-sqlite3";
import type { EarningsTranscript, TranscriptSource } from "@/lib/types";

export interface UpsertTranscriptParams {
  security_id?: number | null;
  ticker: string;
  year: number;
  quarter: number;
  call_date?: string | null;
  source: TranscriptSource;
  transcript?: string | null;
  summary?: string | null;
  guidance?: string | null;
  risk_factors?: string | null;
  sentiment_score?: number | null;
  sentiment_label?: string | null;
  participants?: string | null; // JSON string
  accession_number?: string | null;
  filing_url?: string | null;
  source_key: string;
}

/**
 * Insert or replace a cached transcript.
 * Uses source_key for dedup — re-fetching the same transcript is an update.
 */
export function upsertTranscript(
  db: Database.Database,
  params: UpsertTranscriptParams
): EarningsTranscript {
  const result = db
    .prepare(
      `INSERT INTO earnings_transcripts (
         security_id, ticker, year, quarter, call_date, source,
         transcript, summary, guidance, risk_factors,
         sentiment_score, sentiment_label, participants,
         accession_number, filing_url, source_key, fetched_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(source_key) DO UPDATE SET
         transcript = excluded.transcript,
         summary = excluded.summary,
         guidance = excluded.guidance,
         risk_factors = excluded.risk_factors,
         sentiment_score = excluded.sentiment_score,
         sentiment_label = excluded.sentiment_label,
         participants = excluded.participants,
         fetched_at = datetime('now')`
    )
    .run(
      params.security_id ?? null,
      params.ticker.toUpperCase(),
      params.year,
      params.quarter,
      params.call_date ?? null,
      params.source,
      params.transcript ?? null,
      params.summary ?? null,
      params.guidance ?? null,
      params.risk_factors ?? null,
      params.sentiment_score ?? null,
      params.sentiment_label ?? null,
      params.participants ?? null,
      params.accession_number ?? null,
      params.filing_url ?? null,
      params.source_key
    );

  return db
    .prepare("SELECT * FROM earnings_transcripts WHERE id = ?")
    .get(result.lastInsertRowid) as EarningsTranscript;
}

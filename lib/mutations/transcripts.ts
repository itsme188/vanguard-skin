import type Database from "better-sqlite3";
import type { EarningsTranscript, TranscriptSource } from "@/lib/types";

export interface StatedFiscalQuarter {
  quarter: 1 | 2 | 3 | 4;
  year: number | null;
}

const ORDINAL_QUARTERS: Record<string, 1 | 2 | 3 | 4> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
};

const OPENING_WORD_LIMIT = 350;

function normalizeYear(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (raw.length === 2) return n >= 70 ? 1900 + n : 2000 + n;
  return n;
}

export function statedFiscalQuarterFromTranscript(
  transcript: string | null | undefined,
): StatedFiscalQuarter | null {
  if (!transcript) return null;
  const opening = transcript.split(/\s+/).slice(0, OPENING_WORD_LIMIT).join(" ");

  const ordinal = opening.match(
    /\b(first|second|third|fourth)\s+quarter(?:\s+and\s+full\s+year)?(?:\s+fiscal(?:\s+year)?|\s+fiscal|\s+year)?(?:\s+(\d{2,4}))?\b/i,
  );
  if (ordinal) {
    return {
      quarter: ORDINAL_QUARTERS[ordinal[1].toLowerCase()],
      year: normalizeYear(ordinal[2]),
    };
  }

  const ordinalFiscal = opening.match(
    /\b(first|second|third|fourth)\s+quarter\s+fiscal(?:\s+year)?\s+(\d{2,4})\b/i,
  );
  if (ordinalFiscal) {
    return {
      quarter: ORDINAL_QUARTERS[ordinalFiscal[1].toLowerCase()],
      year: normalizeYear(ordinalFiscal[2]),
    };
  }

  const compact = opening.match(/\bQ([1-4])\s+(?:FY|fiscal(?:\s+year)?)\s*(\d{2,4})\b/i);
  if (compact) {
    return { quarter: Number(compact[1]) as 1 | 2 | 3 | 4, year: normalizeYear(compact[2]) };
  }

  const compactNoYear = opening.match(/\bQ([1-4])\b/i);
  if (compactNoYear) {
    return { quarter: Number(compactNoYear[1]) as 1 | 2 | 3 | 4, year: null };
  }

  return null;
}

export class TranscriptQuarterMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptQuarterMismatchError";
  }
}

export function transcriptQuarterMismatchReason(params: {
  ticker: string;
  year: number;
  quarter: number;
  source: TranscriptSource;
  transcript?: string | null;
}): string | null {
  const stated = statedFiscalQuarterFromTranscript(params.transcript);
  if (!stated) return null;
  if (stated.quarter !== params.quarter) {
    return `stated Q${stated.quarter}${stated.year ? ` ${stated.year}` : ""} but key is Q${params.quarter} ${params.year}`;
  }
  if (stated.year !== null && stated.year !== params.year) {
    return `stated Q${stated.quarter} ${stated.year} but key is Q${params.quarter} ${params.year}`;
  }
  return null;
}

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
  const mismatch = transcriptQuarterMismatchReason(params);
  if (mismatch) {
    const message = `[transcripts] rejected ${params.source} ${params.ticker.toUpperCase()} ${params.year}Q${params.quarter}: ${mismatch}`;
    console.warn(message);
    throw new TranscriptQuarterMismatchError(message);
  }

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
         call_date = COALESCE(excluded.call_date, earnings_transcripts.call_date),
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
    .prepare("SELECT * FROM earnings_transcripts WHERE source_key = ?")
    .get(params.source_key) as EarningsTranscript;
}

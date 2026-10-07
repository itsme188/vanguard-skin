/**
 * Read-only audit for transcript cache keys whose stored row contradicts the
 * fiscal quarter/year stated in the transcript opening. Deletes nothing.
 *
 * Usage:
 *   REPAIR_DB_PATH=/path/to/copy.db PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/audit-transcript-keys.ts
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { statedFiscalQuarterFromTranscript } from "../lib/mutations/transcripts";

export interface TranscriptKeyContradiction {
  id: number;
  ticker: string;
  key_year: number;
  key_quarter: number;
  stated_year: number | null;
  stated_quarter: number;
  source: string;
  fetched_at: string | null;
}

export interface TranscriptKeyAuditResult {
  contradictions: TranscriptKeyContradiction[];
  noStatementCount: number;
}

export function auditTranscriptKeys(db: Database.Database): TranscriptKeyAuditResult {
  const rows = db
    .prepare(
      `SELECT id, ticker, year, quarter, source, transcript, fetched_at
         FROM earnings_transcripts
        ORDER BY id`,
    )
    .all() as Array<{
    id: number;
    ticker: string;
    year: number;
    quarter: number;
    source: string;
    transcript: string | null;
    fetched_at: string | null;
  }>;

  const contradictions: TranscriptKeyContradiction[] = [];
  let noStatementCount = 0;
  for (const row of rows) {
    const stated = statedFiscalQuarterFromTranscript(row.transcript);
    if (!stated) {
      noStatementCount += 1;
      continue;
    }
    if (stated.quarter !== row.quarter || (stated.year !== null && stated.year !== row.year)) {
      contradictions.push({
        id: row.id,
        ticker: row.ticker,
        key_year: row.year,
        key_quarter: row.quarter,
        stated_year: stated.year,
        stated_quarter: stated.quarter,
        source: row.source,
        fetched_at: row.fetched_at,
      });
    }
  }
  return { contradictions, noStatementCount };
}

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");

function main() {
  const db = new BetterSqlite3(DB_PATH, { readonly: true }) as Database.Database;
  try {
    const result = auditTranscriptKeys(db);
    console.log(`Transcript key audit [READ ONLY] — db: ${DB_PATH}`);
    console.log(`Contradictions: ${result.contradictions.length}`);
    for (const row of result.contradictions) {
      console.log(
        `id=${row.id} ticker=${row.ticker} key=${row.key_year}Q${row.key_quarter} stated=${row.stated_year ?? "unknown"}Q${row.stated_quarter} source=${row.source} fetched_at=${row.fetched_at ?? "null"}`,
      );
    }
    console.log(`Rows with no stated quarter/year: ${result.noStatementCount}`);
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith("audit-transcript-keys.ts")) {
  main();
}

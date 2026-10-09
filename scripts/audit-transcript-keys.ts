/**
 * Read-only audit for transcript cache keys whose stored row contradicts the
 * fiscal quarter/year stated in the transcript opening. Deletes nothing.
 *
 * Filings stored by filing date are NOT contradictions (2026-10-08). An 8-K
 * press release fetched for a print is stored under the print's key on the
 * evidence of its filing date, even when the release labels the quarter
 * differently (`upsertTranscript`, rule 2 of the key rule). The table keeps
 * no marker for that decision, so the audit re-derives it: the row is a
 * filing, an earnings print of the issuer sits inside the filing window of
 * its filing date, and the row's key is that print's key (its Finnhub fiscal
 * quarter, or, with none on file, the calendar key of the print date). Such
 * rows are reported under their own heading. A filing that fails any part of
 * that test is still listed as a contradiction.
 *
 * Usage:
 *   REPAIR_DB_PATH=/path/to/copy.db PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/audit-transcript-keys.ts
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import {
  PRINT_FILING_WINDOW_DAYS,
  statedFiscalQuarterFromTranscript,
} from "../lib/mutations/transcripts";
import {
  deriveFilingReportingQuarter,
  expectedFiscalQuarterForPrint,
} from "../lib/transcripts/fetch";
import { isFilingRow } from "../lib/transcripts/presentation";
import { issuerSiblings } from "../lib/securities/issuer-family";

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

export interface DateMatchedFiling extends TranscriptKeyContradiction {
  /** The filing date (stored in `call_date`). */
  filing_date: string;
  /** The earnings print the filing date ties this row to. */
  print_date: string;
}

export interface TranscriptKeyAuditResult {
  contradictions: TranscriptKeyContradiction[];
  /**
   * Filings whose own label differs from their key but which were stored for
   * a print by filing date. Correct by design; listed for reference only.
   */
  dateMatchedFilings: DateMatchedFiling[];
  noStatementCount: number;
}

/**
 * The date of the earnings print this filing row was stored for, or null.
 * See the file header for the test.
 */
function printDateForFilingKey(
  db: Database.Database,
  row: { ticker: string; year: number; quarter: number; source: string; call_date: string | null },
): string | null {
  if (!isFilingRow(row)) return null;
  const filingDate = row.call_date?.slice(0, 10) ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(filingDate)) return null;
  const siblings = [...issuerSiblings(row.ticker)].map((s) => s.toUpperCase());
  if (siblings.length === 0) return null;
  const placeholders = siblings.map(() => "?").join(",");
  const prints = db
    .prepare(
      `SELECT symbol, event_date
         FROM calendar_events
        WHERE (event_type = 'earnings' OR source = 'finnhub')
          AND COALESCE(superseded, 0) = 0
          AND UPPER(symbol) IN (${placeholders})
          AND ABS(julianday(event_date) - julianday(?)) <= ?
        ORDER BY ABS(julianday(event_date) - julianday(?)) ASC, id ASC`,
    )
    .all(...siblings, filingDate, PRINT_FILING_WINDOW_DAYS, filingDate) as Array<{
    symbol: string;
    event_date: string;
  }>;
  for (const print of prints) {
    const key =
      expectedFiscalQuarterForPrint(db, print.symbol, print.event_date) ??
      deriveFilingReportingQuarter(print.event_date);
    if (key.year === row.year && key.quarter === row.quarter) return print.event_date;
  }
  return null;
}

export function auditTranscriptKeys(db: Database.Database): TranscriptKeyAuditResult {
  const rows = db
    .prepare(
      `SELECT id, ticker, year, quarter, source, call_date, transcript, fetched_at
         FROM earnings_transcripts
        ORDER BY id`,
    )
    .all() as Array<{
    id: number;
    ticker: string;
    year: number;
    quarter: number;
    source: string;
    call_date: string | null;
    transcript: string | null;
    fetched_at: string | null;
  }>;

  const contradictions: TranscriptKeyContradiction[] = [];
  const dateMatchedFilings: DateMatchedFiling[] = [];
  let noStatementCount = 0;
  for (const row of rows) {
    const stated = statedFiscalQuarterFromTranscript(row.transcript);
    if (!stated) {
      noStatementCount += 1;
      continue;
    }
    if (stated.quarter !== row.quarter || (stated.year !== null && stated.year !== row.year)) {
      const finding: TranscriptKeyContradiction = {
        id: row.id,
        ticker: row.ticker,
        key_year: row.year,
        key_quarter: row.quarter,
        stated_year: stated.year,
        stated_quarter: stated.quarter,
        source: row.source,
        fetched_at: row.fetched_at,
      };
      const printDate = printDateForFilingKey(db, row);
      if (printDate) {
        dateMatchedFilings.push({
          ...finding,
          filing_date: row.call_date!.slice(0, 10),
          print_date: printDate,
        });
      } else {
        contradictions.push(finding);
      }
    }
  }
  return { contradictions, dateMatchedFilings, noStatementCount };
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
    console.log(
      `Filings stored by filing date (own label differs from the key; correct by design): ${result.dateMatchedFilings.length}`,
    );
    for (const row of result.dateMatchedFilings) {
      console.log(
        `id=${row.id} ticker=${row.ticker} key=${row.key_year}Q${row.key_quarter} stated=${row.stated_year ?? "unknown"}Q${row.stated_quarter} filed=${row.filing_date} print=${row.print_date}`,
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

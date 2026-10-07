/**
 * Report-only audit: scan `earnings_transcripts WHERE source='edgar_8k'`,
 * recompute the CALENDAR reporting quarter from `call_date` (the filing
 * date), and list rows whose stored (year, quarter) differs from it.
 *
 * READ ONLY. This script used to carry a `--delete-flagged` mode. It was
 * removed on 2026-10-07: transcript rows are keyed by FISCAL quarter, so for
 * a company whose fiscal year is not the calendar year a difference from the
 * calendar quarter is the CORRECT state, and deleting "flagged" rows would
 * delete correct ones. The list is a reading aid, not a defect list. For
 * rows whose own text contradicts their key, use
 * scripts/audit-transcript-keys.ts (also read-only).
 *
 * Usage (from the repo root):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/audit-transcripts-quarter-mismatch.ts
 */
import "dotenv/config";
import Database from "better-sqlite3";
import { deriveFilingReportingQuarter } from "@/lib/transcripts/fetch";

const DB_PATH = process.env.VANGUARD_DB_PATH || "data/vanguard.db";

interface Row {
  id: number;
  ticker: string;
  year: number;
  quarter: number;
  call_date: string | null;
  accession_number: string | null;
}

if (process.argv.includes("--delete-flagged")) {
  console.error(
    "--delete-flagged was removed: rows are keyed by fiscal quarter, so a calendar mismatch is not an error. This script only reports.",
  );
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

const rows = db
  .prepare(
    `SELECT id, ticker, year, quarter, call_date, accession_number
       FROM earnings_transcripts
      WHERE source = 'edgar_8k'
        AND call_date IS NOT NULL
      ORDER BY ticker, year DESC, quarter DESC`,
  )
  .all() as Row[];

const listed: Array<{ row: Row; computed: { year: number; quarter: number } }> = [];

for (const r of rows) {
  if (!r.call_date) continue;
  const computed = deriveFilingReportingQuarter(r.call_date);
  if (computed.year !== r.year || computed.quarter !== r.quarter) {
    listed.push({ row: r, computed });
  }
}

console.log(`Scanned ${rows.length} edgar_8k rows [READ ONLY].`);
console.log(`${listed.length} keyed differently from the calendar quarter of their filing date.\n`);

for (const { row, computed } of listed) {
  console.log(
    `  id=${row.id} ${row.ticker} stored=Q${row.quarter} ${row.year} ` +
      `calendar-from-${row.call_date}=Q${computed.quarter} ${computed.year} ` +
      `accession=${row.accession_number}`,
  );
}

if (listed.length > 0) {
  console.log(
    `\nNothing was changed. A fiscal key that differs from the calendar quarter is ` +
      `expected for any company whose fiscal year is not the calendar year.`,
  );
}

db.close();

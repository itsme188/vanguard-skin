/**
 * One-shot audit: scan `earnings_transcripts WHERE source='edgar_8k'`,
 * recompute the calendar reporting quarter from `call_date` (which the
 * EDGAR fallback set to the filing date), and flag rows whose stored
 * (year, quarter) labels disagree with the computed quarter.
 *
 * Print-only by default — review before purging. Pass `--delete-flagged`
 * to actually remove the mismatched rows. Tickers on non-calendar fiscal
 * years (AAPL, ORCL, ADBE, etc.) will produce false-positive flags;
 * eyeball the output before deleting.
 *
 * Usage: npx tsx scripts/audit-transcripts-quarter-mismatch.ts [--delete-flagged]
 */
import "dotenv/config";
import Database from "better-sqlite3";
import { deriveFilingReportingQuarter } from "@/lib/transcripts/fetch";

const DB_PATH = process.env.VANGUARD_DB_PATH || "data/vanguard.db";
const SHOULD_DELETE = process.argv.includes("--delete-flagged");

interface Row {
  id: number;
  ticker: string;
  year: number;
  quarter: number;
  call_date: string | null;
  accession_number: string | null;
}

const db = new Database(DB_PATH);

const rows = db
  .prepare(
    `SELECT id, ticker, year, quarter, call_date, accession_number
       FROM earnings_transcripts
      WHERE source = 'edgar_8k'
        AND call_date IS NOT NULL
      ORDER BY ticker, year DESC, quarter DESC`,
  )
  .all() as Row[];

const flagged: Array<{ row: Row; computed: { year: number; quarter: number } }> = [];

for (const r of rows) {
  if (!r.call_date) continue;
  const computed = deriveFilingReportingQuarter(r.call_date);
  if (computed.year !== r.year || computed.quarter !== r.quarter) {
    flagged.push({ row: r, computed });
  }
}

console.log(`Scanned ${rows.length} edgar_8k transcripts.`);
console.log(`${flagged.length} flagged as quarter-mismatched.\n`);

if (flagged.length === 0) {
  process.exit(0);
}

console.log("Flagged rows:");
for (const { row, computed } of flagged) {
  console.log(
    `  id=${row.id} ${row.ticker} stored=Q${row.quarter} ${row.year} ` +
      `computed-from-${row.call_date}=Q${computed.quarter} ${computed.year} ` +
      `accession=${row.accession_number}`,
  );
}

if (SHOULD_DELETE) {
  const ids = flagged.map((f) => f.row.id);
  const placeholders = ids.map(() => "?").join(",");
  const result = db
    .prepare(`DELETE FROM earnings_transcripts WHERE id IN (${placeholders})`)
    .run(...ids);
  console.log(`\nDeleted ${result.changes} flagged rows.`);
} else {
  console.log(
    `\nDry run — pass --delete-flagged to remove these rows. ` +
      `Eyeball first: tickers on non-calendar fiscal years will produce ` +
      `false positives (their fiscal Q4 ≠ calendar Q4).`,
  );
}

db.close();

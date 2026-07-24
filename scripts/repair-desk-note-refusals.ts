/**
 * Repair earnings_transcripts rows whose `summary` is an AI soft refusal
 * (request-for-input) instead of a desk note — the 2026-07-22 CSX leak
 * class. Recomputes the extractive summary from the stored transcript.
 *
 * Dry-run by default:  npx tsx scripts/repair-desk-note-refusals.ts
 * Apply:               npx tsx scripts/repair-desk-note-refusals.ts --apply
 *
 * Idempotent: a repaired row no longer matches looksLikeDeskNoteRefusal.
 */
import Database from "better-sqlite3";
import path from "path";
import { generateSummary } from "../lib/transcripts/fetch";
import { looksLikeDeskNoteRefusal } from "../lib/transcripts/same-day";

const apply = process.argv.includes("--apply");
const db = new Database(path.join(process.cwd(), "data", "vanguard.db"));

const rows = db
  .prepare(
    `SELECT id, ticker, year, quarter, transcript, summary
       FROM earnings_transcripts
      WHERE summary IS NOT NULL AND summary != ''`
  )
  .all() as {
  id: number;
  ticker: string;
  year: number;
  quarter: number;
  transcript: string | null;
  summary: string;
}[];

let matched = 0;
let repaired = 0;
const update = db.prepare(`UPDATE earnings_transcripts SET summary = ? WHERE id = ?`);

for (const row of rows) {
  if (!looksLikeDeskNoteRefusal(row.summary)) continue;
  matched += 1;
  const fixed = generateSummary(row.transcript ?? "");
  console.log(
    `row ${row.id} (${row.ticker} ${row.year} Q${row.quarter}): refusal ${row.summary.length} chars -> extractive ${fixed.length} chars`
  );
  if (apply) {
    update.run(fixed, row.id);
    repaired += 1;
  }
}

console.log(
  apply
    ? `Repaired ${repaired} of ${matched} refusal-shaped rows.`
    : `Would repair ${matched} refusal-shaped rows. Re-run with --apply.`
);
db.close();

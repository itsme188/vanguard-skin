/**
 * Dry-run-default repair for cached transcript rows whose call-date evidence
 * does not sit near the earnings print date their cache key claims.
 *
 * Usage:
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-stale-transcripts.ts
 *   REPAIR_DB_PATH=/tmp/rehearsal.db PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-stale-transcripts.ts --apply
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import {
  deriveFilingReportingQuarter,
  transcriptCallDateEvidence,
  TRANSCRIPT_CALL_DATE_WINDOW_DAYS,
} from "../lib/transcripts/fetch";

export interface StaleTranscriptRow {
  id: number;
  ticker: string;
  year: number;
  quarter: number;
  source_key: string;
  evidence_date: string;
  nearest_event_date: string;
  days_apart: number;
}

export interface StaleTranscriptRepairResult {
  rows: StaleTranscriptRow[];
  applied: boolean;
}

function daysBetween(a: string, b: string): number {
  const aMs = Date.parse(`${a}T12:00:00Z`);
  const bMs = Date.parse(`${b}T12:00:00Z`);
  return Math.abs(aMs - bMs) / 86_400_000;
}

export function planStaleTranscriptRepair(db: Database.Database): StaleTranscriptRepairResult {
  const transcripts = db
    .prepare(
      `SELECT id, ticker, year, quarter, source_key, call_date, transcript
         FROM earnings_transcripts
        ORDER BY id`,
    )
    .all() as Array<{
      id: number;
      ticker: string;
      year: number;
      quarter: number;
      source_key: string;
      call_date: string | null;
      transcript: string | null;
    }>;

  const events = db
    .prepare(
      `SELECT symbol, event_date
         FROM calendar_events
        WHERE (event_type = 'earnings' OR source = 'finnhub')
          AND COALESCE(superseded, 0) = 0
          AND symbol IS NOT NULL`,
    )
    .all() as Array<{ symbol: string; event_date: string }>;

  const rows: StaleTranscriptRow[] = [];
  for (const t of transcripts) {
    const evidence = transcriptCallDateEvidence(t.transcript, t.call_date);
    if (!evidence) continue;
    const matchingEvents = events.filter((event) => {
      if (event.symbol.toUpperCase() !== t.ticker.toUpperCase()) return false;
      const q = deriveFilingReportingQuarter(event.event_date);
      return q.year === t.year && q.quarter === t.quarter;
    });
    if (matchingEvents.length === 0) continue;

    const nearest = matchingEvents
      .map((event) => ({
        eventDate: event.event_date,
        days: daysBetween(evidence.date, event.event_date),
      }))
      .sort((a, b) => a.days - b.days)[0];
    if (nearest.days <= TRANSCRIPT_CALL_DATE_WINDOW_DAYS) continue;

    rows.push({
      id: t.id,
      ticker: t.ticker,
      year: t.year,
      quarter: t.quarter,
      source_key: t.source_key,
      evidence_date: evidence.date,
      nearest_event_date: nearest.eventDate,
      days_apart: nearest.days,
    });
  }

  return { rows, applied: false };
}

export function runStaleTranscriptRepair(
  db: Database.Database,
  opts: { apply?: boolean } = {},
): StaleTranscriptRepairResult {
  const plan = planStaleTranscriptRepair(db);
  if (!opts.apply || plan.rows.length === 0) return plan;
  const del = db.prepare("DELETE FROM earnings_transcripts WHERE id = ?");
  const tx = db.transaction((rows: StaleTranscriptRow[]) => {
    for (const row of rows) del.run(row.id);
  });
  tx(plan.rows);
  return { rows: plan.rows, applied: true };
}

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");

function main() {
  const apply = process.argv.includes("--apply");
  const db = new BetterSqlite3(DB_PATH, { readonly: !apply }) as Database.Database;
  try {
    const result = runStaleTranscriptRepair(db, { apply });
    console.log(`Stale transcript repair ${apply ? "[APPLY]" : "[DRY RUN]"} — db: ${DB_PATH}`);
    console.log(`Rows ${apply ? "deleted" : "that would be deleted"}: ${result.rows.length}`);
    for (const row of result.rows) {
      console.log(
        `id=${row.id} ticker=${row.ticker} key=${row.source_key} evidence=${row.evidence_date} nearest_event=${row.nearest_event_date} days=${row.days_apart.toFixed(0)}`,
      );
    }
    if (!apply) {
      console.log("Dry run only. Re-run with --apply against a rehearsed REPAIR_DB_PATH copy.");
    }
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith("repair-stale-transcripts.ts")) {
  main();
}

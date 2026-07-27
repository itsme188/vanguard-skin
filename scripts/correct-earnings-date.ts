/**
 * Correct a WRONG sync-sourced earnings date (the NET case: Finnhub + the
 * calendar carried 2026-07-30; the real print is Aug 6).
 *
 * For every earnings row of SYMBOL on WRONG_DATE: delete it and record a
 * (symbol, date, type) suppression (migration 070) so the next sync sweep
 * can't re-insert it — then insert a manual row on CORRECT_DATE.
 *
 * Usage:
 *   npx tsx scripts/correct-earnings-date.ts <SYMBOL> <WRONG_DATE> <CORRECT_DATE> [bmo|amc]
 *   npx tsx scripts/correct-earnings-date.ts NET 2026-07-30 2026-08-06
 *
 * Slot defaults to the deleted row's event_time (falling back to AMC).
 * Idempotent: re-running with no wrong-date rows left just ensures the
 * manual row exists.
 */

import { db } from "../lib/db";
import {
  deleteAndSuppressCalendarEvent,
  insertCalendarEvent,
} from "../lib/mutations/calendar";
import { getSecurityIdForSymbol } from "../lib/queries/briefing-symbols";
import { mondayOf } from "../lib/calendar/date-utils";

const [, , rawSymbol, wrongDate, correctDate, rawSlot] = process.argv;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
if (!rawSymbol || !DATE_RE.test(wrongDate ?? "") || !DATE_RE.test(correctDate ?? "")) {
  console.error(
    "Usage: npx tsx scripts/correct-earnings-date.ts <SYMBOL> <WRONG_DATE> <CORRECT_DATE> [bmo|amc]",
  );
  process.exit(1);
}
const symbol = rawSymbol.trim().toUpperCase();
const slotArg = rawSlot ? rawSlot.trim().toUpperCase() : null;
if (slotArg && slotArg !== "BMO" && slotArg !== "AMC") {
  console.error(`Slot must be bmo or amc, got: ${rawSlot}`);
  process.exit(1);
}

const wrongRows = db
  .prepare(
    `SELECT id, source, source_key, event_time, actual_value
       FROM calendar_events
      WHERE UPPER(symbol) = ? AND event_date = ? AND event_type = 'earnings'`,
  )
  .all(symbol, wrongDate) as Array<{
  id: number;
  source: string;
  source_key: string;
  event_time: string | null;
  actual_value: string | null;
}>;

for (const row of wrongRows) {
  if (row.actual_value) {
    console.error(
      `Refusing: row #${row.id} (${row.source_key}) already has captured actuals — ` +
        `that print really happened on ${wrongDate}. Nothing deleted.`,
    );
    process.exit(1);
  }
}
if (wrongRows.length === 0) {
  console.log(`No earnings rows for ${symbol} on ${wrongDate} — nothing to delete.`);
}

// ── 1. Ensure the corrected manual row exists FIRST ─────────────────────────
// Insert-before-delete so user-curated earnings_bogeys on the wrong rows can
// be re-pointed at the new event instead of dying in the delete CASCADE.
const eventTime = slotArg ?? wrongRows[0]?.event_time ?? "AMC";
let newEventId: number;
try {
  const { id } = insertCalendarEvent(db, {
    symbol,
    event_date: correctDate,
    event_type: "earnings",
    event_time: eventTime,
    security_id: getSecurityIdForSymbol(db, symbol),
    week_of: mondayOf(correctDate),
    description: `Date corrected from ${wrongDate} (wrong sync-sourced date)`,
  });
  newEventId = id;
  console.log(`Inserted manual earnings event #${id}: ${symbol} ${correctDate} ${eventTime}.`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/UNIQUE constraint failed/i.test(msg)) throw err;
  const existing = db
    .prepare(
      `SELECT id FROM calendar_events
        WHERE source = 'manual' AND UPPER(symbol) = ? AND event_date = ? AND event_type = 'earnings'`,
    )
    .get(symbol, correctDate) as { id: number };
  newEventId = existing.id;
  console.log(`Manual event for ${symbol} on ${correctDate} already exists (#${newEventId}).`);
}

// ── 2. Migrate user-curated bogeys off the doomed rows ──────────────────────
// OR IGNORE: UNIQUE(event_id, source, source_label) — a bogey already present
// on the corrected event wins, and its wrong-row duplicate cascades away.
for (const row of wrongRows) {
  const moved = db
    .prepare("UPDATE OR IGNORE earnings_bogeys SET event_id = ? WHERE event_id = ?")
    .run(newEventId, row.id).changes;
  if (moved > 0) console.log(`Moved ${moved} bogeys row(s) from event #${row.id} → #${newEventId}.`);
}

// ── 3. Delete the wrong rows + suppress the tuple ───────────────────────────
for (const row of wrongRows) {
  const result = deleteAndSuppressCalendarEvent(db, row.id);
  console.log(
    `Deleted ${row.source_key} (#${row.id}); suppressed ${result.suppressed?.symbol} ${result.suppressed?.event_date} — the next sync can't re-insert it.`,
  );
}

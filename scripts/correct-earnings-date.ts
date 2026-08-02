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
 *
 * Thin CLI wrapper — the actual logic lives in
 * lib/mutations/calendar.ts::correctEarningsEventDate so the automated date
 * verifier can call it directly.
 */

import { db } from "../lib/db";
import { correctEarningsEventDate } from "../lib/mutations/calendar";

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

const result = correctEarningsEventDate(db, {
  symbol,
  wrongDate,
  correctDate,
  slot: slotArg as "BMO" | "AMC" | undefined,
});

if (!result.ok) {
  console.error(result.refusedReason);
  process.exit(1);
}

if (result.deletedIds && result.deletedIds.length === 0) {
  console.log(`No earnings rows for ${symbol} on ${wrongDate} — nothing to delete.`);
}

console.log(`Corrected event #${result.newEventId}: ${symbol} now on ${correctDate}.`);
if (result.bogeysMigrated) {
  console.log(`Migrated ${result.bogeysMigrated} bogeys row(s) onto event #${result.newEventId}.`);
}
for (const id of result.deletedIds ?? []) {
  console.log(`Deleted + suppressed wrong row #${id} (${wrongDate}) — the next sync can't re-insert it.`);
}

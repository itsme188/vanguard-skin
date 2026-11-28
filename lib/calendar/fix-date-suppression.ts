/**
 * The suppression "Fix date" leaves behind (owner ruling 2026-09-02, option 2).
 *
 * "Fix date" (`correctEarningsEventDate`, lib/mutations/calendar.ts) deletes
 * the vendor's wrong-dated earnings row, records a suppression for that
 * (symbol, wrong date) so no sync brings it back, and mints a manual row on
 * the corrected date. If the user later removes that corrected row, the
 * suppression is all that is left: the company has no earnings date and no
 * sync restores one.
 *
 * The corrected row is recognised by the description the correction writes on
 * it. The delete confirm reads it to warn, and "remove and restore vendor
 * date" lifts the one suppression that correction minted. Pure and
 * db-injected: no singleton import, safe to import from a client component.
 */

import type Database from "better-sqlite3";

/** Matches the description `correctEarningsEventDate` writes on the row it mints. */
const FIX_DATE_DESCRIPTION_RE = /^Date corrected from (\d{4}-\d{2}-\d{2}) \(wrong sync-sourced date\)/;

/**
 * The vendor date a manual row was corrected FROM, or null when the row is
 * not a "Fix date" product (a plain "+ Add ticker" row, a confirmed date).
 * Only a manual row can be one: an adopted vendor row keeps its own source.
 */
export function fixDateOrigin(row: {
  source: string | null | undefined;
  description: string | null | undefined;
}): string | null {
  if (row.source !== "manual") return null;
  const match = FIX_DATE_DESCRIPTION_RE.exec((row.description ?? "").trim());
  return match ? match[1] : null;
}

/**
 * The suppression reason `deleteAndSuppressCalendarEvent` writes for a row it
 * deletes is `user-deleted ${row.source} row #${id}` (lib/mutations/calendar.ts),
 * and Fix date deletes the wrong-date rows through it. A hand-entered wrong row
 * therefore leaves `user-deleted manual row #N`. Only that exact shape means
 * "the earlier date was the user's own entry"; anything else (a vendor source,
 * a missing reason, a missing suppression) keeps the vendor reading.
 */
const MANUAL_ORIGIN_REASON_RE = /^user-deleted manual row #\d+$/;

/**
 * The VENDOR date a Fix-date row hid, or null. Same as `fixDateOrigin` except
 * that when the earlier date was the user's own hand-entered row there is no
 * vendor date to restore, so it answers null. The row's description reads the
 * same in both cases, so this looks at the suppression's stored reason.
 */
export function fixDateVendorOrigin(
  db: Database.Database,
  row: {
    symbol: string | null | undefined;
    source: string | null | undefined;
    description: string | null | undefined;
  },
): string | null {
  const origin = fixDateOrigin(row);
  if (origin === null || !row.symbol) return null;
  const hidden = db
    .prepare(
      `SELECT reason FROM calendar_event_suppressions
        WHERE UPPER(symbol) = ? AND event_date = ? AND event_type = 'earnings'`,
    )
    .get(row.symbol.trim().toUpperCase(), origin) as { reason: string | null } | undefined;
  if (hidden?.reason && MANUAL_ORIGIN_REASON_RE.test(hidden.reason)) return null;
  return origin;
}

/**
 * Remove the earnings suppression for one (symbol, date). Returns how many
 * rows were removed (0 when there was none). The vendor's row is not
 * re-created here: it returns on the next calendar sync, if the vendor still
 * carries that date.
 */
export function liftEarningsSuppression(
  db: Database.Database,
  params: { symbol: string; eventDate: string },
): number {
  return db
    .prepare(
      `DELETE FROM calendar_event_suppressions
        WHERE UPPER(symbol) = ? AND event_date = ? AND event_type = 'earnings'`,
    )
    .run(params.symbol.trim().toUpperCase(), params.eventDate).changes;
}

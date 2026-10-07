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

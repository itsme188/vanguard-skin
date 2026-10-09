import { todayET } from "@/lib/calendar/date-utils";

/**
 * "Today" for a SQL calendar-day comparison is the EASTERN day, supplied from
 * JavaScript. It is never SQLite's `date('now')`: that is the UTC day, which
 * is already tomorrow between 20:00 and midnight Eastern, so a bond maturing
 * today, an option expiring today or a "since N days ago" window moved four
 * to five hours early every evening.
 *
 * Use a bound `todayET()` parameter where the statement's parameters are easy
 * to extend. Where a fragment is shared between statements that each carry
 * their own positional parameter list, use the validated literal below (the
 * same pattern as `liveOptionExpirationSql` and `latestHoldingsPredicate`).
 *
 * Elapsed-time comparisons between two instants (`datetime(col) >
 * datetime('now', '-30 minutes')`) and written stamps are correct in UTC and
 * do not belong here. `tests/repo/no-sql-utc-day.test.ts` guards the split.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Eastern calendar day as a quoted SQL string literal, e.g. `'2026-10-09'`.
 * Drop-in for `date('now')`; for an offset write
 * `date(${easternDaySql()}, '-1 day')`.
 */
export function easternDaySql(today: string = todayET()): string {
  if (!DATE_PATTERN.test(today)) {
    throw new Error(`easternDaySql: today must match YYYY-MM-DD, got ${JSON.stringify(today)}`);
  }
  return `'${today}'`;
}

/**
 * SQL fragment against a `securities` row aliased `alias`: true for a
 * security with no maturity date and for one that matures today (Eastern) or
 * later. A bond past its maturity date is no longer a position; on the
 * maturity day itself it still is, through the end of that Eastern day.
 */
export function unmaturedSecuritySql(alias = "s", today: string = todayET()): string {
  return `(${alias}.maturity_date IS NULL OR ${alias}.maturity_date >= ${easternDaySql(today)})`;
}

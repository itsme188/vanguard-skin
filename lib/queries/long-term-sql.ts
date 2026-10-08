/**
 * SQL twins of `isLongTermHolding` (lib/compute/tax-lots.ts), the single
 * source for the long-term / short-term question. Calendar-anniversary rule
 * (IRS Pub 550): a lot is long-term iff the disposition date is strictly
 * AFTER the one-year anniversary of acquisition, not after a fixed 365- or
 * 366-day count (a span that crosses Feb 29 is 366 days on the anniversary
 * itself, which is still short-term).
 *
 * The anniversary is the SAME month-day one year on, built as a string the
 * way that function builds it: SQLite's date(x, '+1 year') rolls Feb 29
 * forward to Mar 1, which would make a Feb-29 lot long-term one day late.
 *
 * `acquisitionDateColumn` is a column reference holding a `YYYY-MM-DD`
 * string (never user input). Pinned against the engine function by
 * tests/queries/long-term-sql.test.ts — never let these diverge from it.
 */

/** 1 when `asOfExpr` (default: a bound `?`) is past the anniversary, else 0. */
export function isLongTermSql(acquisitionDateColumn: string, asOfExpr: string = "?"): string {
  const c = acquisitionDateColumn;
  return `CASE WHEN ${asOfExpr} > (printf('%04d', CAST(substr(${c}, 1, 4) AS INTEGER) + 1) || substr(${c}, 5, 6))
        THEN 1 ELSE 0 END`;
}

/** The first date on which the lot is long-term: the day after the anniversary. */
export function longTermDateSql(acquisitionDateColumn: string): string {
  const c = acquisitionDateColumn;
  return `CASE WHEN substr(${c}, 6, 5) = '02-29'
        THEN date(${c}, '+1 year')
        ELSE date(${c}, '+1 year', '+1 day') END`;
}

import type Database from "better-sqlite3";

/**
 * Delete holdings rows for bond securities whose `maturity_date` is more
 * than `graceDays` days in the past. Sibling to `purgeExpiredOptionHoldings`
 * — statement imports never zero-out positions that simply disappear from a
 * later snapshot, so matured T-bills + bonds can linger in `holdings`
 * indefinitely and surface in scenario rate-shocks / fixed-income analytics /
 * cross-account rollups.
 *
 * The 1-day default grace tolerates end-of-day maturity reporting that may
 * settle the morning after the maturity date.
 *
 * Returns the count of rows deleted.
 */
export function purgeMaturedBondHoldings(
  db: Database.Database,
  graceDays = 1,
): number {
  const result = db
    .prepare(
      `DELETE FROM holdings
       WHERE security_id IN (
         SELECT id FROM securities
         WHERE LOWER(security_type) = 'bond'
           AND maturity_date IS NOT NULL
           AND date(maturity_date) < date('now', ?)
       )`,
    )
    .run(`-${graceDays} day`);
  return result.changes;
}

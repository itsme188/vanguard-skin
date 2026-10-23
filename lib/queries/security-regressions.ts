import type Database from "better-sqlite3";
import type { SecurityRegression } from "@/lib/compute/security-regression";
import { todayET } from "@/lib/calendar/date-utils";

export interface CachedRegression extends SecurityRegression {
  computedAtDay: string; // YYYY-MM-DD
}

/**
 * The first Eastern day on which every cached row was written by the current
 * regression engine (split-adjusted closes, long-gap pairs dropped). A row
 * with an earlier computed_at_day came from the pre-split-adjustment engine
 * and is treated as a cache miss. Bump this day whenever the regression math
 * changes.
 */
export const REGRESSION_ENGINE_SINCE = "2026-10-21";

/**
 * Returns the most recent cached regression for (security_id, benchmark_symbol),
 * or null if no row exists (rows older than REGRESSION_ENGINE_SINCE count as none).
 */
export function getCachedRegression(
  db: Database.Database,
  securityId: number,
  benchmarkSymbol: string
): CachedRegression | null {
  const row = db
    .prepare(
      `SELECT beta, vol, correlation, r_squared AS rSquared,
              data_points AS dataPoints, computed_at_day AS computedAtDay
         FROM security_regressions
        WHERE security_id = ? AND benchmark_symbol = ?
          AND computed_at_day >= ?
        ORDER BY computed_at_day DESC
        LIMIT 1`
    )
    .get(securityId, benchmarkSymbol, REGRESSION_ENGINE_SINCE) as CachedRegression | undefined;
  return row ?? null;
}

/**
 * Upsert a row keyed on (security_id, benchmark_symbol, computed_at_day).
 * The composite PK includes computed_at_day so multiple days can coexist;
 * this function only touches one day's row.
 *
 * `now` is a TEST SEAM (not a feature) so the cache-picks-most-recent test
 * can pin two distinct days. Production callers should omit it and let it
 * default to today's ET date.
 */
export function upsertRegression(
  db: Database.Database,
  args: { securityId: number; benchmarkSymbol: string; result: SecurityRegression },
  now?: string
): void {
  const computedAtDay = now ?? todayET();
  db.prepare(
    `INSERT INTO security_regressions
       (security_id, benchmark_symbol, computed_at_day, beta, vol, correlation, r_squared, data_points)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(security_id, benchmark_symbol, computed_at_day) DO UPDATE SET
       beta = excluded.beta,
       vol = excluded.vol,
       correlation = excluded.correlation,
       r_squared = excluded.r_squared,
       data_points = excluded.data_points`
  ).run(
    args.securityId,
    args.benchmarkSymbol,
    computedAtDay,
    args.result.beta,
    args.result.vol,
    args.result.correlation,
    args.result.rSquared,
    args.result.dataPoints
  );
}

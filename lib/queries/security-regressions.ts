import type Database from "better-sqlite3";
import type { SecurityRegression } from "@/lib/compute/security-regression";

export interface CachedRegression extends SecurityRegression {
  computedAtDay: string; // YYYY-MM-DD
}

/**
 * Returns the most recent cached regression for (security_id, benchmark_symbol),
 * or null if no row exists.
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
        ORDER BY computed_at_day DESC
        LIMIT 1`
    )
    .get(securityId, benchmarkSymbol) as CachedRegression | undefined;
  return row ?? null;
}

/**
 * Upsert a row keyed on (security_id, benchmark_symbol, computed_at_day).
 * The composite PK includes computed_at_day so multiple days can coexist;
 * this function only touches one day's row.
 *
 * `now` is a TEST SEAM (not a feature) so the cache-picks-most-recent test
 * can pin two distinct days. Production callers should omit it and let it
 * default to today's ISO date.
 */
export function upsertRegression(
  db: Database.Database,
  args: { securityId: number; benchmarkSymbol: string; result: SecurityRegression },
  now?: string
): void {
  const computedAtDay = now ?? new Date().toISOString().slice(0, 10);
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

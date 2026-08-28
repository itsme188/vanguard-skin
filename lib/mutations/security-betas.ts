import type Database from "better-sqlite3";

export interface UpsertBetaInput {
  securityId: number;
  lookbackDays: number;
  beta: number;
  /** Residual std-dev of the regression, in PERCENT units. Optional for
   *  callers that only have beta (degraded mode); stored as NULL when absent. */
  residualStd?: number | null;
}

/**
 * Insert or update a beta value (and optional residual std-dev) for a given
 * security and lookback window.
 *
 * The (security_id, lookback_days) pair is unique — updating via ON CONFLICT
 * ensures exactly one row exists per pair. `computed_at` is set automatically.
 */
export function upsertBeta(db: Database.Database, input: UpsertBetaInput): void {
  db.prepare(
    `INSERT INTO security_betas (security_id, lookback_days, beta, residual_std, computed_at)
       VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(security_id, lookback_days) DO UPDATE SET
       beta = excluded.beta,
       residual_std = excluded.residual_std,
       computed_at = excluded.computed_at`,
  ).run(
    input.securityId,
    input.lookbackDays,
    input.beta,
    input.residualStd ?? null,
  );
}

/**
 * Delete the cached beta for ONE (security, lookback window) pair.
 *
 * Used by the confidence gate in `lib/compute/beta-confidence.ts`: when a
 * refreshed regression has no explanatory power (r² below the floor) or too
 * few aligned pairs, the stale row must not keep publishing. `beta` is NOT
 * NULL, so there is no "unknown" value to store — a MISSING row is what every
 * consumer already reads as "no beta" (see the LEFT JOIN in
 * `lib/digest/anomalies.ts`). Sibling lookback windows are left untouched.
 */
export function deleteBeta(
  db: Database.Database,
  securityId: number,
  lookbackDays: number,
): void {
  db.prepare(
    "DELETE FROM security_betas WHERE security_id = ? AND lookback_days = ?",
  ).run(securityId, lookbackDays);
}

/**
 * Delete all beta rows for a given security across all lookback windows.
 *
 * Used when invalidating cached betas (e.g., data correction, security deletes).
 */
export function deleteBetasForSecurity(db: Database.Database, securityId: number): void {
  db.prepare("DELETE FROM security_betas WHERE security_id = ?").run(securityId);
}

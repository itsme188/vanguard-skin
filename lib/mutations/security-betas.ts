import type Database from "better-sqlite3";

export interface UpsertBetaInput {
  securityId: number;
  lookbackDays: number;
  beta: number;
}

/**
 * Insert or update a beta value for a given security and lookback window.
 *
 * The (security_id, lookback_days) pair is unique — updating via ON CONFLICT
 * ensures exactly one row exists per pair. `computed_at` is set to the current
 * time automatically.
 */
export function upsertBeta(db: Database.Database, input: UpsertBetaInput): void {
  db.prepare(
    `INSERT INTO security_betas (security_id, lookback_days, beta, computed_at)
       VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(security_id, lookback_days) DO UPDATE SET
       beta = excluded.beta,
       computed_at = excluded.computed_at`,
  ).run(input.securityId, input.lookbackDays, input.beta);
}

/**
 * Delete all beta rows for a given security across all lookback windows.
 *
 * Used when invalidating cached betas (e.g., data correction, security deletes).
 */
export function deleteBetasForSecurity(db: Database.Database, securityId: number): void {
  db.prepare("DELETE FROM security_betas WHERE security_id = ?").run(securityId);
}

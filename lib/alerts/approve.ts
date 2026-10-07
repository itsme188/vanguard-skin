import type Database from "better-sqlite3";
import { getLevelById } from "@/lib/queries/security-levels";
import { ARMED_CROSSED_AT_SET_SQL, evaluateArmGuard } from "@/lib/alerts/arm-guard";

export interface ApproveLevelGuardResult {
  ok: boolean;
  /**
   * Why the arm was refused. Both codes mean "no write happened"; both are
   * overridable with `force`.
   *  - would_fire_immediately: the condition already holds, so arming buys a
   *    guaranteed false alert on the next scan.
   *  - beyond_scan_range: the level sits outside the scanner's plausibility
   *    band, so arming buys dead coverage — an alert that can never fire.
   */
  code?: "would_fire_immediately" | "beyond_scan_range";
  currentPrice?: number;
  effectivePrice?: number;
}

/**
 * Approve (arm) a security level, guarding against the "approve fires an
 * instant false hit" bug (QA finding
 * alerts-review--approve-fires-instant-false-hit-alert-threshold-scan):
 * approving a pending level whose trigger condition is ALREADY satisfied
 * arms a guaranteed false alert on the very next scan.
 *
 * The guard is evaluateArmGuard (lib/alerts/arm-guard.ts), shared with
 * reactivateLevel. It resolves the current price the exact same way
 * findCrossedLevels does and evaluates the condition through the scanner's
 * own trigger-state helper — so the guard and the scanner can never disagree
 * about what "already hit" means.
 *
 * A level whose price is missing, stale, or unresolvable (MA needs more OHLCV
 * history) is treated as NOT already-fired — matching what the scanner itself
 * would skip — and arms normally: we simply can't judge it right now.
 *
 * A level BEYOND THE PLAUSIBILITY BAND is different, and is the second guard
 * here (2026-08-20). The band forces `hit:false`, so the would_fire check can
 * never catch it: a mis-scaled extracted level (SPX prices on SPY, per-contract
 * vs per-share) used to approve silently and arm coverage the scanner skips on
 * every single pass. The scanner's own beyond-range verdict, never re-derived
 * here, turns that into an honest
 * refusal the caller can override.
 *
 * - Condition satisfied AND !force → refuse, no write: { ok:false,
 *   code:'would_fire_immediately', currentPrice, effectivePrice }.
 * - Condition satisfied AND force → arm AND stamp armed_crossed_at.
 * - Beyond the band AND !force → refuse, no write: { ok:false,
 *   code:'beyond_scan_range', currentPrice, effectivePrice }.
 * - Beyond the band AND force → arm, and do NOT stamp armed_crossed_at —
 *   nothing was crossed; the level is simply out of range.
 * - Neither → arm normally AND clear armed_crossed_at (so a stale stamp from a
 *   prior force-arm cycle can't survive a clean re-approval).
 *
 * Accepts any current review_status — the guard only cares about the
 * condition at the moment of arming, not how the level got here.
 */
export function approveLevelGuarded(
  db: Database.Database,
  id: number,
  opts: { force?: boolean } = {}
): ApproveLevelGuardResult {
  const level = getLevelById(db, id);
  if (!level) {
    // Nothing to guard against — mirror the prior blind-UPDATE behavior
    // (WHERE id=? matching zero rows is a silent no-op, not an error).
    db.prepare(
      `UPDATE security_levels
       SET review_status = 'auto_approved', armed_crossed_at = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(id);
    return { ok: true };
  }

  // The guard itself (price resolution, both refusals, the stamp rule) is
  // shared with reactivateLevel — see lib/alerts/arm-guard.ts.
  const verdict = evaluateArmGuard(db, level, opts);
  if (verdict.refusal) return { ok: false, ...verdict.refusal };

  db.prepare(
    `UPDATE security_levels
     SET review_status = 'auto_approved',
         ${ARMED_CROSSED_AT_SET_SQL},
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(verdict.stampCrossed ? 1 : 0, id);

  return { ok: true };
}

import type Database from "better-sqlite3";
import {
  getLevelById,
  getLatestScanPriceForSecurity,
  checkLevelTriggerState,
} from "@/lib/queries/security-levels";

export interface ApproveLevelGuardResult {
  ok: boolean;
  code?: "would_fire_immediately";
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
 * Resolves the current price the exact same way findCrossedLevels does
 * (getLatestScanPriceForSecurity) and evaluates the condition through
 * checkLevelTriggerState — the same helper the scanner uses — so the guard
 * and the scanner can never disagree about what "already hit" means.
 *
 * A level whose price is missing, stale (>4 days), unresolvable (MA needs
 * more OHLCV history), or implausible (>50% away — mis-scaled level) is
 * treated as NOT already-fired, matching what the scanner itself would skip,
 * and arms normally.
 *
 * - Condition satisfied AND !force → refuse, no write: { ok:false,
 *   code:'would_fire_immediately', currentPrice, effectivePrice }.
 * - Condition satisfied AND force → arm AND stamp armed_crossed_at.
 * - Condition not satisfied → arm normally AND clear armed_crossed_at (so a
 *   stale stamp from a prior force-arm cycle can't survive a clean
 *   re-approval).
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

  const priceInfo = getLatestScanPriceForSecurity(db, level.security_id);

  let wouldFire = false;
  let effectivePrice: number | null = null;

  if (priceInfo.currentPrice !== null && priceInfo.isFresh) {
    const state = checkLevelTriggerState(
      db,
      {
        id: level.id,
        security_id: level.security_id,
        level_type: level.level_type,
        price: level.price,
        price_source: level.price_source,
        sec_type: priceInfo.secType,
      },
      priceInfo.currentPrice
    );
    wouldFire = state.hit;
    effectivePrice = state.effectivePrice;
  }

  if (wouldFire && !opts.force) {
    return {
      ok: false,
      code: "would_fire_immediately",
      currentPrice: priceInfo.currentPrice as number,
      effectivePrice: effectivePrice as number,
    };
  }

  const stamp = wouldFire && opts.force;
  db.prepare(
    `UPDATE security_levels
     SET review_status = 'auto_approved',
         armed_crossed_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(stamp ? 1 : 0, id);

  return { ok: true };
}

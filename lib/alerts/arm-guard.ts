import type Database from "better-sqlite3";
import type { SecurityLevel } from "@/lib/types";
import {
  getLatestScanPriceForSecurity,
  checkLevelTriggerState,
} from "@/lib/queries/security-levels";

/**
 * The ONE arm guard. Every path that puts a level in front of the scanner —
 * approval (lib/alerts/approve.ts) and reactivation
 * (lib/mutations/security-levels.ts::reactivateLevel) — asks this function
 * whether arming is safe, so the two can never drift on price resolution, on
 * the refusal rules or on when `armed_crossed_at` is stamped.
 *
 * Lives in its own module (reads only, imports lib/queries) so both callers
 * can import it without a cycle.
 *
 * The current price is resolved the exact way findCrossedLevels does
 * (getLatestScanPriceForSecurity) and the condition is evaluated through
 * checkLevelTriggerState — the scanner's own helper — so the guard and the
 * scanner cannot disagree about what "already hit" means.
 *
 * A level whose price is missing, stale, or unresolvable (an MA that needs
 * more history) is treated as NOT already-fired — matching what the scanner
 * itself would skip — and arms normally: it simply cannot be judged right now.
 *
 * Two refusals, both "no write should happen", both overridable with `force`:
 *  - would_fire_immediately: the condition already holds, so arming buys a
 *    guaranteed alert on the next scan.
 *  - beyond_scan_range: the level sits outside the scanner's plausibility
 *    band, so arming buys dead coverage — an alert that can never fire. The
 *    band forces `hit:false`, so the two are mutually exclusive and their
 *    order is not load-bearing.
 */
export type ArmGuardRefusalCode = "would_fire_immediately" | "beyond_scan_range";

export interface ArmGuardRefusal {
  code: ArmGuardRefusalCode;
  currentPrice: number;
  effectivePrice: number;
}

export interface ArmGuardVerdict {
  /** Non-null when the arm must be refused (the caller writes nothing). */
  refusal: ArmGuardRefusal | null;
  /**
   * What `armed_crossed_at` must become when the caller does arm: true only
   * for a FORCED arm of an already-crossed level (the push text on the Mac
   * and the Worker reads the stamp). False for a clean arm — which clears a
   * stale stamp from an earlier forced cycle — and for a forced arm of an
   * out-of-range level, where nothing was crossed.
   */
  stampCrossed: boolean;
}

/**
 * The SET fragment that applies `stampCrossed`. Bind one parameter: 1 to
 * stamp now, 0 to clear. Shared so both arming writes treat the stamp alike.
 */
export const ARMED_CROSSED_AT_SET_SQL =
  "armed_crossed_at = CASE WHEN ? THEN datetime('now') ELSE NULL END";

export function evaluateArmGuard(
  db: Database.Database,
  level: Pick<SecurityLevel, "id" | "security_id" | "level_type" | "price" | "price_source">,
  opts: { force?: boolean } = {}
): ArmGuardVerdict {
  const priceInfo = getLatestScanPriceForSecurity(db, level.security_id);
  if (priceInfo.currentPrice === null || !priceInfo.isFresh) {
    return { refusal: null, stampCrossed: false };
  }

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

  if (!opts.force && (state.hit || state.beyondScanRange)) {
    return {
      refusal: {
        code: state.hit ? "would_fire_immediately" : "beyond_scan_range",
        currentPrice: priceInfo.currentPrice,
        effectivePrice: state.effectivePrice as number,
      },
      stampCrossed: false,
    };
  }

  return { refusal: null, stampCrossed: state.hit };
}

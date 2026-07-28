import type Database from "better-sqlite3";
import type { SecurityLevel, LevelAlert, AlertResponse } from "@/lib/types";
import { resolveLevelPrice } from "@/lib/alerts/resolve-level-price";

// ─── Filter types ──────────────────────────────────────────────────

export interface LevelFilters {
  securityId?: number;
  isActive?: boolean;
  source?: string;
  onlyTriggered?: boolean;
  includeExpired?: boolean; // default false: filters out expires_at < today
}

export interface AlertFilters {
  securityId?: number;
  response?: AlertResponse;
  limit?: number;
}

// ─── Level queries ─────────────────────────────────────────────────

export function getLevelsForSecurity(
  db: Database.Database,
  securityId: number,
  opts: { activeOnly?: boolean } = {}
): SecurityLevel[] {
  const activeOnly = opts.activeOnly ?? true;
  const conditions = ["security_id = ?"];
  const params: (string | number)[] = [securityId];
  // activeOnly is the "armed" view (chart overlay, LevelsPanel default, chat
  // tool). Rejecting a reviewed level flips review_status but leaves
  // is_active=1, so the inclusive auto_approved whitelist (the same predicate
  // every scan query uses) is what keeps rejected/pending levels from
  // presenting as live S/R lines. activeOnly:false stays the full audit view.
  if (activeOnly) conditions.push("is_active = 1", "review_status = 'auto_approved'");
  return db
    .prepare(
      `SELECT * FROM security_levels
       WHERE ${conditions.join(" AND ")}
       ORDER BY price ASC`
    )
    .all(...params) as SecurityLevel[];
}

export function getActiveLevels(
  db: Database.Database,
  filters: LevelFilters = {}
): SecurityLevel[] {
  const conditions: string[] = ["is_active = 1"];
  const params: (string | number)[] = [];

  if (filters.securityId) {
    conditions.push("security_id = ?");
    params.push(filters.securityId);
  }
  if (filters.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }
  if (!filters.includeExpired) {
    conditions.push("(expires_at IS NULL OR expires_at >= date('now'))");
  }

  return db
    .prepare(
      `SELECT * FROM security_levels
       WHERE ${conditions.join(" AND ")}
       ORDER BY set_date DESC, id DESC`
    )
    .all(...params) as SecurityLevel[];
}

export function getLevelById(
  db: Database.Database,
  id: number
): SecurityLevel | null {
  return (
    (db
      .prepare("SELECT * FROM security_levels WHERE id = ?")
      .get(id) as SecurityLevel) ?? null
  );
}

/**
 * Find active levels that the latest price has crossed — candidates for alert insertion.
 * Excludes levels that are already triggered (is_active auto-flipped to 0 on trigger),
 * so this naturally handles dedup: re-activating a level is a user action.
 *
 * "Crossed" semantics by level_type:
 *   - 'support', 'entry', 'scale_in': triggered when current_price <= effective_price
 *     (price dropped to or through the level from above)
 *   - 'resistance', 'exit': triggered when current_price >= effective_price
 *   - 'stop': triggered when current_price <= effective_price (protective stop)
 *
 * Effective price: for static levels, the stored `price`. For MA-based levels,
 * the live MA computed from ohlcv_bars (returns null + skips level if bars are
 * insufficient — see resolveLevelPrice).
 *
 * Price source: primary is the `prices` table (portfolio securities). Falls
 * back to `benchmark_prices` for index ETFs the user tracks but doesn't hold
 * (DIA/VOO/etc.) — joined via the security's `symbol`.
 *
 * Stale-price guard: skips levels whose latest price is older than 4 calendar
 * days. 4 days tolerates both weekends (Fri → Mon = 3 days) and long-weekend
 * Mondays. Longer gaps mean TWS has been offline and prices are suspect, so
 * scanning them could produce spurious alerts from old crossings.
 *
 * Plausibility guard: skips levels whose effective price is more than 50%
 * away from the current price. A real hit is always detected within a few
 * percent of the level (scans run every 30 min); a level half or 10× the
 * price is a unit/scale error (SPX levels stored on SPY, per-contract vs
 * per-share) and would otherwise sit permanently "hit", re-firing after
 * every dismiss (QA 2026-07-06: SPY support @ $7,100 vs $748). Mirrored in
 * the Worker's isLevelCrossed (workers/cron/src/level-scan.ts) — keep the
 * threshold in sync.
 */
export const LEVEL_PLAUSIBILITY_MAX_DISTANCE = 0.5;
export function findCrossedLevels(
  db: Database.Database
): Array<SecurityLevel & { current_price: number; effective_price: number; price_date: string }> {
  const rows = db
    .prepare(
      `WITH latest_primary AS (
         SELECT p1.security_id, p1.close_price, p1.date
         FROM prices p1
         WHERE p1.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = p1.security_id)
       ),
       latest_benchmark AS (
         SELECT s.id AS security_id, bp.close_price, bp.date
         FROM securities s
         JOIN benchmark_prices bp ON bp.symbol = s.symbol
         WHERE bp.date = (SELECT MAX(bp2.date) FROM benchmark_prices bp2 WHERE bp2.symbol = bp.symbol)
       )
       SELECT sl.*,
         COALESCE(lp.close_price, lb.close_price) AS current_price,
         COALESCE(lp.date, lb.date) AS price_date,
         s.security_type AS sec_type
       FROM security_levels sl
       JOIN securities s ON s.id = sl.security_id
       LEFT JOIN latest_primary lp ON lp.security_id = sl.security_id
       LEFT JOIN latest_benchmark lb ON lb.security_id = sl.security_id
       WHERE sl.is_active = 1
         AND sl.review_status = 'auto_approved'
         AND (sl.expires_at IS NULL OR sl.expires_at >= date('now'))
         AND COALESCE(lp.close_price, lb.close_price) IS NOT NULL
         AND COALESCE(lp.date, lb.date) >= date('now', '-4 days')`
    )
    .all() as Array<SecurityLevel & { current_price: number; price_date: string; sec_type: string | null }>;

  const crossed: Array<SecurityLevel & { current_price: number; effective_price: number; price_date: string }> = [];

  for (const r of rows) {
    const effective = resolveLevelPrice(db, r);
    if (effective === null) continue; // MA can't be computed — skip rather than use stale snapshot
    // Options exempt from the plausibility guard: option premiums legitimately
    // double/halve overnight, so a real hit CAN first be seen >50% past the level.
    const isOption = r.sec_type?.toLowerCase() === "option";
    if (!isOption && Math.abs(r.current_price - effective) / effective > LEVEL_PLAUSIBILITY_MAX_DISTANCE) {
      console.warn(
        `[levels/scan] Skipping implausible level ${r.id} (${r.level_type} @ ${effective}) — current price ${r.current_price} is >${LEVEL_PLAUSIBILITY_MAX_DISTANCE * 100}% away (mis-scaled level?)`
      );
      continue;
    }
    const goingDown = ["support", "entry", "scale_in", "stop"].includes(r.level_type);
    const hit = goingDown
      ? r.current_price <= effective
      : r.current_price >= effective; // resistance, exit
    if (hit) {
      crossed.push({ ...r, effective_price: effective });
    }
  }

  return crossed;
}

// ─── Armed-levels view (U3: consolidated "what am I watching") ───────

/**
 * One armed price level, enriched for the Alerts-inbox "Armed" view:
 * symbol + security name, the effective threshold (static price, or the live
 * MA when price_source is an MA — null when history is insufficient), the
 * latest market price, and the signed distance from price to threshold.
 */
export interface ArmedLevel
  extends Pick<
    SecurityLevel,
    | "id"
    | "security_id"
    | "level_type"
    | "price"
    | "price_source"
    | "direction"
    | "action_hint"
    | "source"
    | "source_author"
    | "thesis"
    | "timeframe"
    | "set_date"
    | "expires_at"
  > {
  symbol: string;
  security_name: string | null;
  /** Static price, or the live MA value; null when an MA can't be computed. */
  effective_price: number | null;
  /** Latest close (prices, with benchmark_prices fallback); null if none. */
  current_price: number | null;
  /** (current − effective) / effective. null when either side is missing. */
  distance_pct: number | null;
}

/**
 * All currently-armed levels (is_active=1, auto_approved, unexpired) across
 * every security, enriched with symbol + effective threshold + current price +
 * distance, sorted nearest-to-trigger first (null distances last). Mirrors the
 * price/benchmark CTE + auto_approved whitelist that findCrossedLevels uses, but
 * keeps levels whose price is stale or whose MA can't resolve (the view should
 * still list them) rather than filtering them out.
 */
export function getArmedLevels(db: Database.Database): ArmedLevel[] {
  const rows = db
    .prepare(
      `WITH latest_primary AS (
         SELECT p1.security_id, p1.close_price, p1.date
         FROM prices p1
         WHERE p1.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = p1.security_id)
       ),
       latest_benchmark AS (
         SELECT s.id AS security_id, bp.close_price, bp.date
         FROM securities s
         JOIN benchmark_prices bp ON bp.symbol = s.symbol
         WHERE bp.date = (SELECT MAX(bp2.date) FROM benchmark_prices bp2 WHERE bp2.symbol = bp.symbol)
       )
       SELECT sl.*, s.symbol AS sym, s.name AS security_name,
         COALESCE(lp.close_price, lb.close_price) AS current_price
       FROM security_levels sl
       JOIN securities s ON s.id = sl.security_id
       LEFT JOIN latest_primary lp ON lp.security_id = sl.security_id
       LEFT JOIN latest_benchmark lb ON lb.security_id = sl.security_id
       WHERE sl.is_active = 1
         AND sl.review_status = 'auto_approved'
         AND (sl.expires_at IS NULL OR sl.expires_at >= date('now'))`
    )
    .all() as Array<
    SecurityLevel & {
      sym: string;
      security_name: string | null;
      current_price: number | null;
    }
  >;

  const out: ArmedLevel[] = rows.map((r) => {
    const effective_price =
      r.price_source === "static" ? r.price : resolveLevelPrice(db, r);
    const current_price = r.current_price ?? null;
    const distance_pct =
      current_price !== null && effective_price !== null && effective_price !== 0
        ? (current_price - effective_price) / effective_price
        : null;
    return {
      id: r.id,
      security_id: r.security_id,
      symbol: r.sym,
      security_name: r.security_name,
      level_type: r.level_type,
      price: r.price,
      price_source: r.price_source,
      effective_price,
      current_price,
      distance_pct,
      direction: r.direction,
      action_hint: r.action_hint,
      source: r.source,
      source_author: r.source_author,
      thesis: r.thesis,
      timeframe: r.timeframe,
      set_date: r.set_date,
      expires_at: r.expires_at,
    };
  });

  // Nearest-to-trigger first; levels with no computable distance sink to the
  // bottom, tie-broken by symbol for stable ordering.
  out.sort((a, b) => {
    const da = a.distance_pct === null ? Infinity : Math.abs(a.distance_pct);
    const db2 = b.distance_pct === null ? Infinity : Math.abs(b.distance_pct);
    if (da !== db2) return da - db2;
    return a.symbol.localeCompare(b.symbol);
  });

  return out;
}

// ─── Alert queries ─────────────────────────────────────────────────

export function getAlerts(
  db: Database.Database,
  filters: AlertFilters = {}
): LevelAlert[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.securityId) {
    conditions.push("security_id = ?");
    params.push(filters.securityId);
  }
  if (filters.response) {
    conditions.push("user_response = ?");
    params.push(filters.response);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 100;

  return db
    .prepare(
      `SELECT * FROM level_alerts ${where}
       ORDER BY triggered_at DESC
       LIMIT ?`
    )
    .all(...params, limit) as LevelAlert[];
}

/**
 * Count active, non-expired levels per security_id. Used by the calendar
 * cross-reference to show "N levels" chips on events with an associated
 * security — surfaces the earnings-vs-level combo that matters most for
 * short-term positioning decisions.
 */
export function getActiveLevelCountsForSecurityIds(
  db: Database.Database,
  securityIds: number[]
): Map<number, number> {
  const result = new Map<number, number>();
  if (securityIds.length === 0) return result;
  const placeholders = securityIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT security_id, COUNT(*) AS n
         FROM security_levels
        WHERE is_active = 1
          AND review_status = 'auto_approved'
          AND (expires_at IS NULL OR expires_at >= date('now'))
          AND security_id IN (${placeholders})
        GROUP BY security_id`
    )
    .all(...securityIds) as Array<{ security_id: number; n: number }>;
  for (const r of rows) result.set(r.security_id, r.n);
  return result;
}

/** Count of levels awaiting user review (newsletter-extracted, pending_review). */
export function getPendingReviewCount(db: Database.Database): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM security_levels WHERE review_status = 'pending_review'"
    )
    .get() as { n: number };
  return row.n;
}

/** Return all pending_review levels enriched with security info for the review inbox. */
export interface PendingReviewLevel extends SecurityLevel {
  symbol: string;
  security_name: string | null;
  current_price: number | null;
}

export function getPendingReviewLevels(db: Database.Database): PendingReviewLevel[] {
  return db
    .prepare(
      `SELECT sl.*, s.symbol, s.name AS security_name, p.close_price AS current_price
       FROM security_levels sl
       JOIN securities s ON s.id = sl.security_id
       LEFT JOIN (
         SELECT security_id, close_price
         FROM prices p1
         WHERE date = (SELECT MAX(date) FROM prices p2 WHERE p2.security_id = p1.security_id)
       ) p ON p.security_id = sl.security_id
       WHERE sl.review_status = 'pending_review'
       ORDER BY sl.created_at DESC`
    )
    .all() as PendingReviewLevel[];
}

export function getPendingAlertCount(db: Database.Database): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM level_alerts WHERE user_response = 'pending'"
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Check if an alert already exists today for the given level — dedup guard.
 * Used at insert time so a level that oscillates around its price doesn't fire repeatedly.
 * (Secondary safety net — the primary dedup is the is_active=0 flip on trigger.)
 */
export function hasAlertToday(
  db: Database.Database,
  levelId: number
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM level_alerts
       WHERE level_id = ? AND date(triggered_at) = date('now')
       LIMIT 1`
    )
    .get(levelId);
  return !!row;
}

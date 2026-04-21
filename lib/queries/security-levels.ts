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
  if (activeOnly) conditions.push("is_active = 1");
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
 */
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
         COALESCE(lp.date, lb.date) AS price_date
       FROM security_levels sl
       LEFT JOIN latest_primary lp ON lp.security_id = sl.security_id
       LEFT JOIN latest_benchmark lb ON lb.security_id = sl.security_id
       WHERE sl.is_active = 1
         AND (sl.expires_at IS NULL OR sl.expires_at >= date('now'))
         AND COALESCE(lp.close_price, lb.close_price) IS NOT NULL
         AND COALESCE(lp.date, lb.date) >= date('now', '-4 days')`
    )
    .all() as Array<SecurityLevel & { current_price: number; price_date: string }>;

  const crossed: Array<SecurityLevel & { current_price: number; effective_price: number; price_date: string }> = [];

  for (const r of rows) {
    const effective = resolveLevelPrice(db, r);
    if (effective === null) continue; // MA can't be computed — skip rather than use stale snapshot
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

import type Database from "better-sqlite3";

// ── Types ─────────────────────────────────────────────────────

export interface LevelTriggeredThisWeek {
  alert_id: number;
  symbol: string;
  security_name: string | null;
  triggered_at: string;
  triggered_price: number;
  level_type: string;
  level_price: number;
  direction: string | null;
  source: string;
  source_author: string | null;
  thesis: string | null;
  user_response: string;
  suggested_action: string | null;
}

export interface LevelNearPrice {
  level_id: number;
  security_id: number;
  symbol: string;
  security_name: string | null;
  level_type: string;
  level_price: number;
  current_price: number;
  distance_pct: number;  // signed: positive = price above level, negative = price below
  direction: string | null;
  source: string;
  source_author: string | null;
  thesis: string | null;
  action_hint: string | null;
}

// ── Queries ───────────────────────────────────────────────────

/**
 * Levels that were triggered in the past N days (default 7).
 * Used in the weekly briefing "Levels Hit This Week" section so the user
 * sees retrospective context: "Your $580 SPY short-term support from Eliant
 * was broken Monday — you dismissed the alert and price recovered."
 */
export function getLevelsTriggeredInWindow(
  db: Database.Database,
  days = 7
): LevelTriggeredThisWeek[] {
  return db
    .prepare(
      `SELECT
         a.id AS alert_id,
         s.symbol,
         s.name AS security_name,
         a.triggered_at,
         a.triggered_price,
         sl.level_type,
         sl.price AS level_price,
         sl.direction,
         sl.source,
         sl.source_author,
         sl.thesis,
         a.user_response,
         a.suggested_action
       FROM level_alerts a
       JOIN security_levels sl ON sl.id = a.level_id
       JOIN securities s ON s.id = a.security_id
       WHERE a.triggered_at >= datetime('now', ?)
       ORDER BY a.triggered_at DESC`
    )
    .all(`-${days} days`) as LevelTriggeredThisWeek[];
}

/**
 * Active levels where the current price is within `withinPct` of the level.
 * Used in the weekly briefing "Levels to Watch" section — gives the user a
 * forward-looking list of levels likely to trigger this week.
 *
 * Default 5% window catches most week-ahead relevant levels without flooding
 * the briefing with far-out targets.
 */
export function getLevelsNearPrice(
  db: Database.Database,
  withinPct = 0.05
): LevelNearPrice[] {
  return db
    .prepare(
      `SELECT
         sl.id AS level_id,
         s.id AS security_id,
         s.symbol,
         s.name AS security_name,
         sl.level_type,
         sl.price AS level_price,
         p.close_price AS current_price,
         ((p.close_price - sl.price) / sl.price) AS distance_pct,
         sl.direction,
         sl.source,
         sl.source_author,
         sl.thesis,
         sl.action_hint
       FROM security_levels sl
       JOIN securities s ON s.id = sl.security_id
       JOIN (
         SELECT security_id, close_price
         FROM prices p1
         WHERE date = (SELECT MAX(date) FROM prices p2 WHERE p2.security_id = p1.security_id)
       ) p ON p.security_id = sl.security_id
       WHERE sl.is_active = 1
         AND sl.review_status = 'auto_approved'
         AND (sl.expires_at IS NULL OR sl.expires_at >= date('now'))
         AND ABS((p.close_price - sl.price) / sl.price) <= ?
       ORDER BY ABS((p.close_price - sl.price) / sl.price) ASC`
    )
    .all(withinPct) as LevelNearPrice[];
}

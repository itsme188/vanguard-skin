import type Database from "better-sqlite3";

export interface WatchlistItem {
  id: number;
  security_id: number;
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  sector: string | null;
  added_date: string;
  price_target_low: number | null;
  price_target_high: number | null;
  thesis: string | null;
  is_active: number;
  created_at: string;
  group_name: string;
  current_price: number | null;
  price_date: string | null;
}

/** Active watchlist symbols, stock-like only, uppercase — the earnings-scan
 *  candidate shape (Wave 1 B10). */
export function getActiveWatchlistStockSymbols(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.symbol) AS symbol
         FROM watchlist w
         JOIN securities s ON s.id = w.security_id
        WHERE w.is_active = 1
          AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock')
          AND s.symbol IS NOT NULL AND s.symbol != ''
        ORDER BY symbol`,
    )
    .all() as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

export function getWatchlistGroups(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT group_name FROM watchlist
       WHERE is_active = 1 ORDER BY group_name`
    )
    .all() as { group_name: string }[];
  return rows.map((r) => r.group_name);
}

/**
 * Get all active watchlist items with security info and latest price.
 */
export function getActiveWatchlist(db: Database.Database): WatchlistItem[] {
  return db
    .prepare(
      `SELECT
        w.id, w.security_id, s.symbol, s.name AS security_name,
        s.security_type, s.sector,
        w.added_date, w.price_target_low, w.price_target_high,
        w.thesis, w.is_active, w.created_at, w.group_name,
        p.close_price AS current_price, p.date AS price_date
      FROM watchlist w
      JOIN securities s ON s.id = w.security_id
      LEFT JOIN prices p ON p.security_id = w.security_id
        AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = w.security_id)
      WHERE w.is_active = 1
      ORDER BY w.added_date DESC`
    )
    .all() as WatchlistItem[];
}

/**
 * Check if a security is on the active watchlist.
 */
export function isOnWatchlist(
  db: Database.Database,
  securityId: number
): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM watchlist WHERE security_id = ? AND is_active = 1"
    )
    .get(securityId);
  return !!row;
}

/**
 * Get a single watchlist item by security ID.
 */
export function getWatchlistItem(
  db: Database.Database,
  securityId: number
): WatchlistItem | null {
  return (
    (db
      .prepare(
        `SELECT
          w.id, w.security_id, s.symbol, s.name AS security_name,
          s.security_type, s.sector,
          w.added_date, w.price_target_low, w.price_target_high,
          w.thesis, w.is_active, w.created_at,
          p.close_price AS current_price, p.date AS price_date
        FROM watchlist w
        JOIN securities s ON s.id = w.security_id
        LEFT JOIN prices p ON p.security_id = w.security_id
          AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = w.security_id)
        WHERE w.security_id = ? AND w.is_active = 1`
      )
      .get(securityId) as WatchlistItem) ?? null
  );
}

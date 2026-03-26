import type Database from "better-sqlite3";
import type { OhlcvBar } from "@/lib/tws/types";

/**
 * Get stored OHLCV bars for a security, ordered by date ascending.
 * Returns data shaped for LightweightCharts CandlestickData.
 */
export function getOhlcvBars(
  db: Database.Database,
  securityId: number,
  barSize: string = "1 day",
  options?: { startDate?: string; endDate?: string; limit?: number },
): OhlcvBar[] {
  let sql = `
    SELECT bar_date as date, open, high, low, close, volume
    FROM ohlcv_bars
    WHERE security_id = ? AND bar_size = ?
  `;
  const params: (number | string)[] = [securityId, barSize];

  if (options?.startDate) {
    sql += " AND bar_date >= ?";
    params.push(options.startDate);
  }
  if (options?.endDate) {
    sql += " AND bar_date <= ?";
    params.push(options.endDate);
  }

  sql += " ORDER BY bar_date ASC";

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  return db.prepare(sql).all(...params) as OhlcvBar[];
}

/**
 * Get the latest bar date for a security+bar_size combo.
 * Used for incremental fetching (only fetch the gap).
 */
export function getLatestOhlcvDate(
  db: Database.Database,
  securityId: number,
  barSize: string = "1 day",
): string | null {
  const row = db
    .prepare(
      "SELECT MAX(bar_date) as latest FROM ohlcv_bars WHERE security_id = ? AND bar_size = ?",
    )
    .get(securityId, barSize) as { latest: string | null } | undefined;
  return row?.latest ?? null;
}

/** Security metadata for the chart security picker. */
export interface ChartableSecurity {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
}

/**
 * Get all securities that have an IB contract ID (chartable via TWS).
 * Excludes mutual funds (no TWS trade data).
 */
export function getChartableSecurities(
  db: Database.Database,
): ChartableSecurity[] {
  return db
    .prepare(
      `SELECT id, symbol, name, security_type
       FROM securities
       WHERE ib_con_id IS NOT NULL
         AND (security_type IS NULL OR security_type NOT IN ('mutual_fund'))
       ORDER BY symbol`,
    )
    .all() as ChartableSecurity[];
}

/**
 * Get the latest price for a security (from any source).
 */
export function getLatestPrice(
  db: Database.Database,
  securityId: number,
): { close_price: number; date: string } | null {
  return (
    db
      .prepare(
        "SELECT close_price, date FROM prices WHERE security_id = ? ORDER BY date DESC LIMIT 1",
      )
      .get(securityId) as { close_price: number; date: string } | undefined
  ) ?? null;
}

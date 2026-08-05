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
         AND (security_type IS NULL OR LOWER(security_type) NOT IN ('mutual_fund', 'mutual fund'))
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
        `SELECT p.close_price * COALESCE(fx.usd_per_unit, 1) AS close_price, p.date
         FROM prices p
         JOIN securities s ON s.id = p.security_id
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
         WHERE p.security_id = ?
         ORDER BY p.date DESC LIMIT 1`,
      )
      .get(securityId) as { close_price: number; date: string } | undefined
  ) ?? null;
}

/**
 * NATIVE-frame sibling of getLatestPrice — no FX conversion. prices rows are
 * stored in the security's native currency, so this is the frame ohlcv_bars
 * live in. Use it whenever the price feeds math AGAINST bars (pivot levels,
 * ATR, distance %) per the chart-adjacent display pattern: compute native,
 * convert only at dollar-text render sites via usdPerUnit.
 */
export function getLatestPriceNative(
  db: Database.Database,
  securityId: number,
): { close_price: number; date: string } | null {
  return (
    db
      .prepare(
        `SELECT close_price, date FROM prices
         WHERE security_id = ?
         ORDER BY date DESC LIMIT 1`,
      )
      .get(securityId) as { close_price: number; date: string } | undefined
  ) ?? null;
}

/**
 * Get the most recent daily bar for a security. "Today" here means "the
 * freshest bar we have" — the table usually lags by one close, and on
 * weekends/holidays it may lag by several days. Callers should show the
 * returned date as the "as of" label.
 */
export function getLatestDailyBar(
  db: Database.Database,
  securityId: number,
): { date: string; open: number; high: number; low: number; close: number; volume: number | null } | null {
  return (
    db
      .prepare(
        `SELECT bar_date as date, open, high, low, close, volume
         FROM ohlcv_bars
         WHERE security_id = ? AND bar_size = '1 day'
         ORDER BY bar_date DESC
         LIMIT 1`,
      )
      .get(securityId) as
      | { date: string; open: number; high: number; low: number; close: number; volume: number | null }
      | undefined
  ) ?? null;
}

/**
 * 52-week high/low from ohlcv_bars. Trailing window based on the DB's most
 * recent bar date, not calendar today — otherwise a 3-day weekend drops us
 * out of range. Returns null when fewer than 10 bars exist (arbitrary floor
 * — below that, "range" is just noise).
 */
export function get52WeekRange(
  db: Database.Database,
  securityId: number,
): { high: number; low: number; startDate: string; endDate: string } | null {
  const row = db
    .prepare(
      `SELECT
        MAX(high) AS high,
        MIN(low) AS low,
        MIN(bar_date) AS startDate,
        MAX(bar_date) AS endDate,
        COUNT(*) AS n
       FROM ohlcv_bars
       WHERE security_id = ?
         AND bar_size = '1 day'
         AND bar_date >= date(
           (SELECT MAX(bar_date) FROM ohlcv_bars WHERE security_id = ? AND bar_size = '1 day'),
           '-365 days'
         )`,
    )
    .get(securityId, securityId) as
    | { high: number | null; low: number | null; startDate: string | null; endDate: string | null; n: number }
    | undefined;

  if (!row || row.high == null || row.low == null || row.n < 10) return null;
  return {
    high: row.high,
    low: row.low,
    startDate: row.startDate as string,
    endDate: row.endDate as string,
  };
}

import type Database from "better-sqlite3";

export interface BenchmarkPrice {
  date: string;
  close_price: number;
}

/**
 * Get benchmark prices for a symbol within a date range.
 */
export function getBenchmarkPrices(
  db: Database.Database,
  symbol: string,
  options?: { startDate?: string; endDate?: string }
): BenchmarkPrice[] {
  const conditions = ["symbol = ?"];
  const params: string[] = [symbol];

  if (options?.startDate) {
    conditions.push("date >= ?");
    params.push(options.startDate);
  }
  if (options?.endDate) {
    conditions.push("date <= ?");
    params.push(options.endDate);
  }

  return db
    .prepare(
      `SELECT date, close_price
       FROM benchmark_prices
       WHERE ${conditions.join(" AND ")}
       ORDER BY date ASC`
    )
    .all(...params) as BenchmarkPrice[];
}

/**
 * Get available benchmark symbols that have data.
 */
export function getAvailableBenchmarks(
  db: Database.Database
): { symbol: string; count: number; minDate: string; maxDate: string }[] {
  return db
    .prepare(
      `SELECT symbol, COUNT(*) AS count, MIN(date) AS minDate, MAX(date) AS maxDate
       FROM benchmark_prices
       GROUP BY symbol
       ORDER BY symbol`
    )
    .all() as { symbol: string; count: number; minDate: string; maxDate: string }[];
}

import type Database from "better-sqlite3";

export interface AnalystRecommendation {
  symbol: string;
  period: string;
  strong_buy: number;
  buy: number;
  hold: number;
  sell: number;
  strong_sell: number;
  cached_at: string;
}

export interface AnalystPriceTarget {
  symbol: string;
  target_high: number | null;
  target_low: number | null;
  target_mean: number | null;
  target_median: number | null;
  number_of_analysts: number | null;
  last_updated: string | null;
  cached_at: string;
}

export interface AnalystRatingChange {
  id: number;
  symbol: string;
  rating_date: string;
  firm: string | null;
  from_grade: string | null;
  to_grade: string;
  action: string | null;
  cached_at: string;
}

// ─── Recommendation trend ────────────────────────────────────────

export function getRecommendationHistory(
  db: Database.Database,
  symbol: string,
  limit: number = 12,
): AnalystRecommendation[] {
  return db
    .prepare(
      `SELECT symbol, period, strong_buy, buy, hold, sell, strong_sell, cached_at
       FROM analyst_recommendations
       WHERE symbol = ?
       ORDER BY period DESC
       LIMIT ?`,
    )
    .all(symbol.toUpperCase(), Math.max(1, Math.min(limit, 60))) as AnalystRecommendation[];
}

export function getLatestRecommendation(
  db: Database.Database,
  symbol: string,
): AnalystRecommendation | null {
  const row = db
    .prepare(
      `SELECT symbol, period, strong_buy, buy, hold, sell, strong_sell, cached_at
       FROM analyst_recommendations
       WHERE symbol = ?
       ORDER BY period DESC
       LIMIT 1`,
    )
    .get(symbol.toUpperCase()) as AnalystRecommendation | undefined;
  return row ?? null;
}

// ─── Price target ────────────────────────────────────────────────

export function getPriceTarget(
  db: Database.Database,
  symbol: string,
): AnalystPriceTarget | null {
  const row = db
    .prepare(
      `SELECT symbol, target_high, target_low, target_mean, target_median,
              number_of_analysts, last_updated, cached_at
       FROM analyst_price_targets
       WHERE symbol = ?`,
    )
    .get(symbol.toUpperCase()) as AnalystPriceTarget | undefined;
  return row ?? null;
}

// ─── Rating changes ──────────────────────────────────────────────

export function getRatingChanges(
  db: Database.Database,
  symbol: string,
  limit: number = 20,
): AnalystRatingChange[] {
  return db
    .prepare(
      `SELECT id, symbol, rating_date, firm, from_grade, to_grade, action, cached_at
       FROM analyst_rating_changes
       WHERE symbol = ?
       ORDER BY rating_date DESC, id DESC
       LIMIT ?`,
    )
    .all(symbol.toUpperCase(), Math.max(1, Math.min(limit, 200))) as AnalystRatingChange[];
}

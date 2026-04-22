import type Database from "better-sqlite3";

// ─── Recommendation trend (monthly) ──────────────────────────────

export interface RecommendationInput {
  symbol: string;
  period: string; // YYYY-MM-DD (first of month)
  strong_buy: number;
  buy: number;
  hold: number;
  sell: number;
  strong_sell: number;
}

export function upsertRecommendation(
  db: Database.Database,
  input: RecommendationInput,
): number {
  const result = db
    .prepare(
      `INSERT INTO analyst_recommendations (
         symbol, period, strong_buy, buy, hold, sell, strong_sell
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, period) DO UPDATE SET
         strong_buy = excluded.strong_buy,
         buy = excluded.buy,
         hold = excluded.hold,
         sell = excluded.sell,
         strong_sell = excluded.strong_sell,
         cached_at = datetime('now')`,
    )
    .run(
      input.symbol.toUpperCase(),
      input.period,
      input.strong_buy,
      input.buy,
      input.hold,
      input.sell,
      input.strong_sell,
    );
  return result.lastInsertRowid as number;
}

// ─── Price target (overwrite per symbol) ─────────────────────────

export interface PriceTargetInput {
  symbol: string;
  target_high: number | null;
  target_low: number | null;
  target_mean: number | null;
  target_median: number | null;
  number_of_analysts: number | null;
  last_updated: string | null;
}

export function upsertPriceTarget(
  db: Database.Database,
  input: PriceTargetInput,
): void {
  db.prepare(
    `INSERT INTO analyst_price_targets (
       symbol, target_high, target_low, target_mean, target_median,
       number_of_analysts, last_updated
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       target_high = excluded.target_high,
       target_low = excluded.target_low,
       target_mean = excluded.target_mean,
       target_median = excluded.target_median,
       number_of_analysts = excluded.number_of_analysts,
       last_updated = excluded.last_updated,
       cached_at = datetime('now')`,
  ).run(
    input.symbol.toUpperCase(),
    input.target_high,
    input.target_low,
    input.target_mean,
    input.target_median,
    input.number_of_analysts,
    input.last_updated,
  );
}

// ─── Rating changes (event stream) ───────────────────────────────

export interface RatingChangeInput {
  symbol: string;
  rating_date: string;
  firm: string | null;
  from_grade: string | null;
  to_grade: string;
  action: string | null;
}

export function upsertRatingChange(
  db: Database.Database,
  input: RatingChangeInput,
): number {
  const result = db
    .prepare(
      `INSERT INTO analyst_rating_changes (
         symbol, rating_date, firm, from_grade, to_grade, action
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, rating_date, firm, to_grade) DO UPDATE SET
         from_grade = excluded.from_grade,
         action = excluded.action,
         cached_at = datetime('now')`,
    )
    .run(
      input.symbol.toUpperCase(),
      input.rating_date,
      input.firm,
      input.from_grade,
      input.to_grade,
      input.action,
    );
  return result.lastInsertRowid as number;
}

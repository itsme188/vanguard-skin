import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "../valuation";
import { resolveTradingDayPair } from "../digest/anomalies";

export interface TodayHolding {
  security_id: number;
  symbol: string;
  security_name: string | null;
  quantity: number;
  current_price: number | null;
  current_value: number | null;
  prior_close: number | null;
  today_gain: number | null;
  today_pct: number | null;
  price_date: string | null;
  price_source: string | null;
}

/**
 * IBKR holdings for the Today view, with "today's move" computed on ONE
 * consecutive trading-day pair resolved from SPY (resolveTradingDayPair —
 * the anomaly-engine convention), never on a bare rn=1/rn=2 row pairing.
 *
 * Why: quote enrichment historically wrote weekend/Monday-before-open
 * `prices` rows carrying a stale last price, so the two most-recent rows per
 * security could be byte-identical non-trading-day phantoms — every position
 * then read exactly $0 / 0.00% while real ±2-3% moves were hidden. Pinning
 * the pair to trading days makes phantom rows harmless; a security missing a
 * close on either pair date gets a null move (honest), not a fake zero.
 *
 * Current price/value deliberately still use the FRESHEST price row (rn=1):
 * a weekend row carrying Friday's true close is the best value estimate even
 * though it must never form a move pair.
 */
export function getIbkrTodayHoldings(
  db: Database.Database,
  accountId: number,
): TodayHolding[] {
  const pair = resolveTradingDayPair(db);
  // Sentinel dates match no rows → move columns fall through to null.
  const pairLatest = pair?.latest ?? "";
  const pairPrior = pair?.prior ?? "";

  const marketValueCurrent = adjustedMarketValueSQL(
    "h.quantity",
    "p_today.close_price",
    "s.security_type",
    "COALESCE(s.multiplier, 1)",
    "COALESCE(fx.usd_per_unit, 1)",
  );
  const marketValuePairLatest = adjustedMarketValueSQL(
    "h.quantity",
    "p_pair.close_price",
    "s.security_type",
    "COALESCE(s.multiplier, 1)",
    "COALESCE(fx.usd_per_unit, 1)",
  );
  const marketValuePairPrior = adjustedMarketValueSQL(
    "h.quantity",
    "p_prior.close_price",
    "s.security_type",
    "COALESCE(s.multiplier, 1)",
    "COALESCE(fx.usd_per_unit, 1)",
  );

  return db
    .prepare(
      `WITH ranked_prices AS (
         SELECT security_id, date, close_price, source,
                ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY date DESC) AS rn
         FROM prices
       )
       SELECT
         h.security_id,
         s.symbol,
         s.name AS security_name,
         h.quantity,
         p_today.close_price * COALESCE(fx.usd_per_unit, 1) AS current_price,
         p_today.date AS price_date,
         p_today.source AS price_source,
         p_prior.close_price * COALESCE(fx.usd_per_unit, 1) AS prior_close,
         CASE WHEN p_today.close_price IS NOT NULL THEN ${marketValueCurrent} ELSE NULL END AS current_value,
         CASE WHEN p_pair.close_price IS NOT NULL AND p_prior.close_price IS NOT NULL
           THEN ${marketValuePairLatest} - ${marketValuePairPrior} ELSE NULL END AS today_gain,
         CASE WHEN p_pair.close_price IS NOT NULL AND p_prior.close_price IS NOT NULL
                AND p_prior.close_price != 0
           THEN (p_pair.close_price - p_prior.close_price) / p_prior.close_price ELSE NULL END AS today_pct
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN ranked_prices p_today ON p_today.security_id = h.security_id AND p_today.rn = 1
       LEFT JOIN prices p_pair ON p_pair.security_id = h.security_id AND p_pair.date = ?
       LEFT JOIN prices p_prior ON p_prior.security_id = h.security_id AND p_prior.date = ?
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE h.account_id = ?
         AND h.quantity > 0
         AND h.as_of_date = (SELECT MAX(as_of_date) FROM holdings WHERE account_id = ?)
         AND (s.maturity_date IS NULL OR s.maturity_date >= date('now')
              OR LOWER(s.security_type) = 'bond')
       ORDER BY ABS(COALESCE(today_gain, 0)) DESC`,
    )
    .all(pairLatest, pairPrior, accountId, accountId) as TodayHolding[];
}

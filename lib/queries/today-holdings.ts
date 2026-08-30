import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "../valuation";
import { resolveTradingDayPair } from "../digest/anomalies";
import { latestHoldingsPredicate } from "./latest-holdings";

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
/**
 * An option's stored pair-date close can be a stale pre-move intraday quote
 * stamped on the same date as the underlying's true (post-move) close — the
 * pair dates are consecutive, so the trading-day pair can't catch it, and
 * magnitude thresholds are off the table (premiums legitimately double).
 * The tell is an arbitrage violation: an option close sitting far below its
 * intrinsic value at the SAME date's underlying close. Differencing against
 * such a row books the underlying's whole gap as "today" (the APP $390 put
 * showed +208% while APP itself moved +0.43%). The 10% margin tolerates the
 * small legitimate below-intrinsic discount deep-ITM American options carry.
 */
const INTRINSIC_VIOLATION_FRACTION = 0.9;

function violatesIntrinsic(
  optionClose: number | null,
  optionType: string | null,
  strike: number | null,
  underlyingClose: number | null,
): boolean {
  if (
    optionClose == null ||
    underlyingClose == null ||
    strike == null ||
    !optionType
  ) {
    return false;
  }
  const type = optionType.toLowerCase();
  const intrinsic =
    type === "put"
      ? strike - underlyingClose
      : type === "call"
        ? underlyingClose - strike
        : 0;
  if (intrinsic <= 0) return false;
  return optionClose < intrinsic * INTRINSIC_VIOLATION_FRACTION;
}

interface TodayHoldingRow extends TodayHolding {
  option_type: string | null;
  strike_price: number | null;
  pair_latest_close: number | null;
  pair_prior_close: number | null;
  underlying_pair_close: number | null;
  underlying_prior_close: number | null;
}

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

  const rows = db
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
         s.option_type,
         s.strike_price,
         p_today.close_price * COALESCE(fx.usd_per_unit, 1) AS current_price,
         p_today.date AS price_date,
         p_today.source AS price_source,
         p_prior.close_price * COALESCE(fx.usd_per_unit, 1) AS prior_close,
         p_pair.close_price AS pair_latest_close,
         p_prior.close_price AS pair_prior_close,
         pu_pair.close_price AS underlying_pair_close,
         pu_prior.close_price AS underlying_prior_close,
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
       LEFT JOIN securities s_u ON LOWER(s.security_type) = 'option' AND s_u.symbol = s.underlying_symbol
       LEFT JOIN prices pu_pair ON pu_pair.security_id = s_u.id AND pu_pair.date = ?
       LEFT JOIN prices pu_prior ON pu_prior.security_id = s_u.id AND pu_prior.date = ?
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE h.account_id = ?
         AND ${latestHoldingsPredicate({ includeShorts: false, accountFilter: "" })}
         AND (s.maturity_date IS NULL OR s.maturity_date >= date('now')
              OR LOWER(s.security_type) = 'bond')
       ORDER BY ABS(COALESCE(today_gain, 0)) DESC`,
    )
    .all(
      pairLatest,
      pairPrior,
      pairLatest,
      pairPrior,
      accountId,
    ) as TodayHoldingRow[];

  const cleaned = rows.map((row) => {
    const {
      option_type,
      strike_price,
      pair_latest_close,
      pair_prior_close,
      underlying_pair_close,
      underlying_prior_close,
      ...holding
    } = row;
    const staleQuote =
      violatesIntrinsic(pair_prior_close, option_type, strike_price, underlying_prior_close) ||
      violatesIntrinsic(pair_latest_close, option_type, strike_price, underlying_pair_close);
    if (staleQuote) {
      holding.today_gain = null;
      holding.today_pct = null;
    }
    return holding;
  });

  // Re-sort: a suppressed move must not keep its pre-suppression rank.
  return cleaned.sort(
    (a, b) => Math.abs(b.today_gain ?? 0) - Math.abs(a.today_gain ?? 0),
  );
}

import type Database from "better-sqlite3";
import { getDailyValuationsCombined, getDailyValuationsByAccount } from "@/lib/queries/daily-valuations";
import { adjustedMarketValueSQL } from "@/lib/valuation";

// ─── Types ─────────────��────────────────────────────────────────

export interface MarketRegression {
  beta: number;
  alpha: number; // annualized
  rSquared: number;
  trackingError: number; // annualized
  correlation: number;
  dataPoints: number;
}

export interface FactorTilt {
  dimension: string;
  buckets: { label: string; weight: number }[];
}

export interface FactorAnalysisResult {
  marketRegression: MarketRegression | null;
  sizeTilt: FactorTilt | null;
  styleTilt: FactorTilt | null;
  sectorTilt: FactorTilt | null;
  geographyTilt: FactorTilt | null;
}

export interface FactorOptions {
  accountId?: number;
  benchmarkSymbol?: string; // default "SPY"
}

// ─── Constants ──────────────────��───────────────────────────────

const TRADING_DAYS_PER_YEAR = 252;

// ─── Market Beta Regression ──────────────────────────���───────────

/**
 * Regress portfolio daily returns against benchmark (SPY) returns.
 * Returns beta, alpha, R², tracking error, and correlation.
 */
function computeMarketRegression(
  db: Database.Database,
  options?: FactorOptions
): MarketRegression | null {
  const benchmarkSymbol = options?.benchmarkSymbol ?? "SPY";

  // 1. Get portfolio daily valuations
  const valuations = options?.accountId
    ? getDailyValuationsByAccount(db, options.accountId)
    : getDailyValuationsCombined(db);

  if (valuations.length < 30) return null;

  // Build date → total_value map
  const portfolioByDate = new Map<string, number>();
  for (const v of valuations) {
    portfolioByDate.set(v.valuation_date, v.total_value);
  }

  // 2. Get benchmark prices
  const benchmarkRows = db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = ?
       ORDER BY date ASC`
    )
    .all(benchmarkSymbol) as { date: string; close_price: number }[];

  if (benchmarkRows.length < 30) return null;

  const benchmarkByDate = new Map<string, number>();
  for (const b of benchmarkRows) {
    benchmarkByDate.set(b.date, b.close_price);
  }

  // 3. Compute aligned daily returns
  const allDates = [...portfolioByDate.keys()]
    .filter((d) => benchmarkByDate.has(d))
    .sort();

  const portfolioReturns: number[] = [];
  const benchmarkReturns: number[] = [];

  for (let i = 1; i < allDates.length; i++) {
    const prevDate = allDates[i - 1];
    const currDate = allDates[i];

    const pPrev = portfolioByDate.get(prevDate)!;
    const pCurr = portfolioByDate.get(currDate)!;
    const bPrev = benchmarkByDate.get(prevDate)!;
    const bCurr = benchmarkByDate.get(currDate)!;

    if (pPrev > 0 && pCurr > 0 && bPrev > 0 && bCurr > 0) {
      portfolioReturns.push(Math.log(pCurr / pPrev));
      benchmarkReturns.push(Math.log(bCurr / bPrev));
    }
  }

  if (portfolioReturns.length < 20) return null;

  // 4. Linear regression: Rp = alpha + beta * Rm
  const n = portfolioReturns.length;
  const meanP = portfolioReturns.reduce((s, v) => s + v, 0) / n;
  const meanB = benchmarkReturns.reduce((s, v) => s + v, 0) / n;

  let covPB = 0;
  let varB = 0;
  let varP = 0;

  for (let i = 0; i < n; i++) {
    const dP = portfolioReturns[i] - meanP;
    const dB = benchmarkReturns[i] - meanB;
    covPB += dP * dB;
    varB += dB * dB;
    varP += dP * dP;
  }

  if (varB === 0) return null;

  const beta = covPB / varB;
  const dailyAlpha = meanP - beta * meanB;
  const alpha = dailyAlpha * TRADING_DAYS_PER_YEAR; // annualize

  // R² = correlation²
  const denom = Math.sqrt(varP * varB);
  const correlation = denom > 0 ? covPB / denom : 0;
  const rSquared = correlation * correlation;

  // Tracking error = std dev of (Rp - beta * Rm)
  const residuals = portfolioReturns.map(
    (rp, i) => rp - dailyAlpha - beta * benchmarkReturns[i]
  );
  const residualVar =
    residuals.reduce((s, r) => s + r * r, 0) / (n - 2); // degrees of freedom = n-2
  const trackingError = Math.sqrt(residualVar) * Math.sqrt(TRADING_DAYS_PER_YEAR);

  return {
    beta,
    alpha,
    rSquared,
    trackingError,
    correlation,
    dataPoints: n,
  };
}

// ─── Portfolio Tilts ─────────────────────────────────────────────

function computeTilts(
  db: Database.Database,
  accountId?: number
): { sizeTilt: FactorTilt | null; styleTilt: FactorTilt | null; sectorTilt: FactorTilt | null; geographyTilt: FactorTilt | null } {
  const accountFilter = accountId ? "AND h.account_id = ?" : "";
  const accountParams: number[] = accountId ? [accountId] : [];

  const rows = db
    .prepare(
      `WITH latest_holdings AS (
         SELECT h.security_id, SUM(h.quantity) AS total_qty
         FROM holdings h
         WHERE h.as_of_date = (
           SELECT MAX(h2.as_of_date) FROM holdings h2
           WHERE h2.account_id = h.account_id
         )
         ${accountFilter}
         GROUP BY h.security_id
       ),
       latest_prices AS (
         SELECT security_id, close_price
         FROM prices
         WHERE (security_id, date) IN (
           SELECT security_id, MAX(date) FROM prices GROUP BY security_id
         )
       )
       SELECT
         s.market_cap_category,
         s.style,
         s.sector,
         s.geography,
         CASE
           WHEN s.security_type = 'bond'
             THEN lh.total_qty * COALESCE(lp.close_price, 0) / 100.0
           ELSE lh.total_qty * COALESCE(lp.close_price, 0) * COALESCE(s.multiplier, 1)
         END AS market_value
       FROM latest_holdings lh
       JOIN securities s ON s.id = lh.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
       WHERE COALESCE(lp.close_price, 0) > 0`
    )
    .all(...accountParams) as {
    market_cap_category: string | null;
    style: string | null;
    sector: string | null;
    geography: string | null;
    market_value: number;
  }[];

  if (rows.length === 0) {
    return { sizeTilt: null, styleTilt: null, sectorTilt: null, geographyTilt: null };
  }

  const totalValue = rows.reduce((s, r) => s + r.market_value, 0);
  if (totalValue <= 0) {
    return { sizeTilt: null, styleTilt: null, sectorTilt: null, geographyTilt: null };
  }

  function buildTilt(
    dimension: string,
    getter: (row: (typeof rows)[0]) => string | null
  ): FactorTilt | null {
    const bucketMap = new Map<string, number>();
    let classified = 0;

    for (const row of rows) {
      const label = getter(row) ?? "Unclassified";
      bucketMap.set(label, (bucketMap.get(label) ?? 0) + row.market_value);
      if (getter(row)) classified += row.market_value;
    }

    // Don't return tilt if <30% of portfolio is classified
    if (classified / totalValue < 0.3) return null;

    const buckets = [...bucketMap.entries()]
      .map(([label, value]) => ({ label, weight: value / totalValue }))
      .sort((a, b) => b.weight - a.weight);

    return { dimension, buckets };
  }

  return {
    sizeTilt: buildTilt("Size", (r) => r.market_cap_category),
    styleTilt: buildTilt("Style", (r) => r.style),
    sectorTilt: buildTilt("Sector", (r) => r.sector),
    geographyTilt: buildTilt("Geography", (r) => r.geography),
  };
}

// ─── Main entry point ───────────────────��────────────────────────

export function computeFactorAnalysis(
  db: Database.Database,
  options?: FactorOptions
): FactorAnalysisResult {
  const marketRegression = computeMarketRegression(db, options);
  const { sizeTilt, styleTilt, sectorTilt, geographyTilt } = computeTilts(
    db,
    options?.accountId
  );

  return { marketRegression, sizeTilt, styleTilt, sectorTilt, geographyTilt };
}

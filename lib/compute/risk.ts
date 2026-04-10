import type Database from "better-sqlite3";
import { getDailyValuationsCombined, getDailyValuationsByAccount } from "@/lib/queries/daily-valuations";
import { adjustedMarketValueSQL } from "@/lib/valuation";

// ─── Types ──────────────────────────────────────────────────────

export interface DrawdownInfo {
  percent: number;
  peakDate: string;
  troughDate: string;
  peakValue: number;
  troughValue: number;
}

export interface CurrentDrawdownInfo {
  percent: number;
  peakDate: string;
  peakValue: number;
  currentValue: number;
}

export interface PositionWeight {
  symbol: string;
  securityName: string | null;
  marketValue: number;
  weight: number; // 0-1
}

export interface PortfolioRiskMetrics {
  maxDrawdown: DrawdownInfo | null;
  currentDrawdown: CurrentDrawdownInfo | null;
  volatility: number | null; // annualized
  sharpeRatio: number | null; // null if < 30 days of data
  herfindahl: number | null; // 0-1 (1 = single position)
  top5Concentration: number; // 0-1
  top5Positions: PositionWeight[];
  positionCount: number;
  dataPoints: number; // number of daily valuations used
}

export interface RiskOptions {
  startDate?: string;
  endDate?: string;
  accountId?: number;
  riskFreeRate?: number; // annualized, default 0.045 (4.5%)
}

export interface PositionRisk {
  securityId: number;
  symbol: string;
  securityName: string | null;
  weight: number;
  annualizedVol: number | null;
  riskContribution: number | null; // marginal contribution to portfolio vol
  correlationWithPortfolio: number | null;
  dataPoints: number;
}

export interface CorrelationEntry {
  symbolA: string;
  symbolB: string;
  correlation: number;
}

export interface PositionRiskResult {
  positions: PositionRisk[];
  correlations: CorrelationEntry[];
  portfolioVol: number | null;
}

// ─── Constants ──────────────────────────────────────────────────

const TRADING_DAYS_PER_YEAR = 252;
const DEFAULT_RISK_FREE_RATE = 0.045;

// ─── Core computation ───────────────────────────────────────────

export function computeRiskMetrics(
  db: Database.Database,
  options?: RiskOptions
): PortfolioRiskMetrics {
  const riskFreeRate = options?.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;

  // 1. Get daily valuations
  const valuations = options?.accountId
    ? getDailyValuationsByAccount(db, options.accountId, {
        startDate: options?.startDate,
        endDate: options?.endDate,
      })
    : getDailyValuationsCombined(db, {
        startDate: options?.startDate,
        endDate: options?.endDate,
      });

  // 2. Compute drawdown and return metrics from valuations
  const maxDrawdown = computeMaxDrawdown(valuations.map(v => ({ date: v.valuation_date, value: v.total_value })));
  const currentDrawdown = computeCurrentDrawdown(valuations.map(v => ({ date: v.valuation_date, value: v.total_value })));
  const { volatility, sharpeRatio } = computeVolatility(
    valuations.map(v => v.total_value),
    riskFreeRate
  );

  // 3. Compute concentration from current holdings
  const { herfindahl, top5Concentration, top5Positions, positionCount } =
    computeConcentration(db, options?.accountId);

  return {
    maxDrawdown,
    currentDrawdown,
    volatility,
    sharpeRatio,
    herfindahl,
    top5Concentration,
    top5Positions,
    positionCount,
    dataPoints: valuations.length,
  };
}

// ─── Max Drawdown ───────────────────────────────────────────────

function computeMaxDrawdown(
  series: { date: string; value: number }[]
): DrawdownInfo | null {
  if (series.length < 2) return null;

  let peak = series[0].value;
  let peakDate = series[0].date;
  let maxDd = 0;
  let maxDdPeakDate = series[0].date;
  let maxDdPeakValue = series[0].value;
  let maxDdTroughDate = series[0].date;
  let maxDdTroughValue = series[0].value;

  for (const point of series) {
    if (point.value > peak) {
      peak = point.value;
      peakDate = point.date;
    }
    const dd = peak > 0 ? (peak - point.value) / peak : 0;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPeakDate = peakDate;
      maxDdPeakValue = peak;
      maxDdTroughDate = point.date;
      maxDdTroughValue = point.value;
    }
  }

  if (maxDd === 0) return null;

  return {
    percent: maxDd,
    peakDate: maxDdPeakDate,
    troughDate: maxDdTroughDate,
    peakValue: maxDdPeakValue,
    troughValue: maxDdTroughValue,
  };
}

// ─── Current Drawdown ───────────────────────────────────────────

function computeCurrentDrawdown(
  series: { date: string; value: number }[]
): CurrentDrawdownInfo | null {
  if (series.length < 2) return null;

  let peak = 0;
  let peakDate = series[0].date;

  for (const point of series) {
    if (point.value > peak) {
      peak = point.value;
      peakDate = point.date;
    }
  }

  const current = series[series.length - 1].value;
  const dd = peak > 0 ? (peak - current) / peak : 0;

  if (dd === 0) return null;

  return {
    percent: dd,
    peakDate,
    peakValue: peak,
    currentValue: current,
  };
}

// ─── Volatility & Sharpe ────────────────────────────────────────

function computeVolatility(
  values: number[],
  riskFreeRate: number
): { volatility: number | null; sharpeRatio: number | null } {
  if (values.length < 30) return { volatility: null, sharpeRatio: null };

  // Compute daily log returns
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0 && values[i] > 0) {
      returns.push(Math.log(values[i] / values[i - 1]));
    }
  }

  if (returns.length < 20) return { volatility: null, sharpeRatio: null };

  // Mean daily return
  const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;

  // Standard deviation of daily returns
  const variance =
    returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1);
  const dailyStdDev = Math.sqrt(variance);

  // Annualize
  const volatility = dailyStdDev * Math.sqrt(TRADING_DAYS_PER_YEAR);
  const annualizedReturn = meanReturn * TRADING_DAYS_PER_YEAR;

  // Sharpe ratio
  const sharpeRatio =
    volatility > 0 ? (annualizedReturn - riskFreeRate) / volatility : null;

  return { volatility, sharpeRatio };
}

// ─── Concentration (Herfindahl & Top-5) ─────────────────────────

function computeConcentration(
  db: Database.Database,
  accountId?: number
): {
  herfindahl: number | null;
  top5Concentration: number;
  top5Positions: PositionWeight[];
  positionCount: number;
} {
  const mvExpr = adjustedMarketValueSQL(
    "h.quantity",
    "p.close_price",
    "s.security_type",
    "COALESCE(s.multiplier, 1)"
  );

  const accountFilter = accountId ? "AND h.account_id = ?" : "";
  const accountParams: number[] = accountId ? [accountId] : [];

  // Get latest holdings with current prices, compute market value
  const rows = db
    .prepare(
      `WITH latest_holdings AS (
         SELECT h.security_id, h.account_id, h.quantity, s.symbol, s.name, s.security_type,
                COALESCE(s.multiplier, 1) AS multiplier
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         WHERE h.as_of_date = (
           SELECT MAX(h2.as_of_date)
           FROM holdings h2
           WHERE h2.account_id = h.account_id
         )
         ${accountFilter}
       ),
       latest_prices AS (
         SELECT security_id, close_price
         FROM prices p
         WHERE (security_id, date) IN (
           SELECT security_id, MAX(date) FROM prices GROUP BY security_id
         )
       )
       SELECT
         lh.symbol,
         lh.name AS security_name,
         CASE
           WHEN LOWER(lh.security_type) = 'bond'
             THEN lh.quantity * COALESCE(lp.close_price, 0) / 100.0
           ELSE lh.quantity * COALESCE(lp.close_price, 0) * lh.multiplier
         END AS market_value
       FROM latest_holdings lh
       LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
       WHERE COALESCE(lp.close_price, 0) > 0
       ORDER BY market_value DESC`
    )
    .all(...accountParams) as { symbol: string; security_name: string | null; market_value: number }[];

  if (rows.length === 0) {
    return { herfindahl: null, top5Concentration: 0, top5Positions: [], positionCount: 0 };
  }

  const totalValue = rows.reduce((s, r) => s + r.market_value, 0);
  if (totalValue <= 0) {
    return { herfindahl: null, top5Concentration: 0, top5Positions: [], positionCount: 0 };
  }

  const positions: PositionWeight[] = rows.map(r => ({
    symbol: r.symbol,
    securityName: r.security_name,
    marketValue: r.market_value,
    weight: r.market_value / totalValue,
  }));

  // Herfindahl index: sum of squared weights
  const herfindahl = positions.reduce((s, p) => s + p.weight ** 2, 0);

  // Top-5 concentration
  const top5 = positions.slice(0, 5);
  const top5Concentration = top5.reduce((s, p) => s + p.weight, 0);

  return {
    herfindahl,
    top5Concentration,
    top5Positions: top5,
    positionCount: positions.length,
  };
}

// ─── Position-Level Risk ─────────────────────────────────────────

/**
 * Compute per-position volatility, risk contribution, and pairwise
 * correlations for the top N positions. Uses daily close prices
 * from the prices table.
 */
export function computePositionRisk(
  db: Database.Database,
  options?: { accountId?: number; topN?: number }
): PositionRiskResult {
  const topN = options?.topN ?? 10;
  const accountFilter = options?.accountId ? "AND h.account_id = ?" : "";
  const accountParams: number[] = options?.accountId ? [options.accountId] : [];

  // 1. Get current positions with weights
  const positions = db
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
         lh.security_id,
         s.symbol,
         s.name AS security_name,
         CASE
           WHEN LOWER(s.security_type) = 'bond'
             THEN lh.total_qty * COALESCE(lp.close_price, 0) / 100.0
           ELSE lh.total_qty * COALESCE(lp.close_price, 0) * COALESCE(s.multiplier, 1)
         END AS market_value
       FROM latest_holdings lh
       JOIN securities s ON s.id = lh.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
       WHERE COALESCE(lp.close_price, 0) > 0
       ORDER BY market_value DESC
       LIMIT ?`
    )
    .all(...accountParams, topN) as {
    security_id: number;
    symbol: string;
    security_name: string | null;
    market_value: number;
  }[];

  if (positions.length === 0) {
    return { positions: [], correlations: [], portfolioVol: null };
  }

  const totalValue = positions.reduce((s, p) => s + p.market_value, 0);
  const securityIds = positions.map((p) => p.security_id);

  // 2. Fetch daily prices for all top positions (last 1 year)
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);

  const priceRows = db
    .prepare(
      `SELECT security_id, date, close_price
       FROM prices
       WHERE security_id IN (${securityIds.map(() => "?").join(",")})
         AND date >= ?
       ORDER BY date ASC`
    )
    .all(...securityIds, oneYearAgo) as {
    security_id: number;
    date: string;
    close_price: number;
  }[];

  // 3. Build per-security price series and compute daily returns
  const priceMap = new Map<number, Map<string, number>>(); // security_id -> date -> price
  const allDates = new Set<string>();

  for (const row of priceRows) {
    if (!priceMap.has(row.security_id)) {
      priceMap.set(row.security_id, new Map());
    }
    priceMap.get(row.security_id)!.set(row.date, row.close_price);
    allDates.add(row.date);
  }

  const sortedDates = [...allDates].sort();

  // Compute daily log returns per security
  const returnsBySecId = new Map<number, { dates: string[]; returns: number[] }>();

  for (const secId of securityIds) {
    const prices = priceMap.get(secId);
    if (!prices) continue;

    const dates: string[] = [];
    const returns: number[] = [];

    for (let i = 1; i < sortedDates.length; i++) {
      const prev = prices.get(sortedDates[i - 1]);
      const curr = prices.get(sortedDates[i]);
      if (prev && curr && prev > 0 && curr > 0) {
        dates.push(sortedDates[i]);
        returns.push(Math.log(curr / prev));
      }
    }

    returnsBySecId.set(secId, { dates, returns });
  }

  // 4. Compute portfolio daily returns (weighted sum)
  const weights = new Map<number, number>();
  for (const p of positions) {
    weights.set(p.security_id, totalValue > 0 ? p.market_value / totalValue : 0);
  }

  // Portfolio return for each date = sum(weight_i * return_i)
  const portfolioReturns = new Map<string, number>();
  for (const date of sortedDates.slice(1)) {
    let portfolioReturn = 0;
    let coverageWeight = 0;
    for (const secId of securityIds) {
      const secReturns = returnsBySecId.get(secId);
      if (!secReturns) continue;
      const idx = secReturns.dates.indexOf(date);
      if (idx >= 0) {
        const w = weights.get(secId) ?? 0;
        portfolioReturn += w * secReturns.returns[idx];
        coverageWeight += w;
      }
    }
    // Only include dates where we have reasonable coverage
    if (coverageWeight > 0.5) {
      portfolioReturns.set(date, portfolioReturn / coverageWeight);
    }
  }

  const portfolioReturnArray = [...portfolioReturns.values()];
  const portfolioVol =
    portfolioReturnArray.length >= 20
      ? stdDev(portfolioReturnArray) * Math.sqrt(TRADING_DAYS_PER_YEAR)
      : null;

  // 5. Compute per-position metrics
  const positionRisks: PositionRisk[] = positions.map((p) => {
    const secReturns = returnsBySecId.get(p.security_id);
    const weight = totalValue > 0 ? p.market_value / totalValue : 0;

    if (!secReturns || secReturns.returns.length < 20) {
      return {
        securityId: p.security_id,
        symbol: p.symbol,
        securityName: p.security_name,
        weight,
        annualizedVol: null,
        riskContribution: null,
        correlationWithPortfolio: null,
        dataPoints: secReturns?.returns.length ?? 0,
      };
    }

    const vol = stdDev(secReturns.returns) * Math.sqrt(TRADING_DAYS_PER_YEAR);

    // Compute correlation with portfolio
    const alignedSec: number[] = [];
    const alignedPort: number[] = [];
    for (let i = 0; i < secReturns.dates.length; i++) {
      const portRet = portfolioReturns.get(secReturns.dates[i]);
      if (portRet !== undefined) {
        alignedSec.push(secReturns.returns[i]);
        alignedPort.push(portRet);
      }
    }

    const corr = alignedSec.length >= 20 ? correlation(alignedSec, alignedPort) : null;

    // Risk contribution: weight × vol × correlation
    const riskContribution =
      corr != null && portfolioVol != null && portfolioVol > 0
        ? (weight * vol * corr) / portfolioVol
        : null;

    return {
      securityId: p.security_id,
      symbol: p.symbol,
      securityName: p.security_name,
      weight,
      annualizedVol: vol,
      riskContribution,
      correlationWithPortfolio: corr,
      dataPoints: secReturns.returns.length,
    };
  });

  // 6. Compute pairwise correlations for top positions
  const correlations: CorrelationEntry[] = [];
  const topForCorr = positions.slice(0, 8); // limit matrix size

  for (let i = 0; i < topForCorr.length; i++) {
    for (let j = i + 1; j < topForCorr.length; j++) {
      const a = returnsBySecId.get(topForCorr[i].security_id);
      const b = returnsBySecId.get(topForCorr[j].security_id);
      if (!a || !b) continue;

      // Align on common dates
      const aDates = new Set(a.dates);
      const alignedA: number[] = [];
      const alignedB: number[] = [];
      for (let k = 0; k < b.dates.length; k++) {
        if (aDates.has(b.dates[k])) {
          const aIdx = a.dates.indexOf(b.dates[k]);
          if (aIdx >= 0) {
            alignedA.push(a.returns[aIdx]);
            alignedB.push(b.returns[k]);
          }
        }
      }

      if (alignedA.length >= 20) {
        correlations.push({
          symbolA: topForCorr[i].symbol,
          symbolB: topForCorr[j].symbol,
          correlation: correlation(alignedA, alignedB),
        });
      }
    }
  }

  return { positions: positionRisks, correlations, portfolioVol };
}

// ─── Math helpers ────────────────────────────────────────────────

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n;

  let cov = 0;
  let varA = 0;
  let varB = 0;

  for (let i = 0; i < n; i++) {
    const dA = a[i] - meanA;
    const dB = b[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }

  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : 0;
}

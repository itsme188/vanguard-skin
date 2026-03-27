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
           WHEN lh.security_type = 'bond'
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

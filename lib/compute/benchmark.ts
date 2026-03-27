import type Database from "better-sqlite3";
import { getDailyValuationsCombined, getDailyValuationsByAccount } from "@/lib/queries/daily-valuations";
import { getBenchmarkPrices } from "@/lib/queries/benchmark";

// ─── Types ──────────────────────────────────────────────────────

export interface BenchmarkComparison {
  benchmarkSymbol: string;
  portfolioReturn: number;       // total return over period
  benchmarkReturn: number;       // total return over period
  alpha: number;                 // portfolio - benchmark return
  trackingError: number | null;  // std dev of daily excess returns (annualized)
  informationRatio: number | null; // alpha / tracking error
  correlation: number | null;    // daily return correlation
  dataPoints: number;            // overlapping days
}

export interface BenchmarkChartPoint {
  date: string;
  portfolioReturn: number;  // cumulative % return from start
  benchmarkReturn: number;  // cumulative % return from start
}

export interface BenchmarkComparisonOptions {
  benchmarkSymbol: string;
  startDate?: string;
  endDate?: string;
  accountId?: number;
}

// ─── Analytics ──────────────────────────────────────────────────

const TRADING_DAYS_PER_YEAR = 252;

/**
 * Compute benchmark comparison analytics for a given period.
 * Aligns portfolio daily valuations with benchmark daily prices by date.
 */
export function computeBenchmarkComparison(
  db: Database.Database,
  options: BenchmarkComparisonOptions
): BenchmarkComparison | null {
  // Get portfolio valuations
  const valuations = options.accountId
    ? getDailyValuationsByAccount(db, options.accountId, {
        startDate: options.startDate,
        endDate: options.endDate,
      })
    : getDailyValuationsCombined(db, {
        startDate: options.startDate,
        endDate: options.endDate,
      });

  // Get benchmark prices
  const benchPrices = getBenchmarkPrices(db, options.benchmarkSymbol, {
    startDate: options.startDate,
    endDate: options.endDate,
  });

  if (valuations.length < 2 || benchPrices.length < 2) return null;

  // Build lookup maps
  const portfolioByDate = new Map(valuations.map(v => [v.valuation_date, v.total_value]));
  const benchByDate = new Map(benchPrices.map(p => [p.date, p.close_price]));

  // Find overlapping dates
  const overlapping = valuations
    .filter(v => benchByDate.has(v.valuation_date))
    .map(v => ({
      date: v.valuation_date,
      portfolio: v.total_value,
      benchmark: benchByDate.get(v.valuation_date)!,
    }));

  if (overlapping.length < 2) return null;

  // Total returns
  const pStart = overlapping[0].portfolio;
  const pEnd = overlapping[overlapping.length - 1].portfolio;
  const bStart = overlapping[0].benchmark;
  const bEnd = overlapping[overlapping.length - 1].benchmark;

  const portfolioReturn = pStart > 0 ? (pEnd - pStart) / pStart : 0;
  const benchmarkReturn = bStart > 0 ? (bEnd - bStart) / bStart : 0;
  const alpha = portfolioReturn - benchmarkReturn;

  // Daily returns for tracking error and correlation
  const portfolioReturns: number[] = [];
  const benchReturns: number[] = [];
  const excessReturns: number[] = [];

  for (let i = 1; i < overlapping.length; i++) {
    const pr = overlapping[i - 1].portfolio > 0
      ? (overlapping[i].portfolio - overlapping[i - 1].portfolio) / overlapping[i - 1].portfolio
      : 0;
    const br = overlapping[i - 1].benchmark > 0
      ? (overlapping[i].benchmark - overlapping[i - 1].benchmark) / overlapping[i - 1].benchmark
      : 0;
    portfolioReturns.push(pr);
    benchReturns.push(br);
    excessReturns.push(pr - br);
  }

  // Tracking error (annualized std dev of excess returns)
  let trackingError: number | null = null;
  let informationRatio: number | null = null;

  if (excessReturns.length >= 20) {
    const mean = excessReturns.reduce((s, r) => s + r, 0) / excessReturns.length;
    const variance = excessReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (excessReturns.length - 1);
    trackingError = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    if (trackingError > 0) {
      // Annualize mean excess return for IR calculation
      const annualizedExcess = mean * TRADING_DAYS_PER_YEAR;
      informationRatio = annualizedExcess / trackingError;
    }
  }

  // Correlation
  let correlation: number | null = null;
  if (portfolioReturns.length >= 20) {
    correlation = pearsonCorrelation(portfolioReturns, benchReturns);
  }

  return {
    benchmarkSymbol: options.benchmarkSymbol,
    portfolioReturn,
    benchmarkReturn,
    alpha,
    trackingError,
    informationRatio,
    correlation,
    dataPoints: overlapping.length,
  };
}

/**
 * Get chart data: cumulative % returns for both portfolio and benchmark.
 * Both normalized to 0% at the start date.
 */
export function getBenchmarkChartData(
  db: Database.Database,
  options: BenchmarkComparisonOptions
): BenchmarkChartPoint[] {
  const valuations = options.accountId
    ? getDailyValuationsByAccount(db, options.accountId, {
        startDate: options.startDate,
        endDate: options.endDate,
      })
    : getDailyValuationsCombined(db, {
        startDate: options.startDate,
        endDate: options.endDate,
      });

  const benchPrices = getBenchmarkPrices(db, options.benchmarkSymbol, {
    startDate: options.startDate,
    endDate: options.endDate,
  });

  if (valuations.length < 2 || benchPrices.length < 2) return [];

  const benchByDate = new Map(benchPrices.map(p => [p.date, p.close_price]));

  // Find overlapping dates
  const overlapping = valuations.filter(v => benchByDate.has(v.valuation_date));
  if (overlapping.length < 2) return [];

  const pStart = overlapping[0].total_value;
  const bStart = benchByDate.get(overlapping[0].valuation_date)!;

  return overlapping.map(v => ({
    date: v.valuation_date,
    portfolioReturn: pStart > 0 ? ((v.total_value - pStart) / pStart) * 100 : 0,
    benchmarkReturn: bStart > 0
      ? ((benchByDate.get(v.valuation_date)! - bStart) / bStart) * 100
      : 0,
  }));
}

// ─── Helpers ────────────────────────────────────────────────────

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let num = 0;
  let denX = 0;
  let denY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  return den > 0 ? num / den : 0;
}

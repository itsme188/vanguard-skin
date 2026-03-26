/**
 * Technical indicator computations for charting.
 * All functions are pure — they take OHLCV data and return computed series.
 * Designed to run client-side (no DB or server dependencies).
 */

export interface IndicatorPoint {
  date: string;
  value: number;
}

/**
 * Simple Moving Average.
 * Returns one point per input bar (starting from index period-1).
 */
export function computeSMA(
  closes: { date: string; close: number }[],
  period: number,
): IndicatorPoint[] {
  if (closes.length < period) return [];

  const result: IndicatorPoint[] = [];
  let sum = 0;

  for (let i = 0; i < closes.length; i++) {
    sum += closes[i].close;
    if (i >= period) {
      sum -= closes[i - period].close;
    }
    if (i >= period - 1) {
      result.push({
        date: closes[i].date,
        value: sum / period,
      });
    }
  }

  return result;
}

/**
 * Exponential Moving Average.
 * Uses the standard multiplier: 2 / (period + 1).
 * Seeded with the SMA of the first `period` bars.
 */
export function computeEMA(
  closes: { date: string; close: number }[],
  period: number,
): IndicatorPoint[] {
  if (closes.length < period) return [];

  const multiplier = 2 / (period + 1);
  const result: IndicatorPoint[] = [];

  // Seed: SMA of first `period` bars
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i].close;
  }
  let ema = sum / period;
  result.push({ date: closes[period - 1].date, value: ema });

  // EMA from period onward
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i].close - ema) * multiplier + ema;
    result.push({ date: closes[i].date, value: ema });
  }

  return result;
}

/**
 * Normalize a price series to percentage change from the first bar.
 * Used for SPY benchmark overlay comparison.
 */
export function normalizeToPercent(
  bars: { date: string; close: number }[],
): IndicatorPoint[] {
  if (bars.length === 0) return [];
  const base = bars[0].close;
  if (base === 0) return [];

  return bars.map((b) => ({
    date: b.date,
    value: ((b.close - base) / base) * 100,
  }));
}

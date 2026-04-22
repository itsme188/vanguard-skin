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

// ─── Average True Range ──────────────────────────────────────────

export interface OhlcBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Average True Range (Wilder's smoothing).
 *
 * TR = max(high-low, |high-prev_close|, |low-prev_close|)
 * ATR[0] = SMA of first `period` TR values (seed).
 * ATR[i] = ((period-1)*ATR[i-1] + TR[i]) / period.
 *
 * Returns one IndicatorPoint per bar starting at index `period` (the first
 * fully-smoothed value). Earlier bars are omitted because ATR isn't defined
 * on partial windows.
 */
export function computeATR(bars: OhlcBar[], period: number = 14): IndicatorPoint[] {
  if (bars.length < period + 1) return [];
  if (period < 1) return [];

  // Compute True Range for each bar (TR[0] undefined since no prev close).
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const prevClose = bars[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
    trs.push(tr);
  }
  // trs[i] corresponds to bars[i+1]

  if (trs.length < period) return [];

  const result: IndicatorPoint[] = [];

  // Seed: simple average of first `period` TRs
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let atr = sum / period;
  result.push({ date: bars[period].date, value: atr });

  // Wilder's smoothing for the rest
  for (let i = period; i < trs.length; i++) {
    atr = ((period - 1) * atr + trs[i]) / period;
    result.push({ date: bars[i + 1].date, value: atr });
  }

  return result;
}

// ─── Pivot high/low detection ────────────────────────────────────

export interface Pivot {
  date: string;
  price: number;
  type: "high" | "low";
}

/**
 * Fractal pivot detection. A bar at index i is a PIVOT HIGH if its high is
 * strictly greater than the high of the `strength` bars on each side. Symmetric
 * for PIVOT LOW.
 *
 * Default strength=3: 3 lower-high bars on each side. Larger strength =
 * fewer, more structurally significant pivots. Works on daily OHLC bars.
 *
 * Returns pivots in chronological order. The last `strength` bars can never
 * be pivots (not enough right-side context), matching how TradingView's
 * "pivothigh" function behaves.
 */
export function computePivotLevels(
  bars: OhlcBar[],
  options: { strength?: number } = {},
): Pivot[] {
  const strength = Math.max(1, Math.floor(options.strength ?? 3));
  if (bars.length < strength * 2 + 1) return [];

  const pivots: Pivot[] = [];
  for (let i = strength; i < bars.length - strength; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= strength; j++) {
      // Strict on the left, non-strict on the right so consecutive ties
      // don't produce duplicate pivots.
      if (bars[i - j].high >= h) isHigh = false;
      if (bars[i + j].high > h) isHigh = false;
      if (bars[i - j].low <= l) isLow = false;
      if (bars[i + j].low < l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) pivots.push({ date: bars[i].date, price: h, type: "high" });
    if (isLow) pivots.push({ date: bars[i].date, price: l, type: "low" });
  }
  return pivots;
}

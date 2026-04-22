/**
 * Derive suggested support / resistance levels from OHLCV history.
 *
 * Algorithm (deliberately simple for v1):
 *   1. Detect pivot highs + lows via fractal pattern (strength=3).
 *   2. Compute ATR to set a clustering distance.
 *   3. Cluster pivots within 0.4 * ATR of each other — treat a cluster of
 *      3 pivot highs near $120 as a single resistance level at $120.
 *   4. Classify each cluster as support (below current price) or resistance
 *      (above). Drop clusters within 0.25 * ATR of current price (too noisy
 *      to act on — price is already there).
 *   5. Score by (touches + recency weight). Return top N of each type.
 *
 * Pure function. No DB / no server dependencies. Can run client-side.
 */

import {
  computeATR,
  computePivotLevels,
  type OhlcBar,
  type Pivot,
} from "@/lib/chart/indicators";

export interface SuggestedLevel {
  price: number;
  type: "support" | "resistance";
  touches: number;
  lastTouchDate: string;
  firstTouchDate: string;
  confidence: "high" | "medium" | "low";
  distancePct: number; // signed: negative = support (below), positive = resistance (above)
}

export interface SuggestedLevelsResult {
  levels: SuggestedLevel[];
  atr: number | null;
  currentPrice: number;
  barsAnalyzed: number;
  computedAt: string;
}

export interface SuggestedLevelsOptions {
  /** Fractal strength for pivot detection. Default 3. */
  strength?: number;
  /** ATR period. Default 14. */
  atrPeriod?: number;
  /** Cluster radius as a multiple of ATR. Default 0.4. */
  clusterAtrMultiple?: number;
  /** Drop clusters within this ATR multiple of current price. Default 0.25. */
  noiseAtrMultiple?: number;
  /** Max levels of each type (support/resistance) to return. Default 5. */
  perSideLimit?: number;
}

interface Cluster {
  prices: number[];
  dates: string[];
  type: "high" | "low";
}

/**
 * Run the pivot-cluster algorithm on `bars` given the latest close as
 * `currentPrice`. Returns null-safe structured output.
 */
export function computeSuggestedLevels(
  bars: OhlcBar[],
  currentPrice: number,
  options: SuggestedLevelsOptions = {},
): SuggestedLevelsResult {
  const strength = options.strength ?? 3;
  const atrPeriod = options.atrPeriod ?? 14;
  const clusterMult = options.clusterAtrMultiple ?? 0.4;
  const noiseMult = options.noiseAtrMultiple ?? 0.25;
  const perSide = options.perSideLimit ?? 5;

  const computedAt = new Date().toISOString();

  if (bars.length < atrPeriod + 1 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      levels: [],
      atr: null,
      currentPrice,
      barsAnalyzed: bars.length,
      computedAt,
    };
  }

  const atrSeries = computeATR(bars, atrPeriod);
  const atr = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1].value : null;
  if (!atr || atr <= 0) {
    return { levels: [], atr, currentPrice, barsAnalyzed: bars.length, computedAt };
  }

  const pivots = computePivotLevels(bars, { strength });
  if (pivots.length === 0) {
    return { levels: [], atr, currentPrice, barsAnalyzed: bars.length, computedAt };
  }

  const clusterRadius = atr * clusterMult;
  const noiseRadius = atr * noiseMult;

  // Separate by type so a high near a low doesn't merge.
  const highs = pivots.filter((p) => p.type === "high");
  const lows = pivots.filter((p) => p.type === "low");

  const highClusters = clusterPivots(highs, clusterRadius);
  const lowClusters = clusterPivots(lows, clusterRadius);

  const rawLevels: SuggestedLevel[] = [];
  for (const c of [...highClusters, ...lowClusters]) {
    const avgPrice = c.prices.reduce((s, p) => s + p, 0) / c.prices.length;
    if (!Number.isFinite(avgPrice)) continue;

    const distance = avgPrice - currentPrice;
    if (Math.abs(distance) < noiseRadius) continue;

    // Classify: resistance if above, support if below. Pivot *type* biases
    // classification (a pivot high below current price is still structural
    // support, e.g. an old resistance that flipped — but for v1 we go with
    // simple above/below.)
    const type: "support" | "resistance" = distance >= 0 ? "resistance" : "support";

    const dates = [...c.dates].sort();
    const firstTouch = dates[0];
    const lastTouch = dates[dates.length - 1];

    rawLevels.push({
      price: roundToPennies(avgPrice),
      type,
      touches: c.prices.length,
      lastTouchDate: lastTouch,
      firstTouchDate: firstTouch,
      confidence: classifyConfidence(c.prices.length, lastTouch, bars),
      distancePct: (distance / currentPrice) * 100,
    });
  }

  // Rank each side by score, trim to perSide, combine.
  const supports = rawLevels
    .filter((l) => l.type === "support")
    .sort(byScore(bars))
    .slice(0, perSide);
  const resistances = rawLevels
    .filter((l) => l.type === "resistance")
    .sort(byScore(bars))
    .slice(0, perSide);

  // Return interleaved by closeness to current price (most actionable first).
  const combined = [...supports, ...resistances].sort(
    (a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct),
  );

  return {
    levels: combined,
    atr,
    currentPrice,
    barsAnalyzed: bars.length,
    computedAt,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Greedy 1D clustering: walk pivots in price-sorted order, group into the
 * current cluster while within radius, start a new cluster when the jump
 * exceeds radius.
 */
function clusterPivots(pivots: Pivot[], radius: number): Cluster[] {
  if (pivots.length === 0) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: Cluster[] = [];
  let current: Cluster = {
    prices: [sorted[0].price],
    dates: [sorted[0].date],
    type: sorted[0].type,
  };
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i];
    const last = current.prices[current.prices.length - 1];
    if (Math.abs(p.price - last) <= radius) {
      current.prices.push(p.price);
      current.dates.push(p.date);
    } else {
      clusters.push(current);
      current = { prices: [p.price], dates: [p.date], type: p.type };
    }
  }
  clusters.push(current);
  return clusters;
}

/**
 * Confidence tiers:
 *   high   = 3+ touches AND most recent touch within last third of series
 *   medium = 2+ touches OR recent single touch
 *   low    = single old touch
 */
function classifyConfidence(
  touches: number,
  lastTouchDate: string,
  bars: OhlcBar[],
): "high" | "medium" | "low" {
  if (bars.length === 0) return "low";
  const lastIdx = bars.findIndex((b) => b.date === lastTouchDate);
  const recency = lastIdx === -1 ? 0 : lastIdx / bars.length;
  if (touches >= 3 && recency >= 2 / 3) return "high";
  if (touches >= 2) return "medium";
  if (recency >= 2 / 3) return "medium";
  return "low";
}

/**
 * Ranking key: more touches beats fewer; among equal touches, more recent
 * beats older. We use index-in-bars as the recency proxy (higher = newer).
 */
function byScore(
  bars: OhlcBar[],
): (a: SuggestedLevel, b: SuggestedLevel) => number {
  const dateIndex = new Map<string, number>();
  bars.forEach((b, i) => dateIndex.set(b.date, i));
  return (a, b) => {
    if (b.touches !== a.touches) return b.touches - a.touches;
    const aIdx = dateIndex.get(a.lastTouchDate) ?? -1;
    const bIdx = dateIndex.get(b.lastTouchDate) ?? -1;
    return bIdx - aIdx;
  };
}

function roundToPennies(v: number): number {
  return Math.round(v * 100) / 100;
}

import { describe, it, expect } from "vitest";
import {
  computeSuggestedLevels,
} from "@/lib/chart/suggested-levels";
import type { OhlcBar } from "@/lib/chart/indicators";

function makeBars(
  data: Array<[date: string, o: number, h: number, l: number, c: number]>,
): OhlcBar[] {
  return data.map(([date, o, h, l, c]) => ({
    date,
    open: o,
    high: h,
    low: l,
    close: c,
  }));
}

/**
 * Build a simple oscillating price series with injected pivot highs + lows
 * so we can verify the clustering / classification logic end-to-end.
 */
function syntheticSeries(): OhlcBar[] {
  const bars: OhlcBar[] = [];
  const base = 100;
  const days = 60;
  for (let i = 0; i < days; i++) {
    const d = new Date(2025, 0, i + 1).toISOString().slice(0, 10);
    // oscillate with a touch-zone at 110 (resistance) and 90 (support)
    const phase = i % 12;
    let high = base + 3;
    let low = base - 3;
    if (phase === 5) {
      high = 110; // resistance touch
    }
    if (phase === 11) {
      low = 90; // support touch
    }
    bars.push({ date: d, open: base, high, low, close: base });
  }
  return bars;
}

describe("computeSuggestedLevels", () => {
  it("returns an empty result when bars are below ATR warmup", () => {
    const out = computeSuggestedLevels(makeBars([]), 100);
    expect(out.levels).toEqual([]);
    expect(out.atr).toBeNull();
    expect(out.currentPrice).toBe(100);
  });

  it("returns empty when currentPrice is zero or negative", () => {
    const bars = syntheticSeries();
    const out = computeSuggestedLevels(bars, 0);
    expect(out.levels).toEqual([]);
  });

  it("finds resistance above + support below the current price", () => {
    const bars = syntheticSeries();
    const out = computeSuggestedLevels(bars, 100);
    expect(out.atr).not.toBeNull();
    const resistances = out.levels.filter((l) => l.type === "resistance");
    const supports = out.levels.filter((l) => l.type === "support");

    // Synthetic series injects repeated 110 highs + 90 lows — both should
    // appear as clusters.
    expect(resistances.length).toBeGreaterThan(0);
    expect(supports.length).toBeGreaterThan(0);
    expect(resistances[0].price).toBeCloseTo(110, 0);
    expect(supports[0].price).toBeCloseTo(90, 0);
  });

  it("clusters repeated touches into a single level with touches>1", () => {
    const bars = syntheticSeries();
    const out = computeSuggestedLevels(bars, 100);
    const topResistance = out.levels.find((l) => l.type === "resistance");
    expect(topResistance?.touches).toBeGreaterThan(1);
  });

  it("filters out clusters within noise radius of current price", () => {
    // Make a series where a pivot lies right at the current price.
    const bars = makeBars([
      ["2025-01-01", 100, 102, 99, 100],
      ["2025-01-02", 100, 103, 99, 100],
      ["2025-01-03", 100, 104, 99, 100],
      ["2025-01-04", 100, 105, 99, 100], // pivot high ~5 above current
      ["2025-01-05", 100, 104, 99, 100],
      ["2025-01-06", 100, 103, 99, 100],
      ["2025-01-07", 100, 102, 99, 100],
      ["2025-01-08", 100, 101, 99, 100],
      ["2025-01-09", 100, 100.5, 99, 100],
      ["2025-01-10", 100, 100.5, 99, 100],
      ["2025-01-11", 100, 100.5, 99, 100],
      ["2025-01-12", 100, 100.5, 99, 100],
      ["2025-01-13", 100, 100.5, 99, 100],
      ["2025-01-14", 100, 100.5, 99, 100],
      ["2025-01-15", 100, 100.5, 99, 100],
      ["2025-01-16", 100, 100.5, 99, 100],
    ]);
    // currentPrice very close to the pivot at 105 should NOT filter it
    // because ATR is tiny here, so noise radius is tiny.
    const out = computeSuggestedLevels(bars, 100);
    // The 105 pivot should survive (distance well outside noise radius).
    const above = out.levels.filter((l) => l.type === "resistance");
    expect(above.length).toBeGreaterThanOrEqual(1);
  });

  it("marks 3+ touches + recent as 'high' confidence", () => {
    // 60 bars with repeated 110 highs — the last one is recent.
    const bars = syntheticSeries();
    const out = computeSuggestedLevels(bars, 100);
    const highConf = out.levels.filter((l) => l.confidence === "high");
    expect(highConf.length).toBeGreaterThan(0);
  });

  it("returns distancePct signed: negative for support, positive for resistance", () => {
    const bars = syntheticSeries();
    const out = computeSuggestedLevels(bars, 100);
    for (const l of out.levels) {
      if (l.type === "support") expect(l.distancePct).toBeLessThan(0);
      if (l.type === "resistance") expect(l.distancePct).toBeGreaterThan(0);
    }
  });

  it("respects perSideLimit option", () => {
    const bars = syntheticSeries();
    const out = computeSuggestedLevels(bars, 100, { perSideLimit: 1 });
    const r = out.levels.filter((l) => l.type === "resistance");
    const s = out.levels.filter((l) => l.type === "support");
    expect(r.length).toBeLessThanOrEqual(1);
    expect(s.length).toBeLessThanOrEqual(1);
  });

  it("price is rounded to pennies", () => {
    const bars = syntheticSeries();
    const out = computeSuggestedLevels(bars, 100);
    for (const l of out.levels) {
      expect(l.price * 100).toBeCloseTo(Math.round(l.price * 100), 5);
    }
  });
});

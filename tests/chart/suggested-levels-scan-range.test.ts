/**
 * Regression pin (qa:levels-suggestions--accept-arms-level-beyond-plausibility-
 * scan-range-regression-2): the pivot engine used to offer levels 60-79% away
 * from spot with a one-click Accept. Accepting armed a level the scanner then
 * permanently skipped. Candidates outside the scan band are no longer offered
 * at all — options excepted, mirroring the scanner's own exemption.
 */

import { describe, it, expect } from "vitest";
import { computeSuggestedLevels } from "@/lib/chart/suggested-levels";
import type { OhlcBar } from "@/lib/chart/indicators";

/**
 * Two price regimes: ~30 sessions oscillating around 300 (pivot highs 310 /
 * lows 290), then ~45 sessions around 100 (pivot highs 110 / lows 90). With a
 * current price of 100 the old-regime clusters sit 66%+ away by the level's
 * own denominator — beyond the scan band — while the recent clusters are a
 * normal ~10% away.
 */
function twoRegimeSeries(): OhlcBar[] {
  const bars: OhlcBar[] = [];
  let day = 0;
  const push = (base: number, high: number, low: number) => {
    const date = new Date(Date.UTC(2025, 0, day + 1)).toISOString().slice(0, 10);
    bars.push({ date, open: base, high, low, close: base });
    day++;
  };
  for (let i = 0; i < 30; i++) {
    const phase = i % 10;
    push(300, phase === 4 ? 310 : 303, phase === 9 ? 290 : 297);
  }
  for (let i = 0; i < 45; i++) {
    const phase = i % 10;
    push(100, phase === 4 ? 110 : 103, phase === 9 ? 90 : 97);
  }
  return bars;
}

const CURRENT = 100;

function distanceFromLevel(levelPrice: number): number {
  return Math.abs(CURRENT - levelPrice) / levelPrice;
}

describe("computeSuggestedLevels scan-range filter", () => {
  it("offers only candidates the scanner would actually evaluate", () => {
    const out = computeSuggestedLevels(twoRegimeSeries(), CURRENT, {
      securityType: "stock",
    });

    expect(out.levels.length).toBeGreaterThan(0);
    for (const level of out.levels) {
      expect(distanceFromLevel(level.price)).toBeLessThanOrEqual(0.5);
    }
    // The 310 / 290 old-regime clusters are gone…
    expect(out.levels.some((l) => l.price > 250)).toBe(false);
    // …but the actionable ~110 / ~90 structure is still offered.
    expect(out.levels.some((l) => Math.abs(l.price - 110) < 3)).toBe(true);
    expect(out.levels.some((l) => Math.abs(l.price - 90) < 3)).toBe(true);
  });

  it("still finds the far clusters when the band is not applied (options)", () => {
    const out = computeSuggestedLevels(twoRegimeSeries(), CURRENT, {
      securityType: "option",
    });
    expect(out.levels.some((l) => l.price > 250)).toBe(true);
  });

  it("defaults to the non-option band when no security type is supplied", () => {
    const out = computeSuggestedLevels(twoRegimeSeries(), CURRENT);
    expect(out.levels.some((l) => l.price > 250)).toBe(false);
  });

  it("does not let dropped far candidates consume a per-side slot", () => {
    // perSideLimit 1: the single resistance returned must be an in-band one,
    // not the far 310 cluster that used to outrank it on touch count.
    const out = computeSuggestedLevels(twoRegimeSeries(), CURRENT, {
      securityType: "stock",
      perSideLimit: 1,
    });
    const resistances = out.levels.filter((l) => l.type === "resistance");
    expect(resistances.length).toBe(1);
    expect(distanceFromLevel(resistances[0].price)).toBeLessThanOrEqual(0.5);
  });
});

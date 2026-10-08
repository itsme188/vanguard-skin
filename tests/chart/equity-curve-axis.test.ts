import { describe, it, expect } from "vitest";
import { equityCurveGranularity, equityCurveYAxis } from "@/lib/chart/equity-curve-anchor";

// QA accounts-equity-curve--zero-anchored-y-axis-flattens-short-ranges: the
// account curve's value axis started at zero on every range, so a month's
// move used a few percent of the plot height. The axis now frames the data.
describe("equityCurveYAxis", () => {
  it("frames a short window instead of starting at zero", () => {
    // A synthetic 5% month on a 100K account.
    const axis = equityCurveYAxis([100_000, 102_500, 101_000, 105_000])!;
    const [lo, hi] = axis.domain;
    expect(lo).toBeGreaterThan(90_000);
    expect(lo).toBeLessThanOrEqual(100_000);
    expect(hi).toBeGreaterThanOrEqual(105_000);
    // The data uses most of the axis, not a sliver of it.
    expect((105_000 - 100_000) / (hi - lo)).toBeGreaterThan(0.5);
  });

  it("ticks are evenly stepped, start and end on the domain, and stay few", () => {
    const axis = equityCurveYAxis([100_000, 105_000])!;
    expect(axis.ticks[0]).toBe(axis.domain[0]);
    expect(axis.ticks[axis.ticks.length - 1]).toBe(axis.domain[1]);
    expect(axis.ticks.length).toBeGreaterThanOrEqual(2);
    expect(axis.ticks.length).toBeLessThanOrEqual(8);
    const step = axis.ticks[1] - axis.ticks[0];
    for (let i = 1; i < axis.ticks.length; i++) {
      expect(axis.ticks[i] - axis.ticks[i - 1]).toBe(step);
    }
  });

  it("every tick is exact at the two decimals the axis label keeps", () => {
    // Labels read $1.23M / $12.35K: a tick must be a whole multiple of 10K
    // at a million and above, of 10 dollars at a thousand and above.
    const big = equityCurveYAxis([1_702_000, 1_704_000, 1_706_500])!;
    for (const t of big.ticks) expect(t % 10_000).toBe(0);
    expect(big.domain[0]).toBeLessThanOrEqual(1_702_000);
    expect(big.domain[1]).toBeGreaterThanOrEqual(1_706_500);

    const mid = equityCurveYAxis([12_001, 12_004, 12_009])!;
    for (const t of mid.ticks) expect(t % 10).toBe(0);
    expect(mid.domain[0]).toBeLessThanOrEqual(12_001);
    expect(mid.domain[1]).toBeGreaterThanOrEqual(12_009);
  });

  it("never pads a non-negative series below zero", () => {
    const axis = equityCurveYAxis([0, 40_000, 100_000])!;
    expect(axis.domain[0]).toBe(0);
    const nearZero = equityCurveYAxis([2_000, 100_000])!;
    expect(nearZero.domain[0]).toBe(0);
  });

  it("a series that goes negative keeps room below it", () => {
    const axis = equityCurveYAxis([-5_000, 20_000])!;
    expect(axis.domain[0]).toBeLessThanOrEqual(-5_000);
    expect(axis.domain[1]).toBeGreaterThanOrEqual(20_000);
  });

  it("a flat series still gets a band around its value", () => {
    const axis = equityCurveYAxis([50_000, 50_000, 50_000])!;
    expect(axis.domain[0]).toBeLessThan(50_000);
    expect(axis.domain[1]).toBeGreaterThan(50_000);
    expect(axis.domain[0]).toBeGreaterThan(0);
  });

  it("ignores non-finite values; null when nothing is left", () => {
    expect(equityCurveYAxis([])).toBeNull();
    expect(equityCurveYAxis([NaN, Infinity])).toBeNull();
    const axis = equityCurveYAxis([NaN, 100_000, 110_000])!;
    expect(axis.domain[0]).toBeLessThanOrEqual(100_000);
    expect(axis.domain[1]).toBeGreaterThanOrEqual(110_000);
  });

  it("the whole range of a grown account is covered", () => {
    const axis = equityCurveYAxis([300_000, 900_000, 1_800_000])!;
    expect(axis.domain[0]).toBeLessThanOrEqual(300_000);
    expect(axis.domain[1]).toBeGreaterThanOrEqual(1_800_000);
  });
});

// QA accounts-equity-curve--daily-badge-on-month-end-only-history: the badge
// said "Daily" whenever any daily row existed, whatever the range showed.
describe("equityCurveGranularity", () => {
  const monthEnds = ["2022-01-31", "2022-02-28", "2022-03-31", "2022-04-30"];
  const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-08"];

  it("month-end points only: monthly", () => {
    expect(equityCurveGranularity(monthEnds)).toBe("monthly");
  });

  it("a point every trading day (weekends and a holiday allowed): daily", () => {
    expect(equityCurveGranularity(days)).toBe("daily");
    expect(equityCurveGranularity(["2026-07-02", "2026-07-06", "2026-07-07"])).toBe("daily");
  });

  it("month-ends followed by daily points: mixed", () => {
    expect(equityCurveGranularity([...monthEnds, "2026-05-29", ...days])).toBe("mixed");
  });

  it("the window decides, not the whole history", () => {
    const all = [...monthEnds, "2026-05-29", ...days];
    expect(equityCurveGranularity(all.filter((d) => d >= "2026-05-29"))).toBe("daily");
    expect(equityCurveGranularity(all.filter((d) => d <= "2022-12-31"))).toBe("monthly");
  });

  it("fewer than two points: nothing to say", () => {
    expect(equityCurveGranularity([])).toBeNull();
    expect(equityCurveGranularity(["2026-06-01"])).toBeNull();
  });
});

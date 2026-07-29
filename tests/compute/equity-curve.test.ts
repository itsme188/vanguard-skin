// Pins the equity-curve indexing contract: BOTH series are indexed to 100
// at the first PLOTTED date, so their slopes are directly comparable.
// Regression: qa:analysis-performance--equity-curve-benchmark-not-reindexed-to-100
import { describe, it, expect } from "vitest";
import { buildEquityCurveData } from "@/lib/compute/equity-curve";

describe("buildEquityCurveData", () => {
  it("indexes portfolio AND benchmark to 100 at the first plotted date", () => {
    // Benchmark has months of pre-window history (rose 100 -> 130 before the
    // portfolio series begins). Pre-fix, benchBase came from the first row of
    // the selected period, so the benchmark started at 130 on the chart.
    const bench = [
      { date: "2026-01-02", close_price: 100 },
      { date: "2026-02-02", close_price: 120 },
      { date: "2026-04-08", close_price: 130 },
      { date: "2026-04-09", close_price: 132.6 },
      { date: "2026-04-10", close_price: 136.5 },
    ];
    const vals = [
      { valuation_date: "2026-04-08", total_value: 1_000_000 },
      { valuation_date: "2026-04-09", total_value: 1_010_000 },
      { valuation_date: "2026-04-10", total_value: 1_050_000 },
    ];

    const curve = buildEquityCurveData(vals, bench);
    expect(curve).toHaveLength(3);
    expect(curve[0]).toEqual({ date: "2026-04-08", portfolio: 100, benchmark: 100 });
    expect(curve[1].benchmark).toBeCloseTo(102);
    expect(curve[2].portfolio).toBeCloseTo(105);
    expect(curve[2].benchmark).toBeCloseTo(105);
  });

  it("bases both series on the first date present in BOTH inputs", () => {
    // The first valuation date has no benchmark close (gets filtered from the
    // plot) — the base must move to the first date that actually plots, for
    // the portfolio series too.
    const bench = [
      { date: "2026-04-09", close_price: 200 },
      { date: "2026-04-10", close_price: 210 },
    ];
    const vals = [
      { valuation_date: "2026-04-08", total_value: 500_000 }, // no bench close
      { valuation_date: "2026-04-09", total_value: 550_000 },
      { valuation_date: "2026-04-10", total_value: 561_000 },
    ];

    const curve = buildEquityCurveData(vals, bench);
    expect(curve).toHaveLength(2);
    expect(curve[0]).toEqual({ date: "2026-04-09", portfolio: 100, benchmark: 100 });
    expect(curve[1].portfolio).toBeCloseTo(102);
    expect(curve[1].benchmark).toBeCloseTo(105);
  });

  it("returns [] when either series is too short or never overlaps", () => {
    expect(buildEquityCurveData([], [])).toEqual([]);
    expect(
      buildEquityCurveData(
        [
          { valuation_date: "2026-04-08", total_value: 1 },
          { valuation_date: "2026-04-09", total_value: 2 },
        ],
        [
          { date: "2026-05-01", close_price: 10 },
          { date: "2026-05-02", close_price: 11 },
        ]
      )
    ).toEqual([]);
  });

  it("skips zero/negative bases instead of dividing by them", () => {
    const bench = [
      { date: "2026-04-08", close_price: 0 },
      { date: "2026-04-09", close_price: 100 },
      { date: "2026-04-10", close_price: 110 },
    ];
    const vals = [
      { valuation_date: "2026-04-08", total_value: 0 },
      { valuation_date: "2026-04-09", total_value: 400_000 },
      { valuation_date: "2026-04-10", total_value: 440_000 },
    ];
    const curve = buildEquityCurveData(vals, bench);
    expect(curve[0]).toEqual({ date: "2026-04-09", portfolio: 100, benchmark: 100 });
    expect(curve[1].portfolio).toBeCloseTo(110);
  });
});

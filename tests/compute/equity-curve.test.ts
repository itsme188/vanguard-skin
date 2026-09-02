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

  // ─── Flow-adjusted / seam-bridged portfolio leg ────────────────────
  // Regression: qa:analysis-performance--equity-curve-raw-total-value-not-flow-adjusted
  // (curve claimed +76% while the TWR tile on the same card said +11.60%;
  // a -$100k withdrawal rendered as a -27% "crash"). buildEquityCurveData's
  // 3rd/4th params (flows, seamDates) default to [] — every test above calls
  // the 2-arg form and stays green because an empty-flow / no-seam
  // flow-adjusted index telescopes to the exact same ratio as the old raw
  // v.total_value / portBase computation. These tests exercise the 4-arg
  // form that PerformanceView now always calls.

  it("keeps the curve flat across a deposit when the market is flat (flow invariance)", () => {
    const bench = [
      { date: "2026-04-08", close_price: 100 },
      { date: "2026-04-09", close_price: 100 },
      { date: "2026-04-10", close_price: 100 },
    ];
    const vals = [
      { valuation_date: "2026-04-08", total_value: 1_000_000 },
      { valuation_date: "2026-04-09", total_value: 1_100_000 }, // +100k deposit, no market move
      { valuation_date: "2026-04-10", total_value: 1_100_000 },
    ];
    const flows = [{ date: "2026-04-09", net: 100_000 }];

    const curve = buildEquityCurveData(vals, bench, flows);
    expect(curve).toHaveLength(3);
    expect(curve[0].portfolio).toBe(100);
    expect(curve[1].portfolio).toBeCloseTo(100, 6);
    expect(curve[2].portfolio).toBeCloseTo(100, 6);

    // Prove the bug this pins: without the flow, the same series reads the
    // deposit as a +10% "gain".
    const rawCurve = buildEquityCurveData(vals, bench);
    expect(rawCurve[1].portfolio).toBeCloseTo(110, 6);
  });

  it("does not render a withdrawal as a drawdown (withdrawal invariance)", () => {
    const bench = [
      { date: "2026-04-08", close_price: 100 },
      { date: "2026-04-09", close_price: 100 },
      { date: "2026-04-10", close_price: 100 },
    ];
    const vals = [
      { valuation_date: "2026-04-08", total_value: 1_000_000 },
      { valuation_date: "2026-04-09", total_value: 900_000 }, // -100k withdrawal, no market move
      { valuation_date: "2026-04-10", total_value: 900_000 },
    ];
    const flows = [{ date: "2026-04-09", net: -100_000 }];

    const curve = buildEquityCurveData(vals, bench, flows);
    expect(curve[1].portfolio).toBeCloseTo(100, 6);
    expect(curve[2].portfolio).toBeCloseTo(100, 6);

    // Prove the bug this pins: without the flow, the withdrawal reads as a
    // -10% "crash".
    const rawCurve = buildEquityCurveData(vals, bench);
    expect(rawCurve[1].portfolio).toBeCloseTo(90, 6);
  });

  it("emits no return across an anchor-source seam day (curve carries flat)", () => {
    const bench = [
      { date: "2026-07-10", close_price: 100 },
      { date: "2026-07-11", close_price: 100 },
      { date: "2026-07-13", close_price: 100 },
    ];
    const vals = [
      { valuation_date: "2026-07-10", total_value: 100_000 },
      { valuation_date: "2026-07-11", total_value: 105_000 }, // fake +5% seam step, no flow
      { valuation_date: "2026-07-13", total_value: 106_050 }, // real +1% move after the bridge
    ];

    const curve = buildEquityCurveData(vals, bench, [], ["2026-07-11"]);
    expect(curve[0].portfolio).toBe(100);
    expect(curve[1].portfolio).toBeCloseTo(100, 6); // seam bridged: carried flat, no return
    expect(curve[2].portfolio).toBeCloseTo(101, 6); // 106050/105000 applied on the bridged level

    // Prove the bug this pins: without seamDates, the source handoff reads
    // as a fake +5% day.
    const rawCurve = buildEquityCurveData(vals, bench);
    expect(rawCurve[1].portfolio).toBeCloseTo(105, 6);
  });

  it("keeps the benchmark series a raw-close ratio, untouched by portfolio flows/seams", () => {
    const bench = [
      { date: "2026-04-08", close_price: 400 },
      { date: "2026-04-09", close_price: 408 }, // +2%, real market move
      { date: "2026-04-10", close_price: 396 }, // real -2.9%-ish move
    ];
    const vals = [
      { valuation_date: "2026-04-08", total_value: 1_000_000 },
      { valuation_date: "2026-04-09", total_value: 1_100_000 }, // +100k deposit
      { valuation_date: "2026-04-10", total_value: 1_100_000 },
    ];
    const flows = [{ date: "2026-04-09", net: 100_000 }];
    const seamDates = ["2026-04-10"]; // even with a seam flagged, benchmark is untouched

    const curve = buildEquityCurveData(vals, bench, flows, seamDates);
    expect(curve[0].benchmark).toBe(100);
    expect(curve[1].benchmark).toBeCloseTo(102, 6);
    expect(curve[2].benchmark).toBeCloseTo(99, 6); // 396 / 400 * 100 — plain ratio, never bridged
  });
});

import { describe, it, expect } from "vitest";
import {
  computeSMA,
  computeEMA,
  normalizeToPercent,
  computeATR,
  computePivotLevels,
  type OhlcBar,
} from "@/lib/chart/indicators";

const SAMPLE_BARS = [
  { date: "2025-01-01", close: 100 },
  { date: "2025-01-02", close: 102 },
  { date: "2025-01-03", close: 101 },
  { date: "2025-01-04", close: 104 },
  { date: "2025-01-05", close: 103 },
  { date: "2025-01-06", close: 106 },
  { date: "2025-01-07", close: 105 },
  { date: "2025-01-08", close: 108 },
  { date: "2025-01-09", close: 107 },
  { date: "2025-01-10", close: 110 },
];

describe("computeSMA", () => {
  it("computes correct SMA for period 3", () => {
    const result = computeSMA(SAMPLE_BARS, 3);
    // First point: avg of bars 0,1,2 = (100+102+101)/3 = 101
    expect(result).toHaveLength(8); // 10 - 3 + 1
    expect(result[0].date).toBe("2025-01-03");
    expect(result[0].value).toBeCloseTo(101, 5);
    // Second point: avg of bars 1,2,3 = (102+101+104)/3 = 102.333
    expect(result[1].date).toBe("2025-01-04");
    expect(result[1].value).toBeCloseTo(102.333, 2);
  });

  it("returns empty for period > data length", () => {
    expect(computeSMA(SAMPLE_BARS.slice(0, 2), 5)).toEqual([]);
  });

  it("returns single point when period === data length", () => {
    const result = computeSMA(SAMPLE_BARS, 10);
    expect(result).toHaveLength(1);
    const expectedAvg = SAMPLE_BARS.reduce((s, b) => s + b.close, 0) / 10;
    expect(result[0].value).toBeCloseTo(expectedAvg, 5);
  });
});

describe("computeEMA", () => {
  it("computes EMA with correct seed and decay", () => {
    const result = computeEMA(SAMPLE_BARS, 3);
    // Seed: SMA of first 3 = (100+102+101)/3 = 101
    expect(result).toHaveLength(8);
    expect(result[0].date).toBe("2025-01-03");
    expect(result[0].value).toBeCloseTo(101, 5);

    // Next: EMA = (104 - 101) * (2/4) + 101 = 3 * 0.5 + 101 = 102.5
    expect(result[1].date).toBe("2025-01-04");
    expect(result[1].value).toBeCloseTo(102.5, 5);
  });

  it("returns empty for period > data length", () => {
    expect(computeEMA(SAMPLE_BARS.slice(0, 2), 5)).toEqual([]);
  });

  it("converges toward latest prices", () => {
    // With an upward trend, EMA should be below the latest close
    // but above the SMA (EMA weights recent data more)
    const ema = computeEMA(SAMPLE_BARS, 3);
    const sma = computeSMA(SAMPLE_BARS, 3);
    const lastEma = ema[ema.length - 1].value;
    const lastSma = sma[sma.length - 1].value;
    const lastClose = SAMPLE_BARS[SAMPLE_BARS.length - 1].close;

    // In an uptrend, EMA > SMA (more responsive to recent prices)
    expect(lastEma).toBeGreaterThan(lastSma);
    // Both should be below the latest close in an uptrend
    expect(lastEma).toBeLessThan(lastClose);
  });
});

describe("normalizeToPercent", () => {
  it("normalizes first bar to 0%", () => {
    const result = normalizeToPercent(SAMPLE_BARS);
    expect(result[0].value).toBe(0);
  });

  it("computes correct percentage changes", () => {
    const result = normalizeToPercent(SAMPLE_BARS);
    // Bar 1: (102-100)/100 * 100 = 2%
    expect(result[1].value).toBeCloseTo(2, 5);
    // Last bar: (110-100)/100 * 100 = 10%
    expect(result[9].value).toBeCloseTo(10, 5);
  });

  it("handles negative changes", () => {
    const bars = [
      { date: "2025-01-01", close: 100 },
      { date: "2025-01-02", close: 95 },
    ];
    const result = normalizeToPercent(bars);
    expect(result[1].value).toBeCloseTo(-5, 5);
  });

  it("returns empty for empty input", () => {
    expect(normalizeToPercent([])).toEqual([]);
  });

  it("returns empty when base price is zero", () => {
    expect(normalizeToPercent([{ date: "2025-01-01", close: 0 }])).toEqual([]);
  });
});

// ─── ATR tests ────────────────────────────────────────────────────

function makeOHLC(
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

describe("computeATR", () => {
  const TRENDING_BARS = makeOHLC([
    ["2025-01-01", 100, 102, 99, 101],
    ["2025-01-02", 101, 103, 100, 102],
    ["2025-01-03", 102, 104, 101, 103],
    ["2025-01-04", 103, 105, 102, 104],
    ["2025-01-05", 104, 106, 103, 105],
    ["2025-01-06", 105, 107, 104, 106],
    ["2025-01-07", 106, 108, 105, 107],
    ["2025-01-08", 107, 109, 106, 108],
    ["2025-01-09", 108, 110, 107, 109],
    ["2025-01-10", 109, 111, 108, 110],
    ["2025-01-11", 110, 112, 109, 111],
    ["2025-01-12", 111, 113, 110, 112],
    ["2025-01-13", 112, 114, 111, 113],
    ["2025-01-14", 113, 115, 112, 114],
    ["2025-01-15", 114, 116, 113, 115],
  ]);

  it("returns empty if there aren't enough bars for period+1 TRs", () => {
    // period=14 needs >=15 bars (14 TRs from 15 bars). 14 bars = 13 TRs = insufficient.
    expect(computeATR(TRENDING_BARS.slice(0, 14), 14)).toEqual([]);
    expect(computeATR(TRENDING_BARS, 14)).toHaveLength(1);
  });

  it("seeds with simple average of first `period` TRs", () => {
    // For these uniform bars, every TR is 3 (high-low=3, no gap). So ATR = 3.
    const atr = computeATR(TRENDING_BARS, 14);
    expect(atr[0].date).toBe("2025-01-15");
    expect(atr[0].value).toBeCloseTo(3, 5);
  });

  it("handles a gap up (TR = high - prev_close)", () => {
    const gappy = makeOHLC([
      ["2025-01-01", 100, 102, 99, 101],
      ["2025-01-02", 101, 103, 100, 102],
      ["2025-01-03", 108, 110, 107, 109], // gap up, TR = 110 - 102 = 8
    ]);
    const atr = computeATR(gappy, 2);
    // TRs: bar1 TR = max(103-100, |103-101|, |100-101|) = 3
    //      bar2 TR = max(110-107, |110-102|, |107-102|) = 8
    // ATR[0] at period=2 = avg(3, 8) = 5.5
    expect(atr).toHaveLength(1);
    expect(atr[0].date).toBe("2025-01-03");
    expect(atr[0].value).toBeCloseTo(5.5, 5);
  });

  it("applies Wilder's smoothing after the seed", () => {
    // After the seed ATR, the next value uses ((p-1)*atr + tr)/p.
    const bars = makeOHLC([
      ["2025-01-01", 100, 102, 99, 101],
      ["2025-01-02", 101, 103, 100, 102], // TR=3
      ["2025-01-03", 102, 104, 101, 103], // TR=3
      ["2025-01-04", 103, 110, 102, 109], // TR=8
    ]);
    const atr = computeATR(bars, 2);
    // TRs: [3, 3, 8]
    // Seed = avg(TR[0], TR[1]) = 3
    // Next = ((2-1)*3 + 8)/2 = (3+8)/2 = 5.5
    expect(atr).toHaveLength(2);
    expect(atr[0].value).toBeCloseTo(3, 5);
    expect(atr[1].value).toBeCloseTo(5.5, 5);
  });

  it("returns empty for period < 1", () => {
    expect(computeATR(TRENDING_BARS, 0)).toEqual([]);
  });
});

// ─── Pivot detection tests ────────────────────────────────────────

describe("computePivotLevels", () => {
  it("detects a clean pivot high in the middle", () => {
    // Bar 3 has high=110, surrounded by 3 lower bars each side.
    const bars = makeOHLC([
      ["2025-01-01", 100, 101, 99, 100],
      ["2025-01-02", 100, 103, 99, 100],
      ["2025-01-03", 100, 105, 99, 100],
      ["2025-01-04", 100, 110, 99, 100], // <-- pivot high
      ["2025-01-05", 100, 105, 99, 100],
      ["2025-01-06", 100, 103, 99, 100],
      ["2025-01-07", 100, 101, 99, 100],
    ]);
    const pivots = computePivotLevels(bars, { strength: 3 });
    expect(pivots).toHaveLength(1);
    expect(pivots[0]).toEqual({
      date: "2025-01-04",
      price: 110,
      type: "high",
    });
  });

  it("detects a clean pivot low in the middle", () => {
    const bars = makeOHLC([
      ["2025-01-01", 100, 101, 99, 100],
      ["2025-01-02", 100, 101, 96, 100],
      ["2025-01-03", 100, 101, 94, 100],
      ["2025-01-04", 100, 101, 90, 100], // <-- pivot low
      ["2025-01-05", 100, 101, 94, 100],
      ["2025-01-06", 100, 101, 96, 100],
      ["2025-01-07", 100, 101, 99, 100],
    ]);
    const pivots = computePivotLevels(bars, { strength: 3 });
    expect(pivots).toHaveLength(1);
    expect(pivots[0]).toEqual({
      date: "2025-01-04",
      price: 90,
      type: "low",
    });
  });

  it("excludes the last `strength` bars (no right-side context)", () => {
    // Put a pivot-shaped high on the second-to-last bar. With strength=3, that
    // bar can't be a pivot because there aren't 3 bars to its right.
    const bars = makeOHLC([
      ["2025-01-01", 100, 101, 99, 100],
      ["2025-01-02", 100, 101, 99, 100],
      ["2025-01-03", 100, 101, 99, 100],
      ["2025-01-04", 100, 120, 99, 100],
      ["2025-01-05", 100, 101, 99, 100], // only 1 bar after the "pivot"
    ]);
    const pivots = computePivotLevels(bars, { strength: 3 });
    expect(pivots).toEqual([]);
  });

  it("with twin-tops: first bar qualifies, second does not (dedupes plateaus)", () => {
    // Two adjacent bars share the same high of 110. Bar 1 of the pair has no
    // left neighbor at-or-above its high so it qualifies; bar 2 is
    // disqualified because its left neighbor (bar 1) ties its high (>=
    // check). Result: exactly one pivot recorded, at the start of the
    // plateau — which is the behavior we want for clustering.
    const bars = makeOHLC([
      ["2025-01-01", 100, 100, 99, 100],
      ["2025-01-02", 100, 103, 99, 100],
      ["2025-01-03", 100, 105, 99, 100],
      ["2025-01-04", 100, 110, 99, 100], // first twin-top
      ["2025-01-05", 100, 110, 99, 100], // second twin-top
      ["2025-01-06", 100, 105, 99, 100],
      ["2025-01-07", 100, 103, 99, 100],
      ["2025-01-08", 100, 100, 99, 100],
    ]);
    const pivots = computePivotLevels(bars, { strength: 3 });
    const highs = pivots.filter((p) => p.type === "high");
    expect(highs.map((p) => p.date)).toEqual(["2025-01-04"]);
  });

  it("returns empty when too few bars to have a pivot window", () => {
    expect(computePivotLevels(makeOHLC([]), { strength: 3 })).toEqual([]);
    expect(
      computePivotLevels(
        makeOHLC([
          ["2025-01-01", 100, 101, 99, 100],
          ["2025-01-02", 100, 103, 99, 100],
        ]),
        { strength: 3 },
      ),
    ).toEqual([]);
  });

  it("default strength=3 is used when options omitted", () => {
    const bars = makeOHLC([
      ["2025-01-01", 100, 101, 99, 100],
      ["2025-01-02", 100, 102, 99, 100],
      ["2025-01-03", 100, 103, 99, 100],
      ["2025-01-04", 100, 110, 99, 100],
      ["2025-01-05", 100, 103, 99, 100],
      ["2025-01-06", 100, 102, 99, 100],
      ["2025-01-07", 100, 101, 99, 100],
    ]);
    const pivots = computePivotLevels(bars);
    expect(pivots.map((p) => p.date)).toEqual(["2025-01-04"]);
  });
});

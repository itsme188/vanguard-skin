import { describe, it, expect } from "vitest";
import { computeSMA, computeEMA, normalizeToPercent } from "@/lib/chart/indicators";

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

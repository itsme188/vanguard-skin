import { describe, it, expect } from "vitest";
import {
  betaConfidenceVerdict,
  MIN_BETA_R_SQUARED,
  MIN_BETA_PAIRS,
} from "@/lib/compute/beta-confidence";
import { computeBeta } from "@/scripts/refresh-vanguard-betas";

describe("betaConfidenceVerdict", () => {
  it("rejects a regression with no explanatory power (low r²)", () => {
    expect(betaConfidenceVerdict({ rSquared: 0.05, pairs: 60 })).toEqual({
      ok: false,
      reason: "low_r2",
    });
  });

  it("rejects a regression with too few aligned pairs", () => {
    expect(betaConfidenceVerdict({ rSquared: 0.5, pairs: 20 })).toEqual({
      ok: false,
      reason: "few_pairs",
    });
  });

  it("accepts a regression that clears both thresholds", () => {
    expect(betaConfidenceVerdict({ rSquared: 0.5, pairs: 60 })).toEqual({ ok: true });
  });

  it("treats the thresholds as inclusive boundaries", () => {
    expect(betaConfidenceVerdict({ rSquared: MIN_BETA_R_SQUARED, pairs: 60 })).toEqual({
      ok: true,
    });
    expect(betaConfidenceVerdict({ rSquared: 0.5, pairs: MIN_BETA_PAIRS })).toEqual({
      ok: true,
    });
    // …and rejects just below each boundary
    expect(betaConfidenceVerdict({ rSquared: MIN_BETA_R_SQUARED - 1e-9, pairs: 60 }).ok).toBe(
      false,
    );
    expect(betaConfidenceVerdict({ rSquared: 0.5, pairs: MIN_BETA_PAIRS - 1 }).ok).toBe(false);
  });

  it("reports few_pairs when both gates fail (sample size is the deeper defect)", () => {
    expect(betaConfidenceVerdict({ rSquared: 0.01, pairs: 5 })).toEqual({
      ok: false,
      reason: "few_pairs",
    });
  });

  it("rejects a non-finite r² (degenerate zero-variance series)", () => {
    expect(betaConfidenceVerdict({ rSquared: NaN, pairs: 60 })).toEqual({
      ok: false,
      reason: "low_r2",
    });
  });

  it("pins the approved thresholds", () => {
    expect(MIN_BETA_R_SQUARED).toBe(0.1);
    expect(MIN_BETA_PAIRS).toBe(30);
  });
});

// ─── OLS helper: r² / pairs on a synthetic series ─────────────────

/** Deterministic pseudo-random in [-1, 1) — no Math.random, so runs are stable. */
function pseudo(i: number, salt: number): number {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
}

function toPriceMap(returns: number[], start = 100): Map<string, number> {
  const map = new Map<string, number>();
  let price = start;
  // Consecutive calendar days keep every pair inside MAX_RETURN_GAP_DAYS.
  const base = new Date("2025-01-01T12:00:00Z");
  map.set(base.toISOString().slice(0, 10), price);
  for (let i = 0; i < returns.length; i++) {
    price *= Math.exp(returns[i]);
    const d = new Date(base.getTime() + (i + 1) * 86_400_000);
    map.set(d.toISOString().slice(0, 10), price);
  }
  return map;
}

describe("computeBeta (OLS helper)", () => {
  const N = 80;

  it("recovers beta≈1.2 with high r² when the stock is a levered copy of SPY", () => {
    const spyReturns: number[] = [];
    const stockReturns: number[] = [];
    for (let i = 0; i < N; i++) {
      const mkt = 0.01 * pseudo(i, 1);
      spyReturns.push(mkt);
      stockReturns.push(1.2 * mkt + 0.0002 * pseudo(i, 2)); // tiny idiosyncratic noise
    }

    const result = computeBeta(toPriceMap(stockReturns), toPriceMap(spyReturns, 400));
    expect(result).not.toBeNull();
    expect(result!.pairs).toBe(N);
    expect(result!.beta).toBeCloseTo(1.2, 1);
    expect(result!.rSquared).toBeGreaterThan(0.9);
    expect(betaConfidenceVerdict(result!).ok).toBe(true);
  });

  it("reports r² < 0.1 when the stock is pure noise vs SPY", () => {
    const spyReturns: number[] = [];
    const stockReturns: number[] = [];
    for (let i = 0; i < N; i++) {
      spyReturns.push(0.01 * pseudo(i, 3));
      stockReturns.push(0.02 * pseudo(i, 99)); // independent series
    }

    const result = computeBeta(toPriceMap(stockReturns), toPriceMap(spyReturns, 400));
    expect(result).not.toBeNull();
    expect(result!.pairs).toBe(N);
    expect(result!.rSquared).toBeLessThan(0.1);
    expect(betaConfidenceVerdict(result!)).toEqual({ ok: false, reason: "low_r2" });
  });

  it("still returns the regression when there are too few pairs, so the gate can see n", () => {
    const spyReturns: number[] = [];
    const stockReturns: number[] = [];
    for (let i = 0; i < 10; i++) {
      const mkt = 0.01 * pseudo(i, 5);
      spyReturns.push(mkt);
      stockReturns.push(mkt);
    }

    const result = computeBeta(toPriceMap(stockReturns), toPriceMap(spyReturns, 400));
    expect(result).not.toBeNull();
    expect(result!.pairs).toBe(10);
    expect(betaConfidenceVerdict(result!)).toEqual({ ok: false, reason: "few_pairs" });
  });
});

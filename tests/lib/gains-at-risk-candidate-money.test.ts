import { describe, it, expect } from "vitest";
import {
  budgetToUnits,
  sizeCandidate,
  toMoneyUnits,
  unitsToUsd,
} from "@/lib/analysis/gains-at-risk-candidate-money";
import { CANDIDATE_BOUNDS, TRIAL_POSITION_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";

// Gains at risk step 3 (D9): candidate sizing in exact units of 1/10,000 of a
// dollar. Invented prices and budgets only.

/** A small deterministic generator, so the property run is the same every time. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("toMoneyUnits", () => {
  it("reads grid prices exactly and refuses anything off the grid, negative or not finite", () => {
    expect(toMoneyUnits(0.1)).toBe(1_000);
    expect(toMoneyUnits(0.2)).toBe(2_000);
    expect(toMoneyUnits(3.2)).toBe(32_000);
    expect(toMoneyUnits(0.0001)).toBe(1);
    expect(toMoneyUnits(0)).toBe(0);
    expect(toMoneyUnits(0.12345)).toBeNull();
    expect(toMoneyUnits(-0.1)).toBeNull();
    expect(toMoneyUnits(Number.NaN)).toBeNull();
    expect(toMoneyUnits(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("budgetToUnits", () => {
  it("accepts whole cents above 0 up to the bound", () => {
    expect(budgetToUnits(45)).toBe(450_000);
    expect(budgetToUnits(319.99)).toBe(3_199_900);
    expect(budgetToUnits(0.01)).toBe(100);
    expect(budgetToUnits(CANDIDATE_BOUNDS.maxBudgetUsd)).toBe(CANDIDATE_BOUNDS.maxBudgetUsd * 10_000);
  });

  it("budgetToUnits refuses 10.005, 0, -1 and 10,000,000.01", () => {
    for (const bad of [10.005, 0, -1, 10_000_000.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(budgetToUnits(bad), String(bad)).toBeNull();
    }
  });
});

describe("sizeCandidate (T12)", () => {
  it("T12 exact budget: mid 0.15 (bid 0.10, ask 0.20), budget 45.00 → 3 contracts, cost 45.00, unspent 0", () => {
    const s = sizeCandidate(budgetToUnits(45)!, toMoneyUnits(0.1)!, toMoneyUnits(0.2)!);
    expect(s).toEqual({ perContractUnits: 150_000, contracts: 3, capped: false, costUnits: 450_000, unspentUnits: 0 });
    // The floating floor this replaces buys one too few: 45 / (0.15 x 100) is 2.9999999999999996.
    expect(Math.floor(45 / (((0.1 + 0.2) / 2) * 100))).toBe(2);
  });

  it("T12 half-cent mid: bid 0.01, ask 0.02 → per contract $1.50 exactly", () => {
    expect(sizeCandidate(budgetToUnits(10)!, 100, 200).perContractUnits).toBe(15_000);
    expect(unitsToUsd(15_000)).toBe(1.5);
  });

  it("T12 cap: mid 0.05, budget 10,000 → 500 contracts, capped, unspent 7,500", () => {
    const s = sizeCandidate(budgetToUnits(10_000)!, toMoneyUnits(0.05)!, toMoneyUnits(0.05)!);
    expect(s).toEqual({
      perContractUnits: 50_000,
      contracts: TRIAL_POSITION_BOUNDS.maxContracts,
      capped: true,
      costUnits: 500 * 50_000,
      unspentUnits: 100_000_000 - 25_000_000,
    });
    expect(unitsToUsd(s.unspentUnits)).toBe(7_500);
  });

  it("T12 one cent under one contract: mid 3.20, budget 319.99 → 0 contracts, unspent = budget", () => {
    const budget = budgetToUnits(319.99)!;
    const s = sizeCandidate(budget, toMoneyUnits(3.1)!, toMoneyUnits(3.3)!);
    expect(s).toEqual({ perContractUnits: 3_200_000, contracts: 0, capped: false, costUnits: 0, unspentUnits: budget });
  });

  it("T12 property: for 2,000 random grid prices and whole-cent budgets, cost + unspent === budget and cost === contracts x perContract (integers)", () => {
    const rnd = lcg(20261125);
    for (let n = 0; n < 2_000; n++) {
      // Ticks of a cent or a nickel, up to $50; whole-cent budgets up to $50,000.
      const tick = rnd() < 0.5 ? 100 : 500;
      const bid = (1 + Math.floor(rnd() * 1_000)) * tick;
      const ask = bid + Math.floor(rnd() * 20) * tick;
      const budget = (1 + Math.floor(rnd() * 5_000_000)) * 100;
      const s = sizeCandidate(budget, bid, ask);
      for (const v of [s.perContractUnits, s.contracts, s.costUnits, s.unspentUnits]) expect(Number.isSafeInteger(v)).toBe(true);
      expect(s.perContractUnits).toBe((bid + ask) * 50);
      expect(s.costUnits).toBe(s.contracts * s.perContractUnits);
      expect(s.costUnits + s.unspentUnits).toBe(budget);
      expect(s.unspentUnits).toBeGreaterThanOrEqual(0);
      if (s.capped) expect(s.contracts).toBe(TRIAL_POSITION_BOUNDS.maxContracts);
      else expect(s.unspentUnits).toBeLessThan(s.perContractUnits);
    }
  });

  it("refuses inputs that are not safe whole units or a zero per-contract price", () => {
    expect(() => sizeCandidate(100, 0, 0)).toThrow(RangeError);
    expect(() => sizeCandidate(100.5, 1, 1)).toThrow(RangeError);
    expect(() => sizeCandidate(100, 1e16, 1e16)).toThrow(RangeError);
  });
});

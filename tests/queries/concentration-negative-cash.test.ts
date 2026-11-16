import { describe, it, expect } from "vitest";
import { splitConcentrationUniverse, type ConcentrationPosition } from "@/lib/queries/concentration-universe";

// Review round 5 (2026-11-15), R4: a NEGATIVE cash-equivalent value is
// borrowing (leverage), never dilution. It stays out of the cash bucket and
// out of the gross denominator, and is reported on its own.

let nextId = 1;
const pos = (symbol: string, marketValue: number, isCashEquivalent = false): ConcentrationPosition => ({
  securityId: nextId++,
  symbol,
  securityName: symbol,
  marketValue,
  priced: true,
  valuedAfterAsOf: false,
  isCashEquivalent,
});

describe("splitConcentrationUniverse: borrowed cash is not dilution", () => {
  it("a negative cash-equivalent does not lower the index", () => {
    const withDebit = splitConcentrationUniverse([pos("ZZA", 100), pos("ZZM", -50, true)]);
    const without = splitConcentrationUniverse([pos("ZZA", 100)]);
    expect(withDebit.grossValue).toBe(100);
    expect(withDebit.herfindahl).toBe(without.herfindahl);
    expect(withDebit.herfindahl).toBe(1);
    expect(withDebit.cash).toEqual({ marketValue: 0, weight: 0, holdingCount: 0 });
    expect(withDebit.negativeCash).toEqual({ marketValue: -50, holdingCount: 1 });
  });

  it("positive cash still dilutes; a negative line beside it is left out", () => {
    const s = splitConcentrationUniverse([pos("ZZA", 100), pos("ZZM", 100, true), pos("ZZN", -40, true)]);
    expect(s.grossValue).toBe(200);
    expect(s.cash).toEqual({ marketValue: 100, weight: 0.5, holdingCount: 1 });
    expect(s.herfindahl).toBeCloseTo(0.25, 12);
    expect(s.negativeCash).toEqual({ marketValue: -40, holdingCount: 1 });
  });

  it("a book with no negative cash reports none and is unchanged", () => {
    const s = splitConcentrationUniverse([pos("ZZA", 100), pos("ZZB", -60), pos("ZZM", 40, true)]);
    expect(s.grossValue).toBe(200);
    expect(s.cash.weight).toBeCloseTo(0.2, 12);
    expect(s.herfindahl).toBeCloseTo(0.34, 12);
    expect(s.negativeCash).toEqual({ marketValue: 0, holdingCount: 0 });
  });

  it("only negative cash and nothing else: nothing to measure", () => {
    const s = splitConcentrationUniverse([pos("ZZM", -50, true)]);
    expect(s.grossValue).toBe(0);
    expect(s.herfindahl).toBeNull();
    expect(s.cash.weight).toBe(0);
  });
});

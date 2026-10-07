import { describe, it, expect } from "vitest";
import { hasKnownBasis } from "@/lib/compute/known-basis";

/**
 * The one "do we know what this position cost" rule, shared by the two
 * holdings tables. Mirrors the query's NULLIF(cost, 0) IS NOT NULL.
 */
describe("hasKnownBasis", () => {
  it("a positive basis is known", () => {
    expect(hasKnownBasis({ cost_basis: 1000 })).toBe(true);
    expect(hasKnownBasis({ cost_basis: 0.01 })).toBe(true);
  });

  it("a short's negative basis (its proceeds) is known", () => {
    expect(hasKnownBasis({ cost_basis: -600 })).toBe(true);
  });

  it("null, undefined and a stored zero are all unknown", () => {
    expect(hasKnownBasis({ cost_basis: null })).toBe(false);
    expect(hasKnownBasis({ cost_basis: undefined })).toBe(false);
    expect(hasKnownBasis({ cost_basis: 0 })).toBe(false);
    expect(hasKnownBasis({ cost_basis: -0 })).toBe(false);
  });

  it("works as a filter callback on rows that carry other fields", () => {
    const rows = [
      { symbol: "ZZAAA", cost_basis: 100 },
      { symbol: "ZZBBB", cost_basis: 0 },
      { symbol: "ZZCCC", cost_basis: null },
    ];
    expect(rows.filter(hasKnownBasis).map((r) => r.symbol)).toEqual(["ZZAAA"]);
  });
});

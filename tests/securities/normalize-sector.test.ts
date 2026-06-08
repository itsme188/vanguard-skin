// tests/securities/normalize-sector.test.ts
import { describe, it, expect } from "vitest";
import { normalizeSector, GICS_SECTORS } from "@/lib/securities/normalize-sector";

describe("normalizeSector", () => {
  it("maps Bloomberg vocabulary to canonical GICS", () => {
    expect(normalizeSector("Communications")).toBe("Communication Services");
    expect(normalizeSector("Financial")).toBe("Financials");
    expect(normalizeSector("Industrial")).toBe("Industrials");
    expect(normalizeSector("Consumer, Cyclical")).toBe("Consumer Discretionary");
    expect(normalizeSector("Consumer, Non-cyclical")).toBe("Consumer Staples");
    expect(normalizeSector("Basic Materials")).toBe("Materials");
    expect(normalizeSector("Health Care")).toBe("Healthcare");
    expect(normalizeSector("Information Technology")).toBe("Technology");
  });
  it("passes canonical GICS labels through unchanged", () => {
    for (const s of GICS_SECTORS) expect(normalizeSector(s)).toBe(s);
  });
  it("is case- and whitespace-insensitive", () => {
    expect(normalizeSector("  financials ")).toBe("Financials");
    expect(normalizeSector("TECHNOLOGY")).toBe("Technology");
  });
  it("returns null for blank/unknown", () => {
    expect(normalizeSector("")).toBeNull();
    expect(normalizeSector(null)).toBeNull();
    expect(normalizeSector("   ")).toBeNull();
    expect(normalizeSector("Wat")).toBeNull();
  });
  it("passes through non-GICS fund/asset labels untouched", () => {
    expect(normalizeSector("Diversified")).toBe("Diversified");
    expect(normalizeSector("Fixed Income")).toBe("Fixed Income");
  });
});

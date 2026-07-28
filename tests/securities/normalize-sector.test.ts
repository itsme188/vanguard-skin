// tests/securities/normalize-sector.test.ts
import { describe, it, expect } from "vitest";
import { normalizeSector, GICS_SECTORS } from "@/lib/securities/normalize-sector";

describe("normalizeSector", () => {
  it("maps surviving Bloomberg aliases to canonical GICS; demoted buckets return null", () => {
    // "Communications", "Financial", "Consumer, Cyclical" and "Consumer,
    // Non-cyclical" were demoted 2026-07-28 — see the ALIASES doc comment
    // and the dedicated describe block below.
    expect(normalizeSector("Communications")).toBeNull();
    expect(normalizeSector("Financial")).toBeNull();
    expect(normalizeSector("Industrial")).toBe("Industrials");
    expect(normalizeSector("Consumer, Cyclical")).toBeNull();
    expect(normalizeSector("Consumer, Non-cyclical")).toBeNull();
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

  it("passes through non-GICS labels case-insensitively, returning canonical casing", () => {
    expect(normalizeSector("diversified")).toBe("Diversified");
    expect(normalizeSector("FIXED INCOME")).toBe("Fixed Income");
    expect(normalizeSector("  fixed income ")).toBe("Fixed Income");
  });
});

describe("demoted Bloomberg buckets (structurally non-GICS — never re-alias)", () => {
  it.each([
    "Communications",
    "Consumer, Non-cyclical",
    "Consumer Non-cyclical",
    "Consumer non cyclical",
    "Consumer, Cyclical",
    "Consumer Cyclical",
    "Financial",
  ])("returns null for %s", (raw) => {
    expect(normalizeSector(raw)).toBeNull();
  });

  it("keeps the safe aliases", () => {
    expect(normalizeSector("Basic Materials")).toBe("Materials");
    expect(normalizeSector("Health Care")).toBe("Healthcare");
    expect(normalizeSector("Industrial")).toBe("Industrials");
    expect(normalizeSector("Information Technology")).toBe("Technology");
    expect(normalizeSector("Financials")).toBe("Financials");
    expect(normalizeSector("Communication Services")).toBe("Communication Services");
  });
});

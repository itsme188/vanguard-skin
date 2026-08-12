// tests/securities/normalize-fund-category.test.ts
//
// Pins the fund_category vocabulary normalizer: the Claude classification
// fallback emitted bare sector names ("Technology", "Semiconductor",
// "Financial Services") while the static map uses the "US Sector Equity (X)"
// scheme, fragmenting the Classification allocation into parallel buckets
// (Technology 12.1% + US Sector Equity (Technology) 17.0% were the same
// exposure). Synonyms merge to the canonical scheme; everything else passes
// through unchanged (fund_category is an open vocabulary, unlike GICS).
import { describe, it, expect } from "vitest";
import { normalizeFundCategory } from "@/lib/securities/normalize-fund-category";

describe("normalizeFundCategory", () => {
  it("maps bare sector names to the US Sector Equity scheme", () => {
    expect(normalizeFundCategory("Technology")).toBe("US Sector Equity (Technology)");
    expect(normalizeFundCategory("Semiconductor")).toBe("US Sector Equity (Semiconductors)");
    expect(normalizeFundCategory("Semiconductors")).toBe("US Sector Equity (Semiconductors)");
    expect(normalizeFundCategory("Healthcare")).toBe("US Sector Equity (Health Care)");
    expect(normalizeFundCategory("Health Care")).toBe("US Sector Equity (Health Care)");
    expect(normalizeFundCategory("Biotechnology")).toBe("US Sector Equity (Health Care/Biotech)");
    expect(normalizeFundCategory("Financials")).toBe("US Sector Equity (Financial)");
    expect(normalizeFundCategory("Financial Services")).toBe("US Sector Equity (Financial)");
    expect(normalizeFundCategory("Industrials")).toBe("US Sector Equity (Industrials)");
    expect(normalizeFundCategory("Basic Materials")).toBe("US Sector Equity (Materials)");
    expect(normalizeFundCategory("Consumer Cyclical")).toBe("US Sector Equity (Consumer Discretionary)");
    expect(normalizeFundCategory("Consumer Defensive")).toBe("US Sector Equity (Consumer Staples)");
    expect(normalizeFundCategory("Communication Services")).toBe("US Sector Equity (Communication Services)");
    expect(normalizeFundCategory("Energy")).toBe("US Sector Equity (Energy)");
    expect(normalizeFundCategory("Real Estate")).toBe("US Sector Equity (Real Estate)");
    expect(normalizeFundCategory("Utilities")).toBe("US Sector Equity (Utilities)");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeFundCategory("  technology ")).toBe("US Sector Equity (Technology)");
    expect(normalizeFundCategory("FINANCIAL SERVICES")).toBe("US Sector Equity (Financial)");
  });

  it("passes canonical and unrelated labels through unchanged", () => {
    expect(normalizeFundCategory("US Sector Equity (Technology)")).toBe("US Sector Equity (Technology)");
    expect(normalizeFundCategory("US Large Cap Equity")).toBe("US Large Cap Equity");
    expect(normalizeFundCategory("US Treasury")).toBe("US Treasury");
    expect(normalizeFundCategory("Options")).toBe("Options");
    expect(normalizeFundCategory("Leveraged ETF")).toBe("Leveraged ETF");
    expect(normalizeFundCategory("Healthcare Staffing")).toBe("Healthcare Staffing");
    expect(normalizeFundCategory("US Sector Equity (Real Estate/Homebuilders)")).toBe(
      "US Sector Equity (Real Estate/Homebuilders)"
    );
  });

  it("returns null/undefined input as null", () => {
    expect(normalizeFundCategory(null)).toBeNull();
    expect(normalizeFundCategory(undefined)).toBeNull();
    expect(normalizeFundCategory("")).toBeNull();
    expect(normalizeFundCategory("   ")).toBeNull();
  });

  // Regression (2026-08-12): auto_ai wrote ALREADY-WRAPPED "US Sector Equity (X)"
  // labels where X was a Bloomberg/GICS synonym instead of the canonical sector
  // name — e.g. "US Sector Equity (Information Technology)" instead of
  // "US Sector Equity (Technology)". The bare-synonym ALIASES table above never
  // matched because the input wasn't bare, so these slipped through as brand new
  // duplicate allocation buckets. Unwrap the parenthetical, canonicalize the
  // inner sector via normalizeSector (single source of truth for GICS-11 synonyms),
  // then re-map through the same ALIASES table used for bare input.
  it("canonicalizes sector synonyms inside an already-wrapped US Sector Equity(...) label", () => {
    expect(normalizeFundCategory("US Sector Equity (Information Technology)")).toBe(
      "US Sector Equity (Technology)"
    );
    expect(normalizeFundCategory("US Sector Equity (Info Technology)")).toBe(
      "US Sector Equity (Technology)"
    );
    // GICS canonical sector name is plural "Financials", but this codebase's
    // fund_category vocabulary uses singular "Financial" (see bare-synonym test
    // above) — the wrapped form must match, not the raw GICS output.
    expect(normalizeFundCategory("US Sector Equity (Financials)")).toBe(
      "US Sector Equity (Financial)"
    );
    expect(normalizeFundCategory("US Sector Equity (Industrial)")).toBe(
      "US Sector Equity (Industrials)"
    );
    expect(normalizeFundCategory("US Sector Equity (Health Care)")).toBe(
      "US Sector Equity (Health Care)"
    );
  });

  it("leaves an unrecognized wrapped sector label unchanged", () => {
    // "Semiconductors" is not a GICS-11 sector, so normalizeSector can't
    // canonicalize it — must fall through untouched (matches the existing
    // "US Sector Equity (Real Estate/Homebuilders)" passthrough behavior).
    expect(normalizeFundCategory("US Sector Equity (Semiconductors)")).toBe(
      "US Sector Equity (Semiconductors)"
    );
  });
});

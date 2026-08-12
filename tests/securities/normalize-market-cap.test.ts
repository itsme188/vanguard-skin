// tests/securities/normalize-market-cap.test.ts
//
// Pins the market_cap_category vocabulary normalizer: the Claude classification
// fallback (classifyUnresolvedWithClaude) emits bare cap-size labels ("Large",
// "Mid", "Small") per its prompt enum, while every other classification source
// (static lookup, auto_option, manual) writes the "X Cap" scheme ("Large Cap",
// "Mid Cap", "Small Cap"). Without normalizing, one cap-size bucket fragments
// into two rows on the Allocation donut (Large 12% + Large Cap 34% are the same
// exposure). Synonyms merge to the canonical scheme; everything else passes
// through unchanged.
import { describe, it, expect } from "vitest";
import { normalizeMarketCapCategory } from "@/lib/securities/normalize-market-cap";

describe("normalizeMarketCapCategory", () => {
  it("maps bare cap-size labels to the canonical 'X Cap' scheme", () => {
    expect(normalizeMarketCapCategory("Large")).toBe("Large Cap");
    expect(normalizeMarketCapCategory("Mid")).toBe("Mid Cap");
    expect(normalizeMarketCapCategory("Small")).toBe("Small Cap");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeMarketCapCategory("  large ")).toBe("Large Cap");
    expect(normalizeMarketCapCategory("MID")).toBe("Mid Cap");
    expect(normalizeMarketCapCategory("small")).toBe("Small Cap");
  });

  it("passes canonical and unrelated labels through unchanged", () => {
    expect(normalizeMarketCapCategory("Large Cap")).toBe("Large Cap");
    expect(normalizeMarketCapCategory("Mid Cap")).toBe("Mid Cap");
    expect(normalizeMarketCapCategory("Small Cap")).toBe("Small Cap");
    expect(normalizeMarketCapCategory("Multi-Cap")).toBe("Multi-Cap");
  });

  it("returns null/undefined/empty input as null", () => {
    expect(normalizeMarketCapCategory(null)).toBeNull();
    expect(normalizeMarketCapCategory(undefined)).toBeNull();
    expect(normalizeMarketCapCategory("")).toBeNull();
    expect(normalizeMarketCapCategory("   ")).toBeNull();
  });
});

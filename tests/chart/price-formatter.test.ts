import { describe, it, expect } from "vitest";
import { formatChartPrice } from "@/lib/chart/price-formatter";

describe("formatChartPrice", () => {
  describe("USD (and USD-equivalent inputs)", () => {
    it("formats USD with two decimals and no thousands separator", () => {
      expect(formatChartPrice("USD", 648.84)).toBe("$648.84");
      expect(formatChartPrice("USD", 1234.5)).toBe("$1234.50");
    });

    it("treats null/undefined/blank currency as USD", () => {
      expect(formatChartPrice(null, 648.84)).toBe("$648.84");
      expect(formatChartPrice(undefined, 648.84)).toBe("$648.84");
      expect(formatChartPrice("", 648.84)).toBe("$648.84");
    });

    it("is case-insensitive", () => {
      expect(formatChartPrice("usd", 648.84)).toBe("$648.84");
      expect(formatChartPrice("Usd", 648.84)).toBe("$648.84");
    });
  });

  describe("KRW (non-USD, real ISO code)", () => {
    it("formats with the won symbol, grouping, and no decimals", () => {
      // 402340.KS-style native value — the exact QA-finding regression case.
      expect(formatChartPrice("KRW", 976000)).toBe("₩976,000");
    });

    it("is case-insensitive", () => {
      expect(formatChartPrice("krw", 976000)).toBe("₩976,000");
    });
  });

  describe("other real currencies", () => {
    it("formats EUR and GBP with their own symbols", () => {
      expect(formatChartPrice("EUR", 1234.5)).toBe("€1,234.50");
      expect(formatChartPrice("GBP", 1234.5)).toBe("£1,234.50");
    });
  });

  describe("exotic / malformed currency codes", () => {
    it("falls back to 'CODE 123,456.78' style instead of throwing for a malformed code", () => {
      // Not exactly 3 letters — Intl.NumberFormat throws RangeError for this.
      expect(() => formatChartPrice("ABCD", 976000)).not.toThrow();
      expect(formatChartPrice("ABCD", 976000)).toBe("ABCD 976,000.00");
    });

    it("does not throw for a well-formed but unrecognized 3-letter code", () => {
      expect(() => formatChartPrice("ZZZ", 976000)).not.toThrow();
      // The engine renders the code itself as the symbol — still no crash,
      // still grouped, still currency-labeled rather than $-labeled.
      expect(formatChartPrice("ZZZ", 976000)).not.toContain("$");
    });
  });
});

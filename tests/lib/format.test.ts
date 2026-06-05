import { describe, expect, it } from "vitest";
import {
  formatLargeNumber,
  formatLargeUSD,
  parseLargeUSD,
  parseStoredTimestamp,
} from "../../lib/format";

describe("parseStoredTimestamp", () => {
  it("parses a space-separated SQLite UTC timestamp as UTC, not local", () => {
    // Regression: bare `new Date("2026-06-05 01:49:38")` parses as local time
    // and rolls the date forward to the next day in evening US zones.
    const d = parseStoredTimestamp("2026-06-05 01:49:38");
    expect(d.getTime()).toBe(Date.UTC(2026, 5, 5, 1, 49, 38));
  });

  it("is idempotent for an explicit ISO-Z timestamp", () => {
    const d = parseStoredTimestamp("2026-06-05T01:49:38Z");
    expect(d.getTime()).toBe(Date.UTC(2026, 5, 5, 1, 49, 38));
  });

  it("respects an explicit UTC offset", () => {
    const d = parseStoredTimestamp("2026-06-04T21:49:38-04:00");
    expect(d.getTime()).toBe(Date.UTC(2026, 5, 5, 1, 49, 38));
  });
});

describe("formatLargeUSD", () => {
  it("scales billions to 2 decimal places", () => {
    expect(formatLargeUSD(4_345_870_107)).toBe("$4.35B");
    expect(formatLargeUSD(11_000_000_000)).toBe("$11.00B");
    expect(formatLargeUSD(1_000_000_000)).toBe("$1.00B");
  });

  it("scales millions to 1 decimal place", () => {
    expect(formatLargeUSD(245_000_000)).toBe("$245.0M");
    expect(formatLargeUSD(1_500_000)).toBe("$1.5M");
    expect(formatLargeUSD(999_999_999)).toBe("$1000.0M");
  });

  it("renders thousands with commas (no abbreviation)", () => {
    expect(formatLargeUSD(1_234)).toBe("$1,234");
    expect(formatLargeUSD(45_678)).toBe("$45,678");
    expect(formatLargeUSD(999_999)).toBe("$999,999");
  });

  it("renders sub-$1k EPS-scale values to 2dp", () => {
    expect(formatLargeUSD(0.91)).toBe("$0.91");
    expect(formatLargeUSD(0.46)).toBe("$0.46");
    expect(formatLargeUSD(12.34)).toBe("$12.34");
  });

  it("preserves negatives", () => {
    expect(formatLargeUSD(-4_345_870_107)).toBe("-$4.35B");
    expect(formatLargeUSD(-0.5)).toBe("-$0.50");
  });

  it("returns em-dash on non-finite", () => {
    expect(formatLargeUSD(NaN)).toBe("—");
    expect(formatLargeUSD(Infinity)).toBe("—");
  });
});

describe("formatLargeNumber", () => {
  it("scales without $ glyph", () => {
    expect(formatLargeNumber(4_345_870_107)).toBe("4.35B");
    expect(formatLargeNumber(245_000_000)).toBe("245.0M");
    expect(formatLargeNumber(45_678)).toBe("45,678");
    expect(formatLargeNumber(0.91)).toBe("0.91");
  });
});

describe("parseLargeUSD", () => {
  it("parses suffix forms", () => {
    expect(parseLargeUSD("4.34B")).toBe(4_340_000_000);
    expect(parseLargeUSD("$4.34B")).toBe(4_340_000_000);
    expect(parseLargeUSD("245M")).toBe(245_000_000);
    expect(parseLargeUSD("4,340M")).toBe(4_340_000_000);
    expect(parseLargeUSD("12.5K")).toBe(12_500);
  });

  it("parses bare numbers with commas", () => {
    expect(parseLargeUSD("4,340,000,000")).toBe(4_340_000_000);
    expect(parseLargeUSD("$1,234")).toBe(1_234);
    expect(parseLargeUSD("0.91")).toBe(0.91);
  });

  it("is case-insensitive on suffix", () => {
    expect(parseLargeUSD("4.34b")).toBe(4_340_000_000);
    expect(parseLargeUSD("245m")).toBe(245_000_000);
  });

  it("preserves negatives", () => {
    expect(parseLargeUSD("-$4.34B")).toBe(-4_340_000_000);
    expect(parseLargeUSD("-0.50")).toBe(-0.5);
  });

  it("returns null on unparseable input", () => {
    expect(parseLargeUSD("")).toBe(null);
    expect(parseLargeUSD("abc")).toBe(null);
    expect(parseLargeUSD("$$4B")).toBe(null);
    expect(parseLargeUSD(null)).toBe(null);
    expect(parseLargeUSD(undefined)).toBe(null);
  });

  it("passes through finite numbers", () => {
    expect(parseLargeUSD(4_340_000_000)).toBe(4_340_000_000);
    expect(parseLargeUSD(NaN)).toBe(null);
  });
});

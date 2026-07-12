import { describe, expect, it } from "vitest";
import {
  formatCompactOptionSymbol,
  formatLargeNumber,
  formatLargeUSD,
  formatPercent,
  formatUSD,
  formatUSDPrecise,
  parseLargeUSD,
  parseStoredTimestamp,
  rendersAsZero,
} from "../../lib/format";

// ── Negative-zero guard ──────────────────────────────────────────────
// A signed value that ROUNDS to zero must render unsigned — a near-worthless
// expiring option with a -$0.40 day move was rendering "−$0" on Today.

describe("rendersAsZero", () => {
  it("detects rounded-to-zero strings", () => {
    expect(rendersAsZero("$0")).toBe(true);
    expect(rendersAsZero("-$0.00")).toBe(true);
    expect(rendersAsZero("0.0%")).toBe(true);
    expect(rendersAsZero("-0.0")).toBe(true);
  });

  it("passes strings with significant digits", () => {
    expect(rendersAsZero("$1")).toBe(false);
    expect(rendersAsZero("-$0.01")).toBe(false);
    expect(rendersAsZero("$1,000")).toBe(false);
    expect(rendersAsZero("0.1%")).toBe(false);
  });
});

describe("formatUSD negative zero", () => {
  it("renders tiny negatives as unsigned $0", () => {
    expect(formatUSD(-0.4)).toBe("$0");
    expect(formatUSD(-0)).toBe("$0");
  });

  it("keeps the sign once a digit survives rounding", () => {
    expect(formatUSD(-1)).toBe("-$1");
    // Intl halfExpand rounds -0.5 away from zero → a real digit survives.
    expect(formatUSD(-0.5)).toBe("-$1");
  });

  it("leaves normal values untouched", () => {
    expect(formatUSD(1234)).toBe("$1,234");
    expect(formatUSD(0)).toBe("$0");
  });
});

describe("formatUSDPrecise negative zero", () => {
  it("renders sub-cent negatives as unsigned $0.00", () => {
    expect(formatUSDPrecise(-0.004)).toBe("$0.00");
    expect(formatUSDPrecise(-0)).toBe("$0.00");
  });

  it("keeps the sign for a real cent", () => {
    expect(formatUSDPrecise(-0.01)).toBe("-$0.01");
  });
});

describe("formatPercent negative zero", () => {
  it("renders tiny negatives as unsigned 0.0%", () => {
    expect(formatPercent(-0.04)).toBe("0.0%");
    expect(formatPercent(-0, 2)).toBe("0.00%");
  });

  it("keeps the sign once a digit survives rounding", () => {
    expect(formatPercent(-0.05)).toBe("-0.1%");
    expect(formatPercent(-1.23, 2)).toBe("-1.23%");
  });
});

describe("formatLargeUSD / formatLargeNumber negative zero", () => {
  it("renders tiny negatives unsigned", () => {
    expect(formatLargeUSD(-0.004)).toBe("$0.00");
    expect(formatLargeNumber(-0.004)).toBe("0.00");
  });
});

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

describe("formatCompactOptionSymbol", () => {
  it("compacts OCC symbols for narrow display columns", () => {
    expect(formatCompactOptionSymbol("KRE   270115C00070000")).toBe("KRE $70C 1/15/27");
    expect(formatCompactOptionSymbol("EWY   260717P00220000")).toBe("EWY $220P 7/17/26");
  });

  it("preserves fractional strikes without trailing zeros", () => {
    expect(formatCompactOptionSymbol("INTC  260320P00045500")).toBe("INTC $45.5P 3/20/26");
  });

  it("passes non-OCC symbols through unchanged", () => {
    expect(formatCompactOptionSymbol("AAPL")).toBe("AAPL");
    expect(formatCompactOptionSymbol("BRK/B")).toBe("BRK/B");
  });
});

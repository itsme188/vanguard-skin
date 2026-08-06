import { describe, expect, it } from "vitest";
import {
  coercePercent,
  formatCompactOptionSymbol,
  formatCompactUSD,
  formatHoldingPeriod,
  formatLargeNumber,
  formatProfitFactor,
  formatLargeUSD,
  formatPercent,
  formatUSD,
  formatUSDPrecise,
  parseLargeUSD,
  parseStoredTimestamp,
  rendersAsZero,
  unrealizedGainRatio,
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

describe("formatCompactUSD", () => {
  // QA 2026-08-02 pair: the Fixed Income denominator rendered "$1541K"
  // instead of "$1.5M", and the Breakdown/Greeks tables rendered the sign
  // INSIDE the dollar ("$-14K"). Compact scaling + sign-outside are pinned.
  it("abbreviates to M at and above $1M", () => {
    expect(formatCompactUSD(1_541_000)).toBe("$1.5M");
    expect(formatCompactUSD(1_869_000)).toBe("$1.9M");
  });

  it("abbreviates to K in the $1k–$1M band", () => {
    expect(formatCompactUSD(48_163)).toBe("$48K");
  });

  it("renders sub-$1k values whole-dollar", () => {
    expect(formatCompactUSD(945.4)).toBe("$945");
  });

  it("hoists the negative sign outside the dollar glyph", () => {
    expect(formatCompactUSD(-14_000)).toBe("-$14K");
    expect(formatCompactUSD(-2_100_000)).toBe("-$2.1M");
    expect(formatCompactUSD(-475)).toBe("-$475");
  });

  it("drops the sign when the rounded output is zero", () => {
    expect(formatCompactUSD(-0.4)).toBe("$0");
  });

  it("renders non-finite input as an em dash", () => {
    expect(formatCompactUSD(NaN)).toBe("—");
    expect(formatCompactUSD(Infinity)).toBe("—");
  });
});

describe("formatProfitFactor", () => {
  // 7/28 review follow-up: previously an untested private helper inside
  // TradeReviewView — moved to lib/format.ts (number-rendering single source).
  it("renders a measured ratio with one decimal and an x suffix", () => {
    expect(formatProfitFactor(2.34)).toBe("2.3x");
    expect(formatProfitFactor(0.8)).toBe("0.8x");
  });

  it("renders the 99.9 no-losing-trades sentinel as infinity", () => {
    // computeTradeRoundtrips clamps at 99.9 when a period has no gross
    // losses — a sentinel, not a measured ratio.
    expect(formatProfitFactor(99.9)).toBe("∞");
    expect(formatProfitFactor(120)).toBe("∞");
  });
});

describe("coercePercent (expected-move parsing, feedback #5)", () => {
  it("parses plain numbers, percent strings, and ± prefixes", () => {
    expect(coercePercent(6)).toBe(6);
    expect(coercePercent("6")).toBe(6);
    expect(coercePercent("6%")).toBe(6);
    expect(coercePercent("±6.0%")).toBe(6);
    expect(coercePercent("+/-6%")).toBe(6);
    expect(coercePercent("-5.5")).toBe(5.5); // absolute — a move is directionless
  });

  it("rejects zero, garbage, and non-finite values", () => {
    expect(coercePercent(0)).toBeNull();
    expect(coercePercent("")).toBeNull();
    expect(coercePercent("big move")).toBeNull();
    expect(coercePercent(null)).toBeNull();
    expect(coercePercent(Number.NaN)).toBeNull();
  });
});

describe("formatHoldingPeriod", () => {
  // tax_lot_sales.holding_period_days goes negative for genuine short
  // round-trips (sale paired with a later cover, 1099-B-consistent) — not
  // a defect. "-1d" reads as a bug; "short" reads as the truth.
  it("renders a negative holding period as 'short'", () => {
    expect(formatHoldingPeriod(-1)).toBe("short");
    expect(formatHoldingPeriod(-42)).toBe("short");
  });

  it("renders a non-negative holding period as 'Nd'", () => {
    expect(formatHoldingPeriod(0)).toBe("0d");
    expect(formatHoldingPeriod(1)).toBe("1d");
    expect(formatHoldingPeriod(365)).toBe("365d");
  });
});

describe("unrealizedGainRatio", () => {
  // Short positions carry a NEGATIVE cost basis (short proceeds) — the gain
  // ratio's sign must follow the DOLLAR gain, never flip on the denominator
  // (qa:security-detail-positions--short-gain-pct-sign-inverted).
  it("long position: +10% gain", () => {
    expect(unrealizedGainRatio(1000, 10000)).toBeCloseTo(0.1, 6);
  });
  it("short position losing money: negative ratio despite negative basis", () => {
    expect(unrealizedGainRatio(-730, -11009)).toBeCloseTo(-730 / 11009, 6);
  });
  it("short position making money: positive ratio", () => {
    expect(unrealizedGainRatio(76, -33000)).toBeCloseTo(76 / 33000, 6);
  });
  it("null/zero basis or null gain -> null", () => {
    expect(unrealizedGainRatio(null, 10000)).toBeNull();
    expect(unrealizedGainRatio(100, null)).toBeNull();
    expect(unrealizedGainRatio(100, 0)).toBeNull();
  });
});


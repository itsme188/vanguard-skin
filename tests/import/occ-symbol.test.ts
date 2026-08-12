import { describe, it, expect } from "vitest";
import {
  buildOCCSymbol,
  formatOccSymbol,
  isOCCFormat,
  parseOCCSymbol,
  parseOptionSymbol,
} from "@/lib/import/occ-symbol";

describe("parseOptionSymbol", () => {
  describe("OCC form", () => {
    it("parses a canonical OCC call", () => {
      const parsed = parseOptionSymbol("NVDA  260618C00175000");
      expect(parsed).toEqual({
        underlying: "NVDA",
        expirationDate: "2026-06-18",
        optionType: "CALL",
        strike: 175,
      });
    });

    it("parses a canonical OCC put", () => {
      const parsed = parseOptionSymbol("AMSC  260116P00035000");
      expect(parsed).toEqual({
        underlying: "AMSC",
        expirationDate: "2026-01-16",
        optionType: "PUT",
        strike: 35,
      });
    });

    it("parses a fractional strike (175.50)", () => {
      const parsed = parseOptionSymbol("APP   250321C00175500");
      expect(parsed?.strike).toBe(175.5);
    });
  });

  describe("Vanguard-compact human form (ROOT YYMMDD C|P STRIKE.DD)", () => {
    it("parses the finding's exact example", () => {
      const parsed = parseOptionSymbol("NVDA 260618 C 175.00");
      expect(parsed).toEqual({
        underlying: "NVDA",
        expirationDate: "2026-06-18",
        optionType: "CALL",
        strike: 175,
      });
    });

    it("parses a put", () => {
      const parsed = parseOptionSymbol("AMSC 260116 P 35.00");
      expect(parsed).toEqual({
        underlying: "AMSC",
        expirationDate: "2026-01-16",
        optionType: "PUT",
        strike: 35,
      });
    });

    it("parses a fractional strike (175.50)", () => {
      const parsed = parseOptionSymbol("APP 250321 C 175.50");
      expect(parsed?.strike).toBe(175.5);
    });

    it("parses a strike with no decimal component", () => {
      const parsed = parseOptionSymbol("HOOD 260116 C 35");
      expect(parsed?.strike).toBe(35);
    });
  });

  describe("must NOT parse (falls through to null)", () => {
    it.each([
      ["plain equity ticker", "AAPL"],
      ["ETF ticker", "SPY"],
      ["bond CUSIP-style symbol", "912828YK0"],
      ["mutual fund symbol", "VTSAX"],
      ["foreign exchange-suffixed symbol", "402340.KS"],
      ["empty string", ""],
      ["symbol with only a root and date, no right/strike", "NVDA 260618"],
      ["OCC-length garbage (21 chars, no C/P at position 12)", "NVDA  260618X00175000"],
    ])("%s: %s", (_label, symbol) => {
      expect(parseOptionSymbol(symbol)).toBeNull();
    });
  });

  it("prefers the OCC parse when a string could theoretically look OCC-shaped", () => {
    // 21-char OCC-format strings are parsed via parseOCCSymbol first; this
    // just documents that OCC takes precedence when both could apply.
    const occForm = "NVDA  260618C00175000";
    expect(parseOptionSymbol(occForm)).toEqual(parseOCCSymbol(occForm));
  });
});

describe("formatOccSymbol", () => {
  it("formats a parsed identity back to canonical OCC form", () => {
    const parsed = parseOptionSymbol("NVDA 260618 C 175.00");
    expect(parsed).not.toBeNull();
    expect(formatOccSymbol(parsed!)).toBe("NVDA  260618C00175000");
  });

  it("round-trips: both spellings of the same contract format to the identical OCC string", () => {
    const fromHuman = parseOptionSymbol("AMSC 260116 C 35.00");
    const fromOcc = parseOptionSymbol("AMSC  260116C00035000");
    expect(fromHuman).not.toBeNull();
    expect(fromOcc).not.toBeNull();
    expect(formatOccSymbol(fromHuman!)).toBe(formatOccSymbol(fromOcc!));
    expect(formatOccSymbol(fromHuman!)).toBe("AMSC  260116C00035000");
  });

  it("matches buildOCCSymbol for the same component parts", () => {
    const parsed = parseOptionSymbol("NVDA 260618 C 175.00")!;
    expect(formatOccSymbol(parsed)).toBe(
      buildOCCSymbol(parsed.underlying, parsed.expirationDate, parsed.optionType, parsed.strike),
    );
  });

  it("is idempotent on an already-canonical OCC symbol", () => {
    const occ = "NVDA  260618C00175000";
    const parsed = parseOptionSymbol(occ);
    expect(formatOccSymbol(parsed!)).toBe(occ);
  });
});

describe("isOCCFormat / parseOCCSymbol (existing behavior, unchanged)", () => {
  it("still recognizes a canonical OCC symbol", () => {
    expect(isOCCFormat("NVDA  260618C00175000")).toBe(true);
  });

  it("still rejects the Vanguard-compact human form", () => {
    expect(isOCCFormat("NVDA 260618 C 175.00")).toBe(false);
  });
});

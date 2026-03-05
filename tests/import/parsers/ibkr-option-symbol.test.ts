import { describe, it, expect } from "vitest";
import { parseIBKROptionSymbol } from "@/lib/import/parsers/ibkr-activity";

describe("parseIBKROptionSymbol", () => {
  it("parses a standard call option", () => {
    const result = parseIBKROptionSymbol("AAPL 21MAR25 150.0 C");
    expect(result).not.toBeNull();
    expect(result!.underlying).toBe("AAPL");
    expect(result!.strike).toBe(150);
    expect(result!.expiry).toBe("2025-03-21");
    expect(result!.optionType).toBe("CALL");
    expect(result!.occSymbol).toMatch(/^AAPL\s+2503/);
  });

  it("parses a standard put option", () => {
    const result = parseIBKROptionSymbol("SPY 17JAN25 580 P");
    expect(result).not.toBeNull();
    expect(result!.underlying).toBe("SPY");
    expect(result!.strike).toBe(580);
    expect(result!.expiry).toBe("2025-01-17");
    expect(result!.optionType).toBe("PUT");
  });

  it("parses option with decimal strike", () => {
    const result = parseIBKROptionSymbol("TSLA 15FEB25 247.50 C");
    expect(result).not.toBeNull();
    expect(result!.strike).toBe(247.5);
    expect(result!.optionType).toBe("CALL");
  });

  it("generates OCC-style symbol", () => {
    const result = parseIBKROptionSymbol("AAPL 21MAR25 150.0 C");
    expect(result).not.toBeNull();
    // OCC format: padded underlying (6 chars) + YYMMDD + C/P + strike*1000 (8 digits)
    expect(result!.occSymbol).toBe("AAPL  250321C00150000");
  });

  it("returns null for non-option symbols", () => {
    expect(parseIBKROptionSymbol("AAPL")).toBeNull();
    expect(parseIBKROptionSymbol("")).toBeNull();
    expect(parseIBKROptionSymbol("AAPL 150.0")).toBeNull();
  });

  it("handles multi-word underlying names", () => {
    const result = parseIBKROptionSymbol("APPLOVIN CORP 21FEB25 135.0 C");
    expect(result).not.toBeNull();
    expect(result!.underlying).toBe("APPLOVIN CORP");
    expect(result!.strike).toBe(135);
    expect(result!.expiry).toBe("2025-02-21");
    expect(result!.optionType).toBe("CALL");
  });

  it("handles all 12 months correctly", () => {
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const expected = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

    for (let i = 0; i < months.length; i++) {
      const result = parseIBKROptionSymbol(`SPY 15${months[i]}25 500 C`);
      expect(result).not.toBeNull();
      expect(result!.expiry).toContain(`-${expected[i]}-`);
    }
  });
});

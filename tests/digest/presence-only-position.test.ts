import { describe, it, expect } from "vitest";
import {
  formatPositionPresence,
  formatCombinedExposurePresence,
} from "@/lib/digest/presence-only-position";

describe("formatPositionPresence", () => {
  it("formats long stock with relative return", () => {
    const out = formatPositionPresence({
      symbol: "AAPL",
      accountName: "vanguard taxable",
      quantity: 500,
      securityType: "stock",
      costBasis: 50000, // $100/sh
      latestPrice: 112, // $112/sh → 12% gain
    });
    expect(out).toBe("500 sh AAPL (vanguard taxable, up ~12.0%)");
  });

  it("formats long stock with no cost basis (no return suffix)", () => {
    const out = formatPositionPresence({
      symbol: "TSLA",
      accountName: "ibkr",
      quantity: 100,
      securityType: "stock",
      costBasis: null,
      latestPrice: 250,
    });
    expect(out).toBe("100 sh TSLA (ibkr)");
  });

  it("formats short stock without return % (sign convention varies)", () => {
    const out = formatPositionPresence({
      symbol: "META",
      accountName: "ibkr",
      quantity: -200,
      securityType: "stock",
      costBasis: 100000,
      latestPrice: 400,
    });
    expect(out).toBe("200 sh short META (ibkr)");
  });

  it("formats long option (CALL) with return % via multiplier", () => {
    const out = formatPositionPresence({
      symbol: "AAPL  260619C00145000",
      accountName: "ibkr",
      quantity: 3,
      securityType: "option",
      optionMeta: {
        underlyingSymbol: "AAPL",
        strikePrice: 145,
        expirationDate: "2026-06-19",
        optionType: "CALL",
        multiplier: 100,
      },
      costBasis: 1500, // total cost, $5/share x 100 mult x 3 contracts
      latestPrice: 6, // $6/share → current $1800
    });
    expect(out).toBe(
      "3 long AAPL $145 call expiring 2026-06-19 (ibkr, up ~20.0%)",
    );
  });

  it("formats long option (PUT) with down return", () => {
    const out = formatPositionPresence({
      symbol: "SPY  260523P00590000",
      accountName: "ibkr",
      quantity: 2,
      securityType: "option",
      optionMeta: {
        underlyingSymbol: "SPY",
        strikePrice: 590,
        expirationDate: "2026-05-23",
        optionType: "PUT",
        multiplier: 100,
      },
      costBasis: 600,
      latestPrice: 2.5, // → current $500
    });
    expect(out).toBe(
      "2 long SPY $590 put expiring 2026-05-23 (ibkr, down ~16.7%)",
    );
  });

  it("formats short option without return %", () => {
    const out = formatPositionPresence({
      symbol: "SPY  260523P00590000",
      accountName: "ibkr",
      quantity: -2,
      securityType: "option",
      optionMeta: {
        underlyingSymbol: "SPY",
        strikePrice: 590,
        expirationDate: "2026-05-23",
        optionType: "PUT",
        multiplier: 100,
      },
      costBasis: 600,
      latestPrice: 2.5,
    });
    expect(out).toBe("2 short SPY $590 put expiring 2026-05-23 (ibkr)");
  });

  it("handles missing strike/expiry on option gracefully", () => {
    const out = formatPositionPresence({
      symbol: "AAPL_OPT",
      accountName: "ibkr",
      quantity: 1,
      securityType: "option",
      optionMeta: {
        underlyingSymbol: "AAPL",
        strikePrice: null,
        expirationDate: null,
        optionType: null,
        multiplier: 100,
      },
    });
    expect(out).toBe("1 long AAPL ? ? expiring ? (ibkr)");
  });

  it("emits no $ amounts (regex audit)", () => {
    const cases = [
      formatPositionPresence({
        symbol: "AAPL",
        accountName: "ibkr",
        quantity: 100,
        securityType: "stock",
        costBasis: 15000,
        latestPrice: 175,
      }),
      formatPositionPresence({
        symbol: "OPT",
        accountName: "ibkr",
        quantity: 5,
        securityType: "option",
        optionMeta: {
          underlyingSymbol: "MSFT",
          strikePrice: 400,
          expirationDate: "2026-12-31",
          optionType: "CALL",
          multiplier: 100,
        },
        costBasis: 2500,
        latestPrice: 7,
      }),
    ];
    // Strike + expiry-date $ markers are PUBLIC market data and stay visible
    // (e.g., "$400 call"). What we forbid: $-amount-followed-by-multi-digit
    // (e.g., "$15,000", "$175.00", "$2,500"). Use a loose audit pattern.
    for (const out of cases) {
      // Should not contain comma-grouped large numbers prefixed with $
      expect(out).not.toMatch(/\$\d{1,3}(,\d{3})+/);
      // Should not contain "cost basis", "mkt val", "market value"
      expect(out.toLowerCase()).not.toContain("cost basis");
      expect(out.toLowerCase()).not.toContain("mkt val");
      expect(out.toLowerCase()).not.toContain("market value");
    }
  });

  it("falls back to symbol when underlying missing on option", () => {
    const out = formatPositionPresence({
      symbol: "WEIRD_OPT",
      accountName: "ibkr",
      quantity: 1,
      securityType: "option",
      optionMeta: {
        underlyingSymbol: null,
        strikePrice: 50,
        expirationDate: "2026-12-31",
        optionType: "CALL",
        multiplier: 100,
      },
    });
    expect(out).toContain("WEIRD_OPT $50 call expiring 2026-12-31");
  });

  it("formats fractional-share quantities", () => {
    const out = formatPositionPresence({
      symbol: "VTI",
      accountName: "vanguard ira",
      quantity: 123.456,
      securityType: "etf",
    });
    expect(out).toBe("123.46 sh VTI (vanguard ira)");
  });

  it("handles zero cost basis (no divide-by-zero)", () => {
    const out = formatPositionPresence({
      symbol: "GIFT",
      accountName: "vanguard taxable",
      quantity: 50,
      securityType: "stock",
      costBasis: 0,
      latestPrice: 100,
    });
    expect(out).toBe("50 sh GIFT (vanguard taxable)");
  });
});

describe("formatCombinedExposurePresence", () => {
  it("returns 'no live exposure' for zero positions", () => {
    const out = formatCombinedExposurePresence({
      positionCount: 0,
      longShares: 0,
      shortShares: 0,
      longContracts: 0,
      shortContracts: 0,
    });
    expect(out).toBe("no live exposure");
  });

  it("formats a long-stock + long-option stack", () => {
    const out = formatCombinedExposurePresence({
      positionCount: 2,
      longShares: 500,
      shortShares: 0,
      longContracts: 3,
      shortContracts: 0,
    });
    expect(out).toBe("500 long shares + 3 long option contract(s)");
  });

  it("formats a mixed long+short stack", () => {
    const out = formatCombinedExposurePresence({
      positionCount: 4,
      longShares: 100,
      shortShares: 50,
      longContracts: 2,
      shortContracts: 1,
    });
    expect(out).toBe(
      "100 long shares + 50 short shares + 2 long option contract(s) + 1 short option contract(s)",
    );
  });

  it("emits no $ amounts and no 'notional' word", () => {
    const out = formatCombinedExposurePresence({
      positionCount: 3,
      longShares: 1000,
      shortShares: 0,
      longContracts: 10,
      shortContracts: 0,
    });
    expect(out).not.toContain("$");
    expect(out.toLowerCase()).not.toContain("notional");
  });
});

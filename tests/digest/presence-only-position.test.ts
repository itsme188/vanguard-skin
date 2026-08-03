import { describe, it, expect } from "vitest";
import {
  formatPositionPresence,
  formatCombinedExposurePresence,
} from "@/lib/digest/presence-only-position";

// 2026-08-02: share/contract counts AND return % removed from all outputs —
// count × public price reconstructs exact dollar exposure, so a count was
// never presence-only. These tests pin the direction-only format.

describe("formatPositionPresence", () => {
  it("formats long stock as direction + account only", () => {
    const out = formatPositionPresence({
      symbol: "AAPL",
      accountName: "vanguard taxable",
      quantity: 500,
      securityType: "stock",
    });
    expect(out).toBe("long AAPL (vanguard taxable)");
  });

  it("formats short stock", () => {
    const out = formatPositionPresence({
      symbol: "META",
      accountName: "ibkr",
      quantity: -200,
      securityType: "stock",
    });
    expect(out).toBe("short META (ibkr)");
  });

  it("formats long option (CALL) with strike + expiry, no contract count", () => {
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
      },
    });
    expect(out).toBe("long AAPL $145 calls exp 2026-06-19 (ibkr)");
  });

  it("formats short option (PUT)", () => {
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
      },
    });
    expect(out).toBe("short SPY $590 puts exp 2026-05-23 (ibkr)");
  });

  it("handles missing strike/expiry/right on option gracefully", () => {
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
      },
    });
    expect(out).toBe("long AAPL ? ? exp ? (ibkr)");
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
      },
    });
    expect(out).toContain("WEIRD_OPT $50 calls exp 2026-12-31");
  });

  it("emits no digits except strike price and expiry date (leak audit)", () => {
    const cases = [
      formatPositionPresence({
        symbol: "AAPL",
        accountName: "ibkr",
        quantity: 123.456,
        securityType: "stock",
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
        },
      }),
    ];
    // The stock line must contain NO digits at all (no share count, no %).
    expect(cases[0]).toBe("long AAPL (ibkr)");
    expect(cases[0]).not.toMatch(/\d/);
    // The option line's only digits are the strike and the expiry date.
    expect(cases[1]).toBe("long MSFT $400 calls exp 2026-12-31 (ibkr)");
    const digitRuns = cases[1].match(/\d+(\.\d+)?/g) ?? [];
    expect(digitRuns).toEqual(["400", "2026", "12", "31"]);
    // No return-% suffix anywhere.
    for (const out of cases) {
      expect(out).not.toMatch(/up ~|down ~|%/);
    }
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

  it("formats a long-stock + long-option stack without counts", () => {
    const out = formatCombinedExposurePresence({
      positionCount: 2,
      longShares: 500,
      shortShares: 0,
      longContracts: 3,
      shortContracts: 0,
    });
    expect(out).toBe("long shares + long options");
  });

  it("formats a mixed long+short stack without counts", () => {
    const out = formatCombinedExposurePresence({
      positionCount: 4,
      longShares: 100,
      shortShares: 50,
      longContracts: 2,
      shortContracts: 1,
    });
    expect(out).toBe(
      "long shares + short shares + long options + short options",
    );
  });

  it("renders a short-only book as presence, not zero exposure", () => {
    const out = formatCombinedExposurePresence({
      positionCount: 1,
      longShares: 0,
      shortShares: 300,
      longContracts: 0,
      shortContracts: 0,
    });
    expect(out).toBe("short shares");
  });

  it("emits no digits, no $, no 'notional'", () => {
    const out = formatCombinedExposurePresence({
      positionCount: 3,
      longShares: 1000,
      shortShares: 0,
      longContracts: 10,
      shortContracts: 0,
    });
    expect(out).not.toMatch(/\d/);
    expect(out).not.toContain("$");
    expect(out.toLowerCase()).not.toContain("notional");
  });
});

/**
 * Parity tests for workers/cron/src/presence-position.ts — a byte-for-byte hand
 * copy of lib/digest/presence-only-position.ts (the Worker can't cross the
 * Next.js path-alias boundary, same constraint as the issuerSiblings copy).
 *
 * The point of this file: outbound emails are shared (brother on cc), so the
 * cloud earnings fallback must NEVER echo an exact cost-basis $ — only
 * presence-disclosure ("100 sh AAPL (ibkr, up ~12%)").
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  formatPositionPresence,
  formatCombinedExposurePresence,
} from "../src/presence-position";

describe("formatPositionPresence (Worker copy)", () => {
  it("renders a long stock as presence + return %, never the cost basis", () => {
    const out = formatPositionPresence({
      symbol: "AAPL",
      accountName: "ibkr",
      quantity: 100,
      securityType: "stock",
      costBasis: 18000, // $180/sh
      latestPrice: 205, // → +13.9%
    });
    expect(out).toBe("100 sh AAPL (ibkr, up ~13.9%)");
    expect(out).not.toContain("18000");
    expect(out).not.toContain("180");
  });

  it("renders a short stock with no return % (sign convention varies)", () => {
    const out = formatPositionPresence({
      symbol: "META",
      accountName: "ibkr",
      quantity: -200,
      securityType: "stock",
      costBasis: 50000,
      latestPrice: 240,
    });
    expect(out).toBe("200 sh short META (ibkr)");
    expect(out).not.toContain("50000");
  });

  it("renders a long option with strike/expiry (public) but no total cost", () => {
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
      costBasis: 4200, // $14/contract → current 18 → +28.6%
      latestPrice: 18,
    });
    expect(out).toBe("3 long AAPL $145 call expiring 2026-06-19 (ibkr, up ~28.6%)");
    expect(out).not.toContain("4200");
  });

  it("omits the return % when latest price is missing (honest, no leak)", () => {
    const out = formatPositionPresence({
      symbol: "AAPL",
      accountName: "vanguard taxable",
      quantity: 50,
      securityType: "stock",
      costBasis: 9000,
      latestPrice: null,
    });
    expect(out).toBe("50 sh AAPL (vanguard taxable)");
    expect(out).not.toContain("9000");
  });
});

describe("formatCombinedExposurePresence (Worker copy, B7)", () => {
  it("buckets long and short shares separately — never a netted count", () => {
    const out = formatCombinedExposurePresence({
      positionCount: 2,
      longShares: 500,
      shortShares: 300,
      longContracts: 0,
      shortContracts: 0,
    });
    expect(out).toBe("500 long shares + 300 short shares");
    expect(out).not.toContain("200");
  });

  it("renders a short-only book as presence, not zero exposure", () => {
    const out = formatCombinedExposurePresence({
      positionCount: 1,
      longShares: 0,
      shortShares: 300,
      longContracts: 0,
      shortContracts: 0,
    });
    expect(out).toBe("300 short shares");
  });

  it("returns 'no live exposure' when there are no positions", () => {
    expect(
      formatCombinedExposurePresence({
        positionCount: 0,
        longShares: 0,
        shortShares: 0,
        longContracts: 0,
        shortContracts: 0,
      }),
    ).toBe("no live exposure");
  });
});

describe("presence-position parity (Worker mirror of lib/digest/presence-only-position.ts)", () => {
  it("is byte-identical to the Mac original below each file's own header comment", () => {
    const mac = readFileSync(
      new URL("../../../lib/digest/presence-only-position.ts", import.meta.url),
      "utf8",
    );
    const wkr = readFileSync(
      new URL("../src/presence-position.ts", import.meta.url),
      "utf8",
    );
    const strip = (s: string) => s.slice(s.indexOf("export interface OptionMeta {"));
    expect(strip(wkr)).toBe(strip(mac));
  });
});

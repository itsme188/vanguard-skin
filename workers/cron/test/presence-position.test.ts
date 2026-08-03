/**
 * Parity tests for workers/cron/src/presence-position.ts — a byte-for-byte hand
 * copy of lib/digest/presence-only-position.ts (the Worker can't cross the
 * Next.js path-alias boundary, same constraint as the issuerSiblings copy).
 *
 * The point of this file: outbound emails are shared (brother on cc), so the
 * cloud earnings fallback must NEVER echo reconstructable exposure. Since
 * 2026-08-02 that includes share/contract counts and return % — only
 * direction + account + option terms remain ("long AAPL (ibkr)").
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  formatPositionPresence,
  formatCombinedExposurePresence,
} from "../src/presence-position";

describe("formatPositionPresence (Worker copy)", () => {
  it("renders a long stock as direction only — no count, no return %", () => {
    const out = formatPositionPresence({
      symbol: "AAPL",
      accountName: "ibkr",
      quantity: 100,
      securityType: "stock",
    });
    expect(out).toBe("long AAPL (ibkr)");
    expect(out).not.toMatch(/\d/);
  });

  it("renders a short stock", () => {
    const out = formatPositionPresence({
      symbol: "META",
      accountName: "ibkr",
      quantity: -200,
      securityType: "stock",
    });
    expect(out).toBe("short META (ibkr)");
  });

  it("renders a long option with strike/expiry (public) but no contract count", () => {
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
});

describe("formatCombinedExposurePresence (Worker copy, B7)", () => {
  it("buckets long and short shares as presence flags — never counts", () => {
    const out = formatCombinedExposurePresence({
      positionCount: 2,
      longShares: 500,
      shortShares: 300,
      longContracts: 0,
      shortContracts: 0,
    });
    expect(out).toBe("long shares + short shares");
    expect(out).not.toMatch(/\d/);
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

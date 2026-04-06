import { describe, it, expect } from "vitest";
import { SecType, WhatToShow } from "@stoqey/ib";
import {
  mapSecurityType,
  PRICE_FETCH_EXCLUDED_TYPES,
  getWhatToShow,
  getWhatToShowFallback,
} from "@/lib/tws/security-type-map";

describe("mapSecurityType", () => {
  it("maps Stock variants to STK", () => {
    expect(mapSecurityType("Stock")).toBe(SecType.STK);
    expect(mapSecurityType("stock")).toBe(SecType.STK);
    expect(mapSecurityType("STOCK")).toBe(SecType.STK);
  });

  it("maps ETF variants to STK", () => {
    expect(mapSecurityType("ETF")).toBe(SecType.STK);
    expect(mapSecurityType("etf")).toBe(SecType.STK);
    expect(mapSecurityType("Etf")).toBe(SecType.STK);
  });

  it("maps Bond variants to BOND", () => {
    expect(mapSecurityType("Bond")).toBe(SecType.BOND);
    expect(mapSecurityType("bond")).toBe(SecType.BOND);
    expect(mapSecurityType("BOND")).toBe(SecType.BOND);
  });

  it("maps Mutual Fund variants to FUND", () => {
    expect(mapSecurityType("Mutual Fund")).toBe(SecType.FUND);
    expect(mapSecurityType("mutual fund")).toBe(SecType.FUND);
    expect(mapSecurityType("mutual_fund")).toBe(SecType.FUND);
    expect(mapSecurityType("MUTUAL FUND")).toBe(SecType.FUND);
    expect(mapSecurityType("MUTUAL_FUND")).toBe(SecType.FUND);
  });

  it("maps Option variants to OPT", () => {
    expect(mapSecurityType("Option")).toBe(SecType.OPT);
    expect(mapSecurityType("option")).toBe(SecType.OPT);
    expect(mapSecurityType("OPTION")).toBe(SecType.OPT);
  });

  it("defaults null to STK", () => {
    expect(mapSecurityType(null)).toBe(SecType.STK);
  });

  it("defaults unknown types to STK", () => {
    expect(mapSecurityType("Cryptocurrency")).toBe(SecType.STK);
    expect(mapSecurityType("")).toBe(SecType.STK);
    expect(mapSecurityType("futures")).toBe(SecType.STK);
  });
});

describe("PRICE_FETCH_EXCLUDED_TYPES", () => {
  it("excludes only options (mutual funds now fetched via MIDPOINT)", () => {
    expect(PRICE_FETCH_EXCLUDED_TYPES).toContain("option");
    expect(PRICE_FETCH_EXCLUDED_TYPES).not.toContain("mutual fund");
  });

  it("has exactly 1 entry", () => {
    expect(PRICE_FETCH_EXCLUDED_TYPES).toHaveLength(1);
  });
});

describe("getWhatToShow", () => {
  it("returns TRADES for stocks and ETFs", () => {
    expect(getWhatToShow("Stock")).toBe(WhatToShow.TRADES);
    expect(getWhatToShow("ETF")).toBe(WhatToShow.TRADES);
    expect(getWhatToShow("stock")).toBe(WhatToShow.TRADES);
    expect(getWhatToShow(null)).toBe(WhatToShow.TRADES);
  });

  it("returns BID_ASK for bonds", () => {
    expect(getWhatToShow("Bond")).toBe(WhatToShow.BID_ASK);
    expect(getWhatToShow("bond")).toBe(WhatToShow.BID_ASK);
    expect(getWhatToShow("BOND")).toBe(WhatToShow.BID_ASK);
  });

  it("returns MIDPOINT for mutual funds", () => {
    expect(getWhatToShow("Mutual Fund")).toBe(WhatToShow.MIDPOINT);
    expect(getWhatToShow("mutual fund")).toBe(WhatToShow.MIDPOINT);
    expect(getWhatToShow("mutual_fund")).toBe(WhatToShow.MIDPOINT);
  });
});

describe("getWhatToShowFallback", () => {
  it("returns YIELD_BID_ASK for bonds", () => {
    expect(getWhatToShowFallback("Bond")).toBe(WhatToShow.YIELD_BID_ASK);
  });

  it("returns TRADES for mutual funds", () => {
    expect(getWhatToShowFallback("Mutual Fund")).toBe(WhatToShow.TRADES);
  });

  it("returns null for stocks (no fallback)", () => {
    expect(getWhatToShowFallback("Stock")).toBeNull();
    expect(getWhatToShowFallback(null)).toBeNull();
  });
});

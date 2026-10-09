/**
 * Tests for the IBKR Web API position mapper (lib/ibkr/map-positions.ts) and the
 * OCC parser it relies on. Field shapes verified live against the real account
 * (STK + OPT; option metadata is embedded in `contractDesc` brackets, not the
 * top-level fields, which come back null/0).
 */

import { describe, it, expect } from "vitest";
import { parseOCCSymbol, buildOCCSymbol } from "@/lib/import/occ-symbol";
import { extractOccFromContractDesc, mapPosition } from "@/lib/ibkr/map-positions";

describe("parseOCCSymbol (inverse of buildOCCSymbol)", () => {
  it("parses underlying / expiry / put / strike", () => {
    expect(parseOCCSymbol("HACK  260618P00100000")).toEqual({
      underlying: "HACK",
      expirationDate: "2026-06-18",
      optionType: "PUT",
      strike: 100,
    });
  });
  it("parses a fractional strike call", () => {
    expect(parseOCCSymbol("ICL   260618C00007500")).toEqual({
      underlying: "ICL",
      expirationDate: "2026-06-18",
      optionType: "CALL",
      strike: 7.5,
    });
  });
  it("round-trips with buildOCCSymbol", () => {
    const occ = buildOCCSymbol("VLO", "2026-09-18", "CALL", 320);
    expect(parseOCCSymbol(occ)).toEqual({
      underlying: "VLO",
      expirationDate: "2026-09-18",
      optionType: "CALL",
      strike: 320,
    });
  });
  it("returns null on a non-OCC string", () => {
    expect(parseOCCSymbol("AAPL")).toBeNull();
  });
});

describe("extractOccFromContractDesc", () => {
  it("pulls the 21-char OCC symbol out of the bracket", () => {
    expect(extractOccFromContractDesc("HACK   JUN2026 100 P [HACK  260618P00100000 100]")).toEqual({
      occ: "HACK  260618P00100000",
      multiplier: 100,
    });
  });
  it("returns null when there's no bracket (a stock)", () => {
    expect(extractOccFromContractDesc("HOOD")).toBeNull();
  });
});

describe("mapPosition", () => {
  it("maps a stock position", () => {
    const m = mapPosition({
      acctId: "U1", assetClass: "STK", conid: 111111, contractDesc: "ZZA",
      currency: "USD", position: 50, avgCost: 200, avgPrice: 200,
      mktPrice: 250, mktValue: 12500,
    });
    expect(m).toMatchObject({
      symbol: "ZZA", securityType: "Stock", quantity: 50, conid: 111111,
      mktPrice: 250, costBasis: 50 * 200,
    });
    expect(m.optionType).toBeUndefined();
  });

  it("maps an option position from contractDesc, cost basis = qty × avgCost", () => {
    const m = mapPosition({
      acctId: "U1", assetClass: "OPT", conid: 222222,
      contractDesc: "ZZH    JUN2026 100 P [ZZH   260618P00100000 100]",
      currency: "USD", position: 5, avgCost: 200.5, avgPrice: 2.005,
      mktPrice: 1.5, mktValue: 750,
    });
    expect(m).toMatchObject({
      symbol: "ZZH   260618P00100000",
      securityType: "Option",
      underlyingSymbol: "ZZH",
      optionType: "PUT",
      strikePrice: 100,
      expirationDate: "2026-06-18",
      multiplier: 100,
      quantity: 5,
    });
    // 5 contracts × 200.50 per-contract avgCost = 1,002.50
    expect(m.costBasis).toBeCloseTo(1002.5, 1);
  });

  it("handles a short position (negative qty) and a closed (qty 0) row", () => {
    const short = mapPosition({ assetClass: "STK", conid: 1, contractDesc: "ZZS", position: -200, avgCost: 70, mktPrice: 68, mktValue: -13600 });
    expect(short.quantity).toBe(-200);
    expect(short.costBasis).toBe(-200 * 70);
    const closed = mapPosition({ assetClass: "STK", conid: 2, contractDesc: "HOOD", position: 0, avgCost: 0, mktPrice: 87.1, mktValue: 0 });
    expect(closed.quantity).toBe(0);
  });
});

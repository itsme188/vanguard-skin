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
      acctId: "U1", assetClass: "STK", conid: 504546674, contractDesc: "NET",
      currency: "USD", position: 60, avgCost: 200.5, avgPrice: 200.5,
      mktPrice: 269.42, mktValue: 16165.2,
    });
    expect(m).toMatchObject({
      symbol: "NET", securityType: "Stock", quantity: 60, conid: 504546674,
      mktPrice: 269.42, costBasis: 60 * 200.5,
    });
    expect(m.optionType).toBeUndefined();
  });

  it("maps an option position from contractDesc, cost basis = qty × avgCost", () => {
    const m = mapPosition({
      acctId: "U1", assetClass: "OPT", conid: 825212004,
      contractDesc: "HACK   JUN2026 100 P [HACK  260618P00100000 100]",
      currency: "USD", position: 6, avgCost: 191.70075, avgPrice: 1.9170075,
      mktPrice: 1.23, mktValue: 739.95,
    });
    expect(m).toMatchObject({
      symbol: "HACK  260618P00100000",
      securityType: "Option",
      underlyingSymbol: "HACK",
      optionType: "PUT",
      strikePrice: 100,
      expirationDate: "2026-06-18",
      multiplier: 100,
      quantity: 6,
    });
    // 6 contracts × 191.70075 per-contract avgCost
    expect(m.costBasis).toBeCloseTo(1150.2, 1);
  });

  it("handles a short position (negative qty) and a closed (qty 0) row", () => {
    const short = mapPosition({ assetClass: "STK", conid: 1, contractDesc: "FEZ", position: -300, avgCost: 70, mktPrice: 68.27, mktValue: -20482.38 });
    expect(short.quantity).toBe(-300);
    expect(short.costBasis).toBe(-300 * 70);
    const closed = mapPosition({ assetClass: "STK", conid: 2, contractDesc: "HOOD", position: 0, avgCost: 0, mktPrice: 87.1, mktValue: 0 });
    expect(closed.quantity).toBe(0);
  });
});

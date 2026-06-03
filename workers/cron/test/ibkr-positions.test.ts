/**
 * Tests for the Worker live-IBKR position layer (src/ibkr-positions.ts).
 *
 * Covers the pure transforms (OCC parse, raw→position map, family filtering,
 * and the snapshot↔live merge that prevents double-counting). The network
 * fetch is proven separately by the deployed Worker's /internal/ibkr-test.
 */

import { describe, it, expect } from "vitest";
import {
  parseOcc,
  extractOccFromContractDesc,
  mapLivePosition,
  livePositionViewsForFamily,
  combineFamilyPositions,
  liveSymbolsForContext,
  type LiveIbkrPosition,
} from "../src/ibkr-positions";
import type { PositionView } from "../src/fallback-earnings";

describe("worker ibkr-positions — OCC parsing", () => {
  it("parseOcc decodes a 21-char OCC symbol", () => {
    expect(parseOcc("HACK  260618P00100000")).toEqual({
      underlying: "HACK",
      expirationDate: "2026-06-18",
      optionType: "PUT",
      strike: 100,
    });
  });

  it("parseOcc returns null for a non-OCC string", () => {
    expect(parseOcc("AAPL")).toBeNull();
  });

  it("extractOccFromContractDesc pulls the bracketed OCC + multiplier", () => {
    expect(
      extractOccFromContractDesc("HACK   JUN2026 100 P [HACK  260618P00100000 100]"),
    ).toEqual({ occ: "HACK  260618P00100000", multiplier: 100 });
  });

  it("extractOccFromContractDesc returns null when no bracket", () => {
    expect(extractOccFromContractDesc("AAPL")).toBeNull();
  });
});

describe("worker ibkr-positions — mapLivePosition", () => {
  it("maps a stock row", () => {
    const m = mapLivePosition({
      assetClass: "STK",
      contractDesc: "AAPL",
      position: 100,
      avgCost: 150,
      mktPrice: 180,
      conid: 265598,
    });
    expect(m).toMatchObject({
      symbol: "AAPL",
      securityType: "Stock",
      underlyingSymbol: null,
      quantity: 100,
      costBasis: 15000,
      mktPrice: 180,
    });
  });

  it("maps an option row from contractDesc brackets", () => {
    const m = mapLivePosition({
      assetClass: "OPT",
      contractDesc: "HACK   JUN2026 100 P [HACK  260618P00100000 100]",
      position: -2,
      avgCost: 320, // per-contract incl. multiplier
      mktPrice: 4.1,
      conid: 999,
    });
    expect(m).toMatchObject({
      symbol: "HACK  260618P00100000",
      securityType: "Option",
      underlyingSymbol: "HACK",
      optionType: "PUT",
      strikePrice: 100,
      expirationDate: "2026-06-18",
      multiplier: 100,
      quantity: -2,
      costBasis: -640,
    });
  });
});

describe("worker ibkr-positions — livePositionViewsForFamily", () => {
  const positions: LiveIbkrPosition[] = [
    { symbol: "AAPL", securityType: "Stock", underlyingSymbol: null, optionType: null, strikePrice: null, expirationDate: null, multiplier: null, quantity: 100, costBasis: 15000, mktPrice: 180 },
    { symbol: "GOOG", securityType: "Stock", underlyingSymbol: null, optionType: null, strikePrice: null, expirationDate: null, multiplier: null, quantity: 50, costBasis: 8000, mktPrice: 170 },
    { symbol: "HACK  260618P00100000", securityType: "Option", underlyingSymbol: "HACK", optionType: "PUT", strikePrice: 100, expirationDate: "2026-06-18", multiplier: 100, quantity: -2, costBasis: -640, mktPrice: 4.1 },
  ];

  it("matches stock symbol against the family", () => {
    const views = livePositionViewsForFamily(positions, ["AAPL"], "IBKR");
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ account_name: "IBKR", symbol: "AAPL", quantity: 100, cost_basis: 15000 });
  });

  it("matches an option via its underlying symbol", () => {
    const views = livePositionViewsForFamily(positions, ["HACK"], "IBKR");
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      symbol: "HACK  260618P00100000",
      security_type: "Option",
      underlying_symbol: "HACK",
      strike_price: 100,
      quantity: -2,
    });
  });

  it("matches a dual-class family (GOOG/GOOGL)", () => {
    const views = livePositionViewsForFamily(positions, ["GOOG", "GOOGL"], "IBKR");
    expect(views.map((v) => v.symbol)).toEqual(["GOOG"]);
  });

  it("returns empty when nothing in the family is held", () => {
    expect(livePositionViewsForFamily(positions, ["TSLA"], "IBKR")).toEqual([]);
  });
});

describe("worker ibkr-positions — combineFamilyPositions", () => {
  const snapshotViews: PositionView[] = [
    { account_name: "Vanguard Taxable", symbol: "AAPL", security_type: "stock", underlying_symbol: null, option_type: null, strike_price: null, expiration_date: null, multiplier: null, quantity: 200, cost_basis: 20000 },
    { account_name: "IBKR", symbol: "AAPL", security_type: "stock", underlying_symbol: null, option_type: null, strike_price: null, expiration_date: null, multiplier: null, quantity: 999, cost_basis: 99999 }, // STALE
  ];
  const live: LiveIbkrPosition[] = [
    { symbol: "AAPL", securityType: "Stock", underlyingSymbol: null, optionType: null, strikePrice: null, expirationDate: null, multiplier: null, quantity: 100, costBasis: 15000, mktPrice: 180 },
  ];

  it("replaces stale snapshot IBKR rows with live ones, keeps non-IBKR", () => {
    const out = combineFamilyPositions(snapshotViews, live, ["AAPL"], "IBKR");
    // Vanguard kept verbatim; IBKR is the LIVE 100sh not the stale 999sh.
    const vanguard = out.find((p) => p.account_name === "Vanguard Taxable");
    const ibkr = out.find((p) => p.account_name === "IBKR");
    expect(vanguard?.quantity).toBe(200);
    expect(ibkr?.quantity).toBe(100);
    expect(ibkr?.cost_basis).toBe(15000);
    expect(out).toHaveLength(2);
  });

  it("falls back to snapshot verbatim when live is null", () => {
    const out = combineFamilyPositions(snapshotViews, null, ["AAPL"], "IBKR");
    expect(out).toEqual(snapshotViews);
  });

  it("drops stale IBKR rows even when live has no row for the family (true close)", () => {
    // User fully exited AAPL in IBKR — snapshot still shows it, live shows none.
    const out = combineFamilyPositions(snapshotViews, [], ["AAPL"], "IBKR");
    expect(out.map((p) => p.account_name)).toEqual(["Vanguard Taxable"]);
  });

  it("matches the IBKR account by case-insensitive name fragment", () => {
    const views: PositionView[] = [
      { account_name: "My IBKR Brokerage", symbol: "AAPL", security_type: "stock", underlying_symbol: null, option_type: null, strike_price: null, expiration_date: null, multiplier: null, quantity: 999, cost_basis: 99999 },
    ];
    const out = combineFamilyPositions(views, live, ["AAPL"], "My IBKR Brokerage");
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBe(100);
  });
});

describe("worker ibkr-positions — liveSymbolsForContext", () => {
  it("returns stock symbols + option underlyings, deduped, no zero-qty", () => {
    const positions: LiveIbkrPosition[] = [
      { symbol: "AAPL", securityType: "Stock", underlyingSymbol: null, optionType: null, strikePrice: null, expirationDate: null, multiplier: null, quantity: 100, costBasis: 15000, mktPrice: 180 },
      { symbol: "HACK  260618P00100000", securityType: "Option", underlyingSymbol: "HACK", optionType: "PUT", strikePrice: 100, expirationDate: "2026-06-18", multiplier: 100, quantity: -2, costBasis: -640, mktPrice: 4.1 },
      { symbol: "AAPL  260618C00200000", securityType: "Option", underlyingSymbol: "AAPL", optionType: "CALL", strikePrice: 200, expirationDate: "2026-06-18", multiplier: 100, quantity: 1, costBasis: 500, mktPrice: 5 },
    ];
    expect(liveSymbolsForContext(positions).sort()).toEqual(["AAPL", "HACK"]);
  });
});

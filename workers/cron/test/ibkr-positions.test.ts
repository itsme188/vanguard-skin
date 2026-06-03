/**
 * Tests for the Worker live-IBKR position layer (src/ibkr-positions.ts).
 *
 * Covers the pure transforms (OCC parse, raw→position map, family filtering,
 * and the snapshot↔live merge that prevents double-counting). The network
 * fetch is proven separately by the deployed Worker's /internal/ibkr-test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseOcc,
  extractOccFromContractDesc,
  mapLivePosition,
  livePositionViewsForFamily,
  combineFamilyPositions,
  liveSymbolsForContext,
  getCachedLiveSessionToken,
  fetchLiveIbkrPositionsCached,
  type LiveIbkrPosition,
} from "../src/ibkr-positions";
import type { PositionView } from "../src/fallback-earnings";

// Mock only the handshake; pure transforms stay real.
vi.mock("../src/ibkr-oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ibkr-oauth")>();
  return { ...actual, getLiveSessionToken: vi.fn() };
});
import { getLiveSessionToken } from "../src/ibkr-oauth";

const CFG = {} as Parameters<typeof getCachedLiveSessionToken>[1];

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
    list: vi.fn(async () => ({ keys: [] })),
  };
}
type FakeKv = ReturnType<typeof makeKv>;
const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

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

describe("worker ibkr-positions — getCachedLiveSessionToken", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mints + caches on an empty cache", async () => {
    const kv = makeKv();
    (getLiveSessionToken as ReturnType<typeof vi.fn>).mockResolvedValue({ token: "T1", expirationMs: NOW + DAY });

    const lst = await getCachedLiveSessionToken(kv as unknown as KVNamespace, CFG, { now: NOW });

    expect(lst.token).toBe("T1");
    expect(getLiveSessionToken).toHaveBeenCalledTimes(1);
    expect(kv.store.has("ibkr-lst")).toBe(true);
    // TTL passed to put is positive and below the 24h horizon.
    const putOpts = kv.put.mock.calls[0][2] as { expirationTtl: number };
    expect(putOpts.expirationTtl).toBeGreaterThan(0);
    expect(putOpts.expirationTtl).toBeLessThan(DAY / 1000);
  });

  it("returns the cached token without minting when it is fresh", async () => {
    const kv = makeKv();
    kv.store.set("ibkr-lst", JSON.stringify({ token: "CACHED", expirationMs: NOW + DAY }));

    const lst = await getCachedLiveSessionToken(kv as unknown as KVNamespace, CFG, { now: NOW });

    expect(lst.token).toBe("CACHED");
    expect(getLiveSessionToken).not.toHaveBeenCalled();
  });

  it("re-mints when the cached token is within the safety margin of expiry", async () => {
    const kv = makeKv();
    kv.store.set("ibkr-lst", JSON.stringify({ token: "OLD", expirationMs: NOW + 2 * 60 * 1000 }));
    (getLiveSessionToken as ReturnType<typeof vi.fn>).mockResolvedValue({ token: "NEW", expirationMs: NOW + DAY });

    const lst = await getCachedLiveSessionToken(kv as unknown as KVNamespace, CFG, { now: NOW });

    expect(lst.token).toBe("NEW");
    expect(getLiveSessionToken).toHaveBeenCalledTimes(1);
  });

  it("re-mints when the cache is malformed", async () => {
    const kv = makeKv();
    kv.store.set("ibkr-lst", "not json {");
    (getLiveSessionToken as ReturnType<typeof vi.fn>).mockResolvedValue({ token: "NEW", expirationMs: NOW + DAY });

    const lst = await getCachedLiveSessionToken(kv as unknown as KVNamespace, CFG, { now: NOW });
    expect(lst.token).toBe("NEW");
  });

  it("forceRefresh mints even when a fresh cache exists", async () => {
    const kv = makeKv();
    kv.store.set("ibkr-lst", JSON.stringify({ token: "CACHED", expirationMs: NOW + DAY }));
    (getLiveSessionToken as ReturnType<typeof vi.fn>).mockResolvedValue({ token: "FORCED", expirationMs: NOW + DAY });

    const lst = await getCachedLiveSessionToken(kv as unknown as KVNamespace, CFG, { now: NOW, forceRefresh: true });
    expect(lst.token).toBe("FORCED");
    expect(getLiveSessionToken).toHaveBeenCalledTimes(1);
  });
});

describe("worker ibkr-positions — fetchLiveIbkrPositionsCached retry", () => {
  const POS: LiveIbkrPosition = { symbol: "AAPL", securityType: "Stock", underlyingSymbol: null, optionType: null, strikePrice: null, expirationDate: null, multiplier: null, quantity: 100, costBasis: 15000, mktPrice: 180 };

  it("reads with the cached LST and does not retry on success", async () => {
    const kv = makeKv() as FakeKv;
    const getLst = vi.fn(async () => ({ token: "L1", expirationMs: NOW + DAY }));
    const read = vi.fn(async () => [POS]);

    const out = await fetchLiveIbkrPositionsCached(kv as unknown as KVNamespace, CFG, { getLst, read });

    expect(out).toEqual([POS]);
    expect(getLst).toHaveBeenCalledTimes(1);
    expect(getLst).toHaveBeenCalledWith(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it("drops the cache + re-mints + retries once on a 401", async () => {
    const kv = makeKv() as FakeKv;
    const getLst = vi
      .fn()
      .mockResolvedValueOnce({ token: "STALE", expirationMs: NOW + DAY })
      .mockResolvedValueOnce({ token: "FRESH", expirationMs: NOW + DAY });
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("positions HTTP 401: unauthorized"))
      .mockResolvedValueOnce([POS]);

    const out = await fetchLiveIbkrPositionsCached(kv as unknown as KVNamespace, CFG, { getLst, read });

    expect(out).toEqual([POS]);
    expect(getLst.mock.calls.map((c) => c[0])).toEqual([false, true]); // false, then force
    expect(read).toHaveBeenCalledTimes(2);
    expect(kv.delete).toHaveBeenCalledWith("ibkr-lst");
  });

  it("does not retry on a non-auth error", async () => {
    const kv = makeKv() as FakeKv;
    const getLst = vi.fn(async () => ({ token: "L1", expirationMs: NOW + DAY }));
    const read = vi.fn().mockRejectedValue(new Error("network boom"));

    await expect(
      fetchLiveIbkrPositionsCached(kv as unknown as KVNamespace, CFG, { getLst, read }),
    ).rejects.toThrow("network boom");
    expect(read).toHaveBeenCalledTimes(1);
    expect(getLst).toHaveBeenCalledTimes(1);
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

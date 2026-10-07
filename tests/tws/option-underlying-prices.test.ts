import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { IBApiTickType } from "@stoqey/ib";

vi.mock("@/lib/tws/client", () => ({ getIbApi: vi.fn() }));
vi.mock("@/lib/tws/rate-limiter", () => ({
  RateLimiter: class {
    async waitForSlot() {}
  },
}));

import { getIbApi } from "@/lib/tws/client";
import { fetchSnapshotPrices } from "@/lib/tws/snapshot";
import { enrichPendingOptionUnderlyings, enrichSecurities } from "@/lib/tws/contracts";
import {
  MAX_UNDERLYING_LOOKUP_FAILURES,
  UNDERLYING_LOOKUP_FAILURES_KEY,
  getLiveHeldOptionUnderlyings,
  getPendingOptionUnderlyings,
  getUnderlyingLookupFailures,
} from "@/lib/tws/option-underlyings";
import { fetchAndStoreQuotes } from "@/lib/ibkr/refresh";
import { getSecurityQuote } from "@/lib/queries/security-quotes";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { getDataConfidence } from "@/lib/queries/data-confidence";
import { getAllocationByDimension } from "@/lib/queries/analysis";
import type { ParsedQuote } from "@/lib/ibkr/market-data";
import type { IbkrOAuthConfig } from "@/lib/ibkr/oauth-client";

const mockedGetIbApi = vi.mocked(getIbApi);

/** A trading day (Fri 2026-01-02); synthetic ZZ* tickers and round numbers only. */
const TRADING_DAY = "2026-01-02";
const HELD_ON = "2026-01-01";

let db: Database.Database;
let accountId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.clearAllMocks();
  accountId = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Test')").run().lastInsertRowid as number;
});

function stock(symbol: string, conId: number | null, type: string | null = "Stock"): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, ib_con_id) VALUES (?, ?, ?, ?)")
    .run(symbol, `${symbol} Corp`, type, conId).lastInsertRowid as number;
}
function option(underlying: string, expiration: string, conId: number): number {
  const yymmdd = expiration.replace(/-/g, "").slice(2);
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, ib_con_id, underlying_symbol, strike_price, expiration_date, option_type, multiplier)
       VALUES (?, ?, 'Option', ?, ?, 100, ?, 'CALL', 100)`,
    )
    .run(`${underlying.padEnd(6, " ")}${yymmdd}C00100000`, `${underlying} call`, conId, underlying, expiration).lastInsertRowid as number;
}
function hold(securityId: number, qty: number, asOf = HELD_ON): void {
  db.prepare("INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, ?)").run(
    accountId,
    securityId,
    qty,
    asOf,
  );
}
function snapshotApi(price = 50) {
  const api = {
    setMarketDataType: vi.fn(),
    getMarketDataSnapshot: vi.fn().mockResolvedValue(new Map([[IBApiTickType.LAST, { value: price }]])),
  };
  mockedGetIbApi.mockReturnValue(api as unknown as ReturnType<typeof getIbApi>);
  return api;
}
const requestedConIds = (api: ReturnType<typeof snapshotApi>) =>
  api.getMarketDataSnapshot.mock.calls.map((c) => (c[0] as { conId: number }).conId);
const priceRows = (securityId: number) =>
  db.prepare("SELECT date, close_price, source FROM prices WHERE security_id = ?").all(securityId) as Array<{
    date: string;
    close_price: number;
    source: string;
  }>;

describe("fetchSnapshotPrices: the underlying of a held live option is priced", () => {
  it("requests the underlying of a held live option and writes its price row the usual way", async () => {
    const under = stock("ZZU", 7001);
    hold(option("ZZU", "2026-06-19", 8001), 2);
    const api = snapshotApi(50);

    const results = await fetchSnapshotPrices(db, { asOfDate: TRADING_DAY, nowEt: "10:00" });

    expect(requestedConIds(api).sort()).toEqual([7001, 8001]);
    expect(api.getMarketDataSnapshot.mock.calls.find((c) => (c[0] as { conId: number }).conId === 7001)![0]).toEqual({
      conId: 7001,
      secType: "STK",
      exchange: "SMART",
      currency: "USD",
    });
    expect(priceRows(under)).toEqual([{ date: TRADING_DAY, close_price: 50, source: "tws" }]);
    expect(results.map((r) => r.securityId)).toContain(under);
  });

  it("a short option counts as held", async () => {
    stock("ZZU", 7001);
    hold(option("ZZU", "2026-06-19", 8001), -1);
    const api = snapshotApi();
    await fetchSnapshotPrices(db, { asOfDate: TRADING_DAY, nowEt: "10:00" });
    expect(requestedConIds(api)).toContain(7001);
  });

  it("does not request the underlying of an expired option, in either stored date spelling", async () => {
    stock("ZZU", 7001);
    stock("ZZV", 7002);
    hold(option("ZZU", "2025-12-19", 8001), 2);
    const legacy = option("ZZV", "2025-12-26", 8002);
    db.prepare("UPDATE securities SET expiration_date = '20251226' WHERE id = ?").run(legacy);
    hold(legacy, 2);
    const api = snapshotApi();
    await fetchSnapshotPrices(db, { asOfDate: TRADING_DAY, nowEt: "10:00" });
    expect(requestedConIds(api)).not.toContain(7001);
    expect(requestedConIds(api)).not.toContain(7002);
  });

  it("an option expiring today is still live", async () => {
    stock("ZZU", 7001);
    hold(option("ZZU", TRADING_DAY, 8001), 2);
    const api = snapshotApi();
    await fetchSnapshotPrices(db, { asOfDate: TRADING_DAY, nowEt: "10:00" });
    expect(requestedConIds(api)).toContain(7001);
  });

  it("does not request the underlying of an option that is no longer held", async () => {
    stock("ZZU", 7001);
    const opt = option("ZZU", "2026-06-19", 8001);
    hold(opt, 2, "2025-12-30");
    hold(opt, 0, HELD_ON); // closed: the latest row is flat
    const api = snapshotApi();
    await fetchSnapshotPrices(db, { asOfDate: TRADING_DAY, nowEt: "10:00" });
    expect(requestedConIds(api)).not.toContain(7001);
  });

  it("an underlying that is also held is requested once", async () => {
    const under = stock("ZZU", 7001);
    hold(under, 100);
    hold(option("ZZU", "2026-06-19", 8001), 2);
    hold(option("ZZU", "2026-09-18", 8002), 1);
    const api = snapshotApi();
    await fetchSnapshotPrices(db, { asOfDate: TRADING_DAY, nowEt: "10:00" });
    expect(requestedConIds(api).filter((c) => c === 7001)).toHaveLength(1);
    expect(priceRows(under)).toHaveLength(1);
  });

  it("a holding that is not an option adds nothing", async () => {
    stock("ZZU", 7001); // exists, not held, nobody's underlying
    const held = stock("ZZH", 7003);
    db.prepare("UPDATE securities SET underlying_symbol = 'ZZU' WHERE id = ?").run(held); // stray field on a stock row
    hold(held, 100);
    const api = snapshotApi();
    await fetchSnapshotPrices(db, { asOfDate: TRADING_DAY, nowEt: "10:00" });
    expect(requestedConIds(api)).toEqual([7003]);
  });

  it("an underlying with no contract id, or with no securities row, is not requested", async () => {
    const noConId = stock("ZZU", null);
    hold(option("ZZU", "2026-06-19", 8001), 2);
    hold(option("ZZW", "2026-06-19", 8002), 2); // no ZZW row at all
    const api = snapshotApi();
    await fetchSnapshotPrices(db, { asOfDate: TRADING_DAY, nowEt: "10:00" });
    expect(requestedConIds(api).sort()).toEqual([8001, 8002]);
    expect(priceRows(noConId)).toEqual([]);
  });

  it("writes nothing for the underlying on a market-closed day", async () => {
    const under = stock("ZZU", 7001);
    hold(option("ZZU", "2026-06-19", 8001), 2);
    const api = snapshotApi();
    await fetchSnapshotPrices(db, { asOfDate: "2026-01-03", nowEt: "10:00" }); // Saturday
    expect(api.getMarketDataSnapshot).not.toHaveBeenCalled();
    expect(priceRows(under)).toEqual([]);
  });

  it("the order of the held securities is unchanged; underlyings come after them", async () => {
    stock("ZZU", 7001);
    const a = stock("ZZA", 7010);
    const b = stock("ZZB", 7011);
    hold(option("ZZU", "2026-06-19", 8001), 2);
    hold(b, 5);
    hold(a, 5);
    const api = snapshotApi();
    const results = await fetchSnapshotPrices(db, { asOfDate: TRADING_DAY, nowEt: "10:00" });
    expect(results[results.length - 1].symbol).toBe("ZZU");
    expect(requestedConIds(api)[requestedConIds(api).length - 1]).toBe(7001);
  });
});

describe("pricing an underlying never makes it a holding", () => {
  function seedBook() {
    const held = stock("ZZH", 7003);
    hold(held, 100);
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 20, 'tws')").run(held, HELD_ON);
    const under = stock("ZZU", 7001);
    const opt = option("ZZU", "2026-06-19", 8001);
    hold(opt, 2);
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 3, 'tws')").run(opt, HELD_ON);
    db.prepare(
      "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source) VALUES (?, ?, 3000, 400, 'tws')",
    ).run(accountId, HELD_ON);
    return { held, under, opt };
  }
  const NOW = new Date("2026-01-02T15:00:00Z");
  const holdingsDump = () => db.prepare("SELECT * FROM holdings ORDER BY id").all();
  const valuationsDump = () => {
    computeDailyValuations(db);
    return db
      .prepare("SELECT account_id, valuation_date, total_value, holdings_value, cash_balance, holdings_count, priced_count, data_quality FROM daily_valuations ORDER BY account_id, valuation_date")
      .all();
  };
  /** The whole confidence result: every dimension score, detail line and count. */
  const confidenceDump = () => {
    return JSON.parse(JSON.stringify(getDataConfidence(db, NOW)));
  };

  it("holdings, daily valuations, allocation and the data-confidence scores are identical with and without the underlying's price row", async () => {
    const { under } = seedBook();

    // Control: the same sync day with only the held securities priced.
    const control = db.prepare("INSERT OR REPLACE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')");
    for (const row of db.prepare("SELECT id FROM securities WHERE id != ?").all(under) as Array<{ id: number }>) {
      if ((db.prepare("SELECT 1 FROM holdings WHERE security_id = ?").get(row.id))) control.run(row.id, TRADING_DAY, 50);
    }
    const before = {
      holdings: holdingsDump(),
      valuations: valuationsDump(),
      confidence: confidenceDump(),
      sector: getAllocationByDimension(db, "sector"),
      assetClass: getAllocationByDimension(db, "asset_class"),
    };
    expect(priceRows(under)).toEqual([]);
    // The comparison is over real content, not empty results.
    expect(before.valuations.length).toBeGreaterThan(0);
    expect(before.sector.length).toBeGreaterThan(0);
    expect(before.assetClass.length).toBeGreaterThan(0);
    expect(before.confidence.priceFreshness.detail).toBe("All 2 securities priced today");

    snapshotApi(50);
    await fetchSnapshotPrices(db, { asOfDate: TRADING_DAY, nowEt: "10:00" });
    expect(priceRows(under)).toHaveLength(1);

    expect(holdingsDump()).toEqual(before.holdings);
    expect(db.prepare("SELECT COUNT(*) AS n FROM holdings WHERE security_id = ?").get(under)).toEqual({ n: 0 });
    expect(valuationsDump()).toEqual(before.valuations);
    expect(getAllocationByDimension(db, "sector")).toEqual(before.sector);
    expect(getAllocationByDimension(db, "asset_class")).toEqual(before.assetClass);
    expect(confidenceDump()).toEqual(before.confidence);
  });

  it("price freshness counts held securities only: an unpriced underlying is not a stale holding", async () => {
    seedBook();
    const c = getDataConfidence(db, NOW);
    // Two held securities (the stock and the option); the underlying is not one.
    expect(c.priceFreshness.detail).toMatch(/\b2\b/);
    expect(c.priceFreshness.detail).not.toMatch(/\b3\b/);
  });
});

describe("enrichment resolves a contract id for a live option's underlying", () => {
  function detailsApi() {
    const api = {
      getContractDetails: vi.fn().mockResolvedValue([{ industry: "Technology", contract: { conId: 7001, primaryExch: "ZZX" } }]),
    };
    mockedGetIbApi.mockReturnValue(api as unknown as ReturnType<typeof getIbApi>);
    return api;
  }

  it("a never-held underlying with no contract id is enriched; a symbol-only row (no type) is looked up as a stock", async () => {
    const under = db.prepare("INSERT INTO securities (symbol, source_key) VALUES ('ZZU', 'underlying:ZZU')").run()
      .lastInsertRowid as number;
    hold(option("ZZU", "2099-06-19", 8001), 2); // enrichSecurities reads the real ET date
    expect(getPendingOptionUnderlyings(db, TRADING_DAY)).toHaveLength(1);
    const api = detailsApi();

    const results = await enrichSecurities(db);

    expect(results.map((r) => r.securityId)).toEqual([under]);
    expect(api.getContractDetails).toHaveBeenCalledWith({ symbol: "ZZU", secType: "STK", exchange: "SMART", currency: "USD" });
    expect((db.prepare("SELECT ib_con_id FROM securities WHERE id = ?").get(under) as { ib_con_id: number }).ib_con_id).toBe(7001);
    expect(getPendingOptionUnderlyings(db, TRADING_DAY)).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM holdings WHERE security_id = ?").get(under)).toEqual({ n: 0 });
  });

  it("an expired option's underlying, an already-resolved one and an unrelated non-held row are left alone", async () => {
    stock("ZZU", null);
    hold(option("ZZU", "2025-12-19", 8001), 2); // expired
    stock("ZZV", 7002);
    hold(option("ZZV", "2099-06-19", 8002), 2); // resolved already
    stock("ZZX", null); // not held, nobody's underlying
    const api = detailsApi();
    const results = await enrichSecurities(db);
    expect(results).toEqual([]);
    expect(api.getContractDetails).not.toHaveBeenCalled();
  });

  it("the helper lists each underlying once and skips rows the broker cannot look up by symbol", () => {
    stock("ZZU", null);
    hold(option("ZZU", "2026-06-19", 8001), 2);
    hold(option("ZZU", "2026-09-18", 8002), 2);
    stock("CUSIP:000000ZZ0", null, "Bond");
    hold(option("CUSIP:000000ZZ0", "2026-06-19", 8003), 1);
    expect(getLiveHeldOptionUnderlyings(db, TRADING_DAY).map((u) => u.symbol)).toEqual(["ZZU"]);
    expect(() => getLiveHeldOptionUnderlyings(db, "soon")).toThrow();
  });
});

describe("disconnected fallback (IBKR Web API): the underlying is a price-only candidate", () => {
  const CFG = {} as IbkrOAuthConfig;
  const quote = (conid: number, last: number): ParsedQuote => ({
    conid,
    last,
    bid: null,
    ask: null,
    ivUnderlying: 0.3,
    hv30d: 0.2,
    week52High: 90,
    week52Low: 10,
  });

  it("requests the underlying of a held live option, writes its price and caches no quote row for it", async () => {
    const under = stock("ZZU", 7001);
    const expiredUnder = stock("ZZV", 7002);
    hold(option("ZZU", "2026-06-19", 8001), 2);
    hold(option("ZZV", "2025-12-19", 8002), 2);
    let requested: number[] = [];
    const res = await fetchAndStoreQuotes(db, CFG, "lst", {
      asOfDate: TRADING_DAY,
      fetchSnapshot: async (_c, _l, conids) => {
        requested = [...requested, ...conids];
        return conids.map((c) => quote(c, 50));
      },
      fetchYields: async () => ({}),
    });
    expect(requested.filter((c) => c === 7001)).toHaveLength(1);
    expect(requested).not.toContain(7002);
    expect(priceRows(under)).toEqual([{ date: TRADING_DAY, close_price: 50, source: "tws" }]);
    expect(priceRows(expiredUnder)).toEqual([]);
    expect(getSecurityQuote(db, under)).toBeNull();
    expect(res.conidsRequested).toBe(3); // two held options + one underlying
  });

  it("an underlying that is also held keeps its full-quote treatment and is requested once", async () => {
    const under = stock("ZZU", 7001);
    hold(under, 100);
    hold(option("ZZU", "2026-06-19", 8001), 2);
    let requested: number[] = [];
    await fetchAndStoreQuotes(db, CFG, "lst", {
      asOfDate: TRADING_DAY,
      fetchSnapshot: async (_c, _l, conids) => {
        requested = [...requested, ...conids];
        return conids.map((c) => quote(c, 50));
      },
      fetchYields: async () => ({}),
    });
    expect(requested.filter((c) => c === 7001)).toHaveLength(1);
    expect(getSecurityQuote(db, under)).not.toBeNull();
  });

  it("no price row on a market-closed day", async () => {
    const under = stock("ZZU", 7001);
    hold(option("ZZU", "2026-06-19", 8001), 2);
    await fetchAndStoreQuotes(db, CFG, "lst", {
      asOfDate: "2026-01-03",
      fetchSnapshot: async (_c, _l, conids) => conids.map((c) => quote(c, 50)),
      fetchYields: async () => ({}),
    });
    expect(priceRows(under)).toEqual([]);
  });
});

describe("a failure in the extra set never costs the held rows", () => {
  it("the snapshot still prices held securities when the as-of date is unusable for the option filter", async () => {
    const held = stock("ZZH", 7003);
    hold(held, 100);
    const api = snapshotApi(50);
    // isMarketClosed lets this through; liveOptionExpirationSql rejects it.
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const results = await fetchSnapshotPrices(db, { asOfDate: "2026-1-2", nowEt: "10:00" });
    expect(errorLog).toHaveBeenCalledWith("[fetchSnapshotPrices] Option-underlying selection failed:", expect.any(String));
    errorLog.mockRestore();
    expect(requestedConIds(api)).toEqual([7003]);
    expect(results.map((r) => r.securityId)).toEqual([held]);
  });
});

describe("underlying lookups are exact and bounded", () => {
  const FAR = "2099-06-19"; // enrichSecurities reads the real ET date
  const conIdOf = (id: number) =>
    (db.prepare("SELECT ib_con_id, sector, name FROM securities WHERE id = ?").get(id) as {
      ib_con_id: number | null;
      sector: string | null;
      name: string | null;
    });
  function api(reply: unknown[] | Error) {
    const mock = {
      getContractDetails: reply instanceof Error ? vi.fn().mockRejectedValue(reply) : vi.fn().mockResolvedValue(reply),
    };
    mockedGetIbApi.mockReturnValue(mock as unknown as ReturnType<typeof getIbApi>);
    return mock;
  }
  const match = (conId: number) => ({ industry: "Technology", longName: "ZZ Match", contract: { conId, primaryExch: "ZZX" } });
  function underlyingOnly(symbol = "ZZU"): number {
    const id = db.prepare("INSERT INTO securities (symbol, source_key) VALUES (?, ?)").run(symbol, `underlying:${symbol}`)
      .lastInsertRowid as number;
    hold(option(symbol, FAR, 8000 + id), 2);
    return id;
  }

  it("two matches for an underlying is a failed lookup: nothing is written", async () => {
    const under = underlyingOnly();
    api([match(7001), match(7002)]);
    const results = await enrichSecurities(db);
    expect(results).toEqual([
      { symbol: "ZZU", securityId: under, enriched: false, error: "Expected exactly one contract for an option underlying, got 2" },
    ]);
    expect(conIdOf(under)).toEqual({ ib_con_id: null, sector: null, name: null });
    expect(getUnderlyingLookupFailures(db, under)).toBe(1);
  });

  it("no match for an underlying is a failed lookup too", async () => {
    const under = underlyingOnly();
    api([]);
    const results = await enrichSecurities(db);
    expect(results[0].enriched).toBe(false);
    expect(results[0].error).toMatch(/got 0/);
    expect(getUnderlyingLookupFailures(db, under)).toBe(1);
  });

  it("a HELD row still takes the first of several matches, as before, and records no failure", async () => {
    const held = stock("ZZH", null);
    hold(held, 100);
    api([match(7001), match(7002)]);
    const results = await enrichSecurities(db);
    expect(results[0].enriched).toBe(true);
    expect(conIdOf(held).ib_con_id).toBe(7001);
    expect(getUnderlyingLookupFailures(db, held)).toBe(0);
    expect(db.prepare("SELECT 1 FROM settings WHERE key = ?").get(UNDERLYING_LOOKUP_FAILURES_KEY)).toBeUndefined();
  });

  it("a held row with no match is not counted as an underlying failure", async () => {
    const held = stock("ZZH", null);
    hold(held, 100);
    api([]);
    await enrichSecurities(db);
    expect(getUnderlyingLookupFailures(db, held)).toBe(0);
  });

  it("a failing underlying is requested on three full syncs and not on the fourth", async () => {
    const under = underlyingOnly();
    const mock = api([match(7001), match(7002)]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (let sync = 1; sync <= 3; sync++) {
      const results = await enrichPendingOptionUnderlyings(db, TRADING_DAY);
      expect(results).toHaveLength(1);
      expect(mock.getContractDetails).toHaveBeenCalledTimes(sync);
      expect(getUnderlyingLookupFailures(db, under)).toBe(sync);
    }
    expect(MAX_UNDERLYING_LOOKUP_FAILURES).toBe(3);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Skipping contract lookup for ZZU"));

    expect(await enrichPendingOptionUnderlyings(db, TRADING_DAY)).toEqual([]);
    expect(mock.getContractDetails).toHaveBeenCalledTimes(3);
    expect(getPendingOptionUnderlyings(db, TRADING_DAY)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Skipping contract lookup for ZZU: 3 failed lookups"));
    log.mockRestore();
    expect(conIdOf(under).ib_con_id).toBeNull();
  });

  it("a thrown lookup error counts as a failure as well", async () => {
    const under = underlyingOnly();
    api(new Error("lookup failed"));
    const results = await enrichPendingOptionUnderlyings(db, TRADING_DAY);
    expect(results[0]).toMatchObject({ enriched: false, error: "lookup failed" });
    expect(getUnderlyingLookupFailures(db, under)).toBe(1);
  });

  it("a success resets the count and stores the one contract", async () => {
    const under = underlyingOnly();
    api([]);
    await enrichPendingOptionUnderlyings(db, TRADING_DAY);
    await enrichPendingOptionUnderlyings(db, TRADING_DAY);
    expect(getUnderlyingLookupFailures(db, under)).toBe(2);
    api([match(7001)]);
    const results = await enrichPendingOptionUnderlyings(db, TRADING_DAY);
    expect(results[0].enriched).toBe(true);
    expect(conIdOf(under).ib_con_id).toBe(7001);
    expect(getUnderlyingLookupFailures(db, under)).toBe(0);
    expect(getPendingOptionUnderlyings(db, TRADING_DAY)).toEqual([]);
  });

  it("with only underlyings pending, the wider held selection is NOT requested", async () => {
    const under = underlyingOnly();
    // A held row the broad selection would pick up (its name still echoes its symbol) but the gate does not count.
    const nameless = db
      .prepare("INSERT INTO securities (symbol, name, security_type, ib_con_id) VALUES ('ZZN', 'ZZN', 'Stock', 7050)")
      .run().lastInsertRowid as number;
    hold(nameless, 10);
    const mock = api([match(7001)]);
    const results = await enrichPendingOptionUnderlyings(db, TRADING_DAY);
    expect(results.map((r) => r.securityId)).toEqual([under]);
    expect(mock.getContractDetails).toHaveBeenCalledTimes(1);
    expect(mock.getContractDetails).toHaveBeenCalledWith({ symbol: "ZZU", secType: "STK", exchange: "SMART", currency: "USD" });
    expect(conIdOf(nameless).name).toBe("ZZN");
  });

  it("makes no broker request when nothing is pending", async () => {
    const mock = api([match(7001)]);
    expect(await enrichPendingOptionUnderlyings(db, TRADING_DAY)).toEqual([]);
    expect(mock.getContractDetails).not.toHaveBeenCalled();
  });

  it("on the usual run a skipped underlying no longer rides along; a held row is still enriched", async () => {
    const under = underlyingOnly();
    const held = stock("ZZH", null);
    hold(held, 100);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      UNDERLYING_LOOKUP_FAILURES_KEY,
      JSON.stringify({ [under]: { failures: 3, lastTried: "2026-01-01" } }),
    );
    const mock = api([match(7003)]);
    const results = await enrichSecurities(db);
    expect(results.map((r) => r.securityId)).toEqual([held]);
    expect(mock.getContractDetails).toHaveBeenCalledTimes(1);
  });

  it("an unreadable failure record is treated as no failures, never as a skip", () => {
    underlyingOnly();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(UNDERLYING_LOOKUP_FAILURES_KEY, "not json");
    expect(getPendingOptionUnderlyings(db, TRADING_DAY)).toHaveLength(1);
  });
});

/**
 * One option contract's quote from the broker (Gains at risk step 2, Task S3,
 * rulings R8 and R10).
 *
 * A fake IB API and a migrated in-memory database; no TWS connection is ever
 * made (`@/lib/tws/client` is mocked). Synthetic ZZ* tickers only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ErrorCode, IBApiNextError, MarketDataType, OptionType, SecType, type IBApiNext } from "@stoqey/ib";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(),
}));

import { getIbApi } from "@/lib/tws/client";
import { marketDataTypeGeneration, setMarketDataTypeCounted } from "@/lib/tws/market-data-type";
import {
  fetchOptionQuote,
  OPTION_QUOTE_LOCK_WAIT_MS,
  brokerExpiryDay,
  snapshotTicks,
  twoSidedQuote,
  withOptionQuoteLock,
  OPTION_QUOTE_RATE_LIMIT,
  OPTION_QUOTE_RATE_WINDOW_MS,
  OPTION_QUOTE_TIMEOUT_MS,
  resetOptionQuoteLimiter,
  takeOptionQuoteSlot,
  type OptionQuoteRequest,
} from "@/lib/tws/option-quote";

const mockedGetIbApi = vi.mocked(getIbApi);

const NOW = new Date("2026-11-10T19:32:00Z");
const OPTION_CON_ID = 77001;
const UNDERLYING_CON_ID = 5001;

type Ticks = Array<[number, number]>;
function marketData(ticks: Ticks): Map<number, { value: number }> {
  return new Map(ticks.map(([type, value]) => [type, { value }]));
}

/**
 * A one-time snapshot observable, as `getMarketData(..., true, false)` returns: one update with every
 * tick, then completion, delivered asynchronously. "hang" never completes; an Error errors the stream.
 */
function snapshotObservable(outcome: Ticks | Error | "hang") {
  const unsubscribe = vi.fn();
  return {
    unsubscribe,
    subscribe(observer: { next: (u: { all: Map<number, { value: number }> }) => void; error: (e: unknown) => void; complete: () => void }) {
      let closed = false;
      queueMicrotask(() => {
        if (closed || outcome === "hang") return;
        if (outcome instanceof Error) observer.error(outcome);
        else {
          observer.next({ all: marketData(outcome) });
          observer.complete();
        }
      });
      return {
        unsubscribe: () => {
          closed = true;
          unsubscribe();
        },
      };
    },
  };
}

interface FakeOpts {
  details?: unknown[] | Error | "hang";
  option?: Ticks | Error | "hang";
  underlying?: Ticks | Error | "hang";
}

function fakeApi(o: FakeOpts = {}) {
  const resolveOrFail = <T>(v: T | Error | "hang") =>
    v === "hang" ? new Promise<never>(() => {}) : v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  const details = o.details ?? [
    { contract: { conId: OPTION_CON_ID, symbol: "ZZQ", secType: "OPT", multiplier: 100, tradingClass: "ZZQ", exchange: "SMART" } },
  ];
  const api = {
    getContractDetails: vi.fn(() => resolveOrFail(details)),
    // Step 3: the quote reads through the shared snapshot form, getMarketData(contract, "", true, false).
    getMarketData: vi.fn((contract: { secType?: string }) =>
      snapshotObservable(contract.secType === SecType.OPT ? (o.option ?? []) : (o.underlying ?? [])),
    ),
    setMarketDataType: vi.fn(),
    getHistoricalData: vi.fn(),
  };
  return api;
}

let db: Database.Database;
let underlyingId: number;

function req(patch: Partial<OptionQuoteRequest> = {}): OptionQuoteRequest {
  return { underlyingSecurityId: underlyingId, right: "put", expiry: "2027-03-19", strike: 500, ...patch };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  mockedGetIbApi.mockReset();
  underlyingId = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency, ib_con_id) VALUES ('ZZQ', 'ZZQ Fund', 'ETF', 'USD', ?)")
    .run(UNDERLYING_CON_ID).lastInsertRowid as number;
  vi.clearAllMocks();
});

describe("fetchOptionQuote", () => {
  it("two-sided live quote fills the mid", async () => {
    const api = fakeApi({ option: [[1, 6.3], [2, 6.5], [4, 6.1]], underlying: [[4, 510.25]] });
    const r = await fetchOptionQuote(db, req(), { api: api as unknown as IBApiNext, now: () => NOW });
    expect(r).toMatchObject({ ok: true, bid: 6.3, ask: 6.5, mid: 6.4, tickKind: "live" });
    expect(r).toEqual({
      ok: true,
      bid: 6.3,
      ask: 6.5,
      mid: 6.4,
      last: 6.1,
      underlyingLast: 510.25,
      tickKind: "live",
      fetchedAt: NOW.toISOString(),
    });
    // One contract lookup, one snapshot of the contract, one of the underlying; no historical request.
    expect(api.getContractDetails).toHaveBeenCalledTimes(1);
    expect(api.getMarketData).toHaveBeenCalledTimes(2);
    expect(api.getHistoricalData).not.toHaveBeenCalled();
  });

  it("the mid is the plain average of bid and ask (a half cent stays), never a model price", async () => {
    const api = fakeApi({ option: [[1, 6.31], [2, 6.36]] });
    const r = await fetchOptionQuote(db, req(), { api: api as unknown as IBApiNext, now: () => NOW });
    expect(r).toMatchObject({ ok: true, mid: 6.335, underlyingLast: null, last: null });
  });

  it("delayed ticks are labelled delayed", async () => {
    const api = fakeApi({ option: [[66, 6.3], [67, 6.5], [68, 6.4]], underlying: [[4, 510]] });
    const r = await fetchOptionQuote(db, req(), { api: api as unknown as IBApiNext, now: () => NOW });
    expect(r).toMatchObject({ ok: true, bid: 6.3, ask: 6.5, mid: 6.4, last: 6.4, tickKind: "delayed" });

    // A live option quote with a delayed underlying price is still labelled delayed.
    const api2 = fakeApi({ option: [[1, 6.3], [2, 6.5]], underlying: [[68, 510]] });
    const r2 = await fetchOptionQuote(db, req(), { api: api2 as unknown as IBApiNext, now: () => NOW });
    expect(r2).toMatchObject({ ok: true, underlyingLast: 510, tickKind: "delayed" });

    // A live tick wins over a delayed one for the same figure.
    const api3 = fakeApi({ option: [[1, 6.3], [66, 6.0], [2, 6.5], [67, 7.0]], underlying: [[4, 510]] });
    const r3 = await fetchOptionQuote(db, req(), { api: api3 as unknown as IBApiNext, now: () => NOW });
    expect(r3).toMatchObject({ ok: true, bid: 6.3, ask: 6.5, tickKind: "live" });
  });

  it("one-sided: no-two-sided-quote, nothing filled, last still reported", async () => {
    const api = fakeApi({ option: [[1, 6.3], [2, -1], [4, 6.1]] });
    const r = await fetchOptionQuote(db, req(), { api: api as unknown as IBApiNext, now: () => NOW });
    expect(r).toEqual({ ok: false, reason: "no-two-sided-quote", bid: 6.3, ask: null, last: 6.1 });

    const empty = fakeApi({ option: [] });
    const r2 = await fetchOptionQuote(db, req(), { api: empty as unknown as IBApiNext, now: () => NOW });
    expect(r2).toEqual({ ok: false, reason: "no-two-sided-quote", bid: null, ask: null, last: null });

    // A snapshot that fails for another reason (no market-data permission) is no quote, not a throw.
    const denied = fakeApi({ option: new Error("Requested market data is not subscribed") });
    const r3 = await fetchOptionQuote(db, req(), { api: denied as unknown as IBApiNext, now: () => NOW });
    expect(r3).toEqual({ ok: false, reason: "no-two-sided-quote", bid: null, ask: null, last: null });
  });

  it("an unlisted contract is no-contract; no contract id on the underlying is no-underlying-contract", async () => {
    const none = fakeApi({ details: [] });
    expect(await fetchOptionQuote(db, req(), { api: none as unknown as IBApiNext })).toEqual({
      ok: false,
      reason: "no-contract",
      bid: null,
      ask: null,
      last: null,
    });
    expect(none.getMarketData).not.toHaveBeenCalled();

    // The broker answers an unknown contract with error 200 ("No security definition has been found").
    const err200 = fakeApi({ details: new IBApiNextError(new Error("No security definition has been found for the request"), 200 as ErrorCode, 7) });
    expect(await fetchOptionQuote(db, req(), { api: err200 as unknown as IBApiNext })).toMatchObject({ ok: false, reason: "no-contract" });
    expect(err200.getMarketData).not.toHaveBeenCalled();

    // A match with another multiplier (an adjusted contract) is not this contract.
    const adjusted = fakeApi({ details: [{ contract: { conId: 9, multiplier: 50, tradingClass: "ZZQ1" } }] });
    expect(await fetchOptionQuote(db, req(), { api: adjusted as unknown as IBApiNext })).toMatchObject({ ok: false, reason: "no-contract" });

    db.prepare("UPDATE securities SET ib_con_id = NULL WHERE id = ?").run(underlyingId);
    const api = fakeApi();
    expect(await fetchOptionQuote(db, req(), { api: api as unknown as IBApiNext })).toEqual({
      ok: false,
      reason: "no-underlying-contract",
      bid: null,
      ask: null,
      last: null,
    });
    expect(await fetchOptionQuote(db, req({ underlyingSecurityId: 99999 }), { api: api as unknown as IBApiNext })).toMatchObject({
      ok: false,
      reason: "no-underlying-contract",
    });
    expect(api.getContractDetails).not.toHaveBeenCalled();
    expect(api.getMarketData).not.toHaveBeenCalled();
  });

  it("several matching contracts: the standard trading class wins, else ambiguous-contract", async () => {
    const two = fakeApi({
      details: [
        { contract: { conId: 1, multiplier: 100, tradingClass: "ZZQ7" } },
        { contract: { conId: OPTION_CON_ID, multiplier: "100", tradingClass: "ZZQ" } },
      ],
      option: [[1, 6.3], [2, 6.5]],
    });
    const r = await fetchOptionQuote(db, req(), { api: two as unknown as IBApiNext, now: () => NOW });
    expect(r).toMatchObject({ ok: true, mid: 6.4 });
    const optCall = two.getMarketData.mock.calls.find((c) => (c[0] as { secType?: string }).secType === SecType.OPT);
    expect((optCall![0] as { conId: number }).conId).toBe(OPTION_CON_ID);

    const ambiguous = fakeApi({
      details: [
        { contract: { conId: 1, multiplier: 100, tradingClass: "ZZQ7" } },
        { contract: { conId: 2, multiplier: 100, tradingClass: "ZZQ8" } },
      ],
    });
    expect(await fetchOptionQuote(db, req(), { api: ambiguous as unknown as IBApiNext })).toMatchObject({
      ok: false,
      reason: "ambiguous-contract",
    });
    expect(ambiguous.getMarketData).not.toHaveBeenCalled();
  });

  it("a crossed quote (bid above ask) is not a market: no-two-sided-quote, nothing filled", async () => {
    const api = fakeApi({ option: [[1, 6.5], [2, 6.3], [4, 6.4]] });
    const r = await fetchOptionQuote(db, req(), { api: api as unknown as IBApiNext, now: () => NOW });
    expect(r).toEqual({ ok: false, reason: "no-two-sided-quote", bid: 6.5, ask: 6.3, last: 6.4 });
    // Crossed across a live bid and a delayed ask too.
    const mixed = fakeApi({ option: [[1, 6.5], [67, 6.3]] });
    expect(await fetchOptionQuote(db, req(), { api: mixed as unknown as IBApiNext, now: () => NOW })).toMatchObject({
      ok: false,
      reason: "no-two-sided-quote",
    });
  });

  it("a locked market (bid equals ask) is accepted, mid at that price", async () => {
    const api = fakeApi({ option: [[1, 6.4], [2, 6.4]] });
    const r = await fetchOptionQuote(db, req(), { api: api as unknown as IBApiNext, now: () => NOW });
    expect(r).toMatchObject({ ok: true, bid: 6.4, ask: 6.4, mid: 6.4 });
  });

  it("setMarketDataType throwing, or a snapshot call throwing synchronously, is broker-error; the type is still restored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const typeThrows = fakeApi({ option: [[1, 6.3], [2, 6.5]] });
    typeThrows.setMarketDataType.mockImplementationOnce(() => {
      throw new Error("socket closed");
    });
    const r1 = await fetchOptionQuote(db, req(), { api: typeThrows as unknown as IBApiNext, now: () => NOW });
    expect(r1).toEqual({ ok: false, reason: "broker-error", bid: null, ask: null, last: null });
    expect(typeThrows.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN], [MarketDataType.REALTIME]]);
    expect(typeThrows.getMarketData).not.toHaveBeenCalled();

    const syncThrow = fakeApi();
    syncThrow.getMarketData.mockImplementation(() => {
      throw new Error("not connected to socket");
    });
    const r2 = await fetchOptionQuote(db, req(), { api: syncThrow as unknown as IBApiNext, now: () => NOW });
    expect(r2).toEqual({ ok: false, reason: "broker-error", bid: null, ask: null, last: null });
    expect(syncThrow.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN], [MarketDataType.REALTIME]]);
    vi.mocked(console.warn).mockRestore();
  });

  it("the per-process quote limit: 30 in any rolling 60 seconds, then a wait in seconds", () => {
    expect(OPTION_QUOTE_RATE_LIMIT).toBe(30);
    expect(OPTION_QUOTE_RATE_WINDOW_MS).toBe(60_000);
    resetOptionQuoteLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) expect(takeOptionQuoteSlot(t0 + i * 1000)).toEqual({ ok: true });
    // The 31st inside the window is refused until the first request is 60 s old.
    expect(takeOptionQuoteSlot(t0 + 30_000)).toEqual({ ok: false, retryAfterSeconds: 30 });
    expect(takeOptionQuoteSlot(t0 + 59_999)).toEqual({ ok: false, retryAfterSeconds: 1 });
    // A refusal does not use a slot; at t0 + 60 s the first slot is free again.
    expect(takeOptionQuoteSlot(t0 + 60_000)).toEqual({ ok: true });
    expect(takeOptionQuoteSlot(t0 + 60_000)).toEqual({ ok: false, retryAfterSeconds: 1 });
    resetOptionQuoteLimiter();
    expect(takeOptionQuoteSlot(t0)).toEqual({ ok: true });
    resetOptionQuoteLimiter();
  });

  it("not connected and a timeout never throw", async () => {
    mockedGetIbApi.mockReturnValue(null);
    expect(await fetchOptionQuote(db, req())).toEqual({ ok: false, reason: "not-connected", bid: null, ask: null, last: null });
    expect(await fetchOptionQuote(db, req(), { api: null })).toEqual({ ok: false, reason: "not-connected", bid: null, ask: null, last: null });

    expect(OPTION_QUOTE_TIMEOUT_MS).toBe(15_000);
    const slowDetails = fakeApi({ details: "hang" });
    expect(await fetchOptionQuote(db, req(), { api: slowDetails as unknown as IBApiNext, timeoutMs: 5 })).toEqual({
      ok: false,
      reason: "timeout",
      bid: null,
      ask: null,
      last: null,
    });
    const slowQuote = fakeApi({ option: "hang", underlying: [[4, 510]] });
    expect(await fetchOptionQuote(db, req(), { api: slowQuote as unknown as IBApiNext, timeoutMs: 5 })).toMatchObject({
      ok: false,
      reason: "timeout",
    });
    // A slow underlying alone leaves the underlying's price out; the quote still stands.
    const slowUnderlying = fakeApi({ option: [[1, 6.3], [2, 6.5]], underlying: "hang" });
    expect(await fetchOptionQuote(db, req(), { api: slowUnderlying as unknown as IBApiNext, timeoutMs: 5 })).toMatchObject({
      ok: true,
      underlyingLast: null,
    });

    // A broker error other than "not listed" while still connected.
    mockedGetIbApi.mockReturnValue({} as unknown as IBApiNext);
    const broken = fakeApi({ details: new IBApiNextError(new Error("Error validating request"), 321 as ErrorCode, 7) });
    expect(await fetchOptionQuote(db, req(), { api: broken as unknown as IBApiNext })).toMatchObject({ ok: false, reason: "broker-error" });
    // The same error after the connection dropped reads not-connected.
    mockedGetIbApi.mockReturnValue(null);
    expect(await fetchOptionQuote(db, req(), { api: broken as unknown as IBApiNext })).toMatchObject({ ok: false, reason: "not-connected" });

    // Even a database failure is an answer.
    const closed = new Database(":memory:");
    closed.close();
    await expect(fetchOptionQuote(closed, req(), { api: fakeApi() as unknown as IBApiNext })).resolves.toMatchObject({ ok: false });
  });

  it("the contract carries multiplier 100 and the underlying's conId", async () => {
    const api = fakeApi({ option: [[1, 6.3], [2, 6.5]], underlying: [[4, 510]] });
    await fetchOptionQuote(db, req({ right: "call", expiry: "2027-03-19", strike: 512.5 }), {
      api: api as unknown as IBApiNext,
      now: () => NOW,
    });
    expect(api.getContractDetails).toHaveBeenCalledWith({
      symbol: "ZZQ",
      secType: SecType.OPT,
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: "20270319",
      strike: 512.5,
      right: OptionType.Call,
      multiplier: 100,
    });
    const calls = api.getMarketData.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const opt = calls.find((c) => c.secType === SecType.OPT)!;
    expect(opt).toMatchObject({ conId: OPTION_CON_ID, multiplier: 100, exchange: "SMART", currency: "USD" });
    const und = calls.find((c) => c.secType === SecType.STK)!;
    expect(und).toEqual({ conId: UNDERLYING_CON_ID, secType: SecType.STK, exchange: "SMART", currency: "USD" });
    for (const c of api.getMarketData.mock.calls) expect(c.slice(1)).toEqual(["", true, false]);
  });

  it("restores the realtime market-data type after the request", async () => {
    const api = fakeApi({ option: [[1, 6.3], [2, 6.5]] });
    await fetchOptionQuote(db, req(), { api: api as unknown as IBApiNext, now: () => NOW });
    expect(api.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN], [MarketDataType.REALTIME]]);

    // Also after a failed snapshot.
    const failing = fakeApi({ option: new Error("boom"), underlying: new Error("boom") });
    await fetchOptionQuote(db, req(), { api: failing as unknown as IBApiNext, now: () => NOW });
    expect(failing.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN], [MarketDataType.REALTIME]]);

    // A refusal before any snapshot never changes the type.
    const none = fakeApi({ details: [] });
    await fetchOptionQuote(db, req(), { api: none as unknown as IBApiNext });
    expect(none.setMarketDataType).not.toHaveBeenCalled();
  });

  it("logs at most one content-free line per failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = fakeApi({ details: new IBApiNextError(new Error("Error validating request ZZQ 500"), 321 as ErrorCode, 7) });
    mockedGetIbApi.mockReturnValue({} as unknown as IBApiNext);
    await fetchOptionQuote(db, req(), { api: broken as unknown as IBApiNext });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(["[option-quote] contract lookup failed: code 321"]);
    warn.mockRestore();
  });
});

describe("step 3: shared snapshot read, two-sided rule, generation retry and the lock", () => {
  it("T25 a generation change in flight retries once; a second change answers broker-busy", async () => {
    // Another caller sets the type while the first option snapshot is in flight.
    const other = { setMarketDataType: vi.fn() };
    const once = fakeApi({ option: [[1, 6.3], [2, 6.5]], underlying: [[4, 510]] });
    const plain = once.getMarketData.getMockImplementation()!;
    let optionCalls = 0;
    once.getMarketData.mockImplementation((contract: { secType?: string }) => {
      if (contract.secType === SecType.OPT && ++optionCalls === 1) setMarketDataTypeCounted(other, MarketDataType.REALTIME);
      return plain(contract);
    });
    const r = await fetchOptionQuote(db, req(), { api: once as unknown as IBApiNext, now: () => NOW });
    expect(r).toMatchObject({ ok: true, mid: 6.4 });
    expect(optionCalls).toBe(2);
    // The type is set, set again for the retry, then restored once.
    expect(once.setMarketDataType.mock.calls).toEqual([
      [MarketDataType.DELAYED_FROZEN],
      [MarketDataType.DELAYED_FROZEN],
      [MarketDataType.REALTIME],
    ]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const twice = fakeApi({ option: [[1, 6.3], [2, 6.5]], underlying: [[4, 510]] });
    const plain2 = twice.getMarketData.getMockImplementation()!;
    twice.getMarketData.mockImplementation((contract: { secType?: string }) => {
      if (contract.secType === SecType.OPT) setMarketDataTypeCounted(other, MarketDataType.REALTIME);
      return plain2(contract);
    });
    const r2 = await fetchOptionQuote(db, req(), { api: twice as unknown as IBApiNext, now: () => NOW });
    expect(r2).toEqual({ ok: false, reason: "broker-busy", bid: null, ask: null, last: null });
    expect(twice.getMarketData.mock.calls.filter((c) => (c[0] as { secType?: string }).secType === SecType.OPT)).toHaveLength(2);
    expect(twice.setMarketDataType.mock.calls.at(-1)).toEqual([MarketDataType.REALTIME]);
    warn.mockRestore();
  });

  it("the type is set through the counted setter: the generation moves by two per plain quote", async () => {
    const api = fakeApi({ option: [[1, 6.3], [2, 6.5]] });
    const before = marketDataTypeGeneration();
    await fetchOptionQuote(db, req(), { api: api as unknown as IBApiNext, now: () => NOW });
    expect(marketDataTypeGeneration()).toBe(before + 2);
  });

  it("T25 a single quote started while the lock is held waits for it: the fake sees no interleaved request", async () => {
    const api = fakeApi({ option: [[1, 6.3], [2, 6.5]] });
    let release!: () => void;
    const holder = withOptionQuoteLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const quote = fetchOptionQuote(db, req(), { api: api as unknown as IBApiNext, now: () => NOW });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(api.getContractDetails).not.toHaveBeenCalled();
    expect(api.setMarketDataType).not.toHaveBeenCalled();
    release();
    await holder;
    expect(await quote).toMatchObject({ ok: true });
    expect(api.getContractDetails).toHaveBeenCalledTimes(1);
  });

  it("the lock is released when its holder throws", async () => {
    await expect(withOptionQuoteLock(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await expect(withOptionQuoteLock(async () => 7)).resolves.toBe(7);
  });

  it("T13 one-sided, crossed and empty quotes fill nothing; a locked quote (bid === ask) fills", () => {
    expect(twoSidedQuote(marketData([[1, 6.3], [2, -1]]))).toEqual({ ok: false, bid: 6.3, ask: null, last: null });
    expect(twoSidedQuote(marketData([[1, 6.5], [2, 6.3], [4, 6.4]]))).toEqual({ ok: false, bid: 6.5, ask: 6.3, last: 6.4 });
    expect(twoSidedQuote(marketData([]))).toEqual({ ok: false, bid: null, ask: null, last: null });
    expect(twoSidedQuote(marketData([[66, 0.15], [67, 0.15]]))).toEqual({
      ok: true,
      bid: { value: 0.15, delayed: true },
      ask: { value: 0.15, delayed: true },
      last: null,
    });
  });

  it("snapshotTicks: resolves on completion with the arrival time, unsubscribes, ignores late ticks; the backstop ends a hang", async () => {
    let t = NOW.getTime();
    const clock = () => new Date(t);
    const done = snapshotObservable([[1, 6.3]]);
    const api = { getMarketData: vi.fn(() => done) };
    const pending = snapshotTicks(api as unknown as IBApiNext, { conId: 1 }, { now: clock });
    t += 2_000;
    const r = await pending;
    expect(r).toEqual({ ok: true, ticks: marketData([[1, 6.3]]), arrivedAt: new Date(NOW.getTime() + 2_000).toISOString() });
    expect(api.getMarketData).toHaveBeenCalledWith({ conId: 1 }, "", true, false);
    expect(done.unsubscribe).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      const hang = snapshotObservable("hang");
      const hangApi = { getMarketData: vi.fn(() => hang) };
      let settled = false;
      const p = snapshotTicks(hangApi as unknown as IBApiNext, { conId: 2 }, { now: clock }).then((v) => {
        settled = true;
        return v;
      });
      await vi.advanceTimersByTimeAsync(12_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual({ ok: false, reason: "timeout" });
      expect(hang.unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }

    // A synchronous throw while sending is reported as a send failure, never thrown.
    const throwing = { getMarketData: vi.fn(() => { throw new Error("socket"); }) };
    expect(await snapshotTicks(throwing as unknown as IBApiNext, { conId: 3 }, { now: clock })).toMatchObject({
      ok: false,
      reason: "error",
      sendFailed: true,
    });
  });
});

describe("S2 fix round 1: single quote", () => {
  it("a lock wait past OPTION_QUOTE_LOCK_WAIT_MS answers broker-busy with zero broker requests; the lock still passes on", async () => {
    expect(OPTION_QUOTE_LOCK_WAIT_MS).toBe(20_000);
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const api = fakeApi({ option: [[1, 6.3], [2, 6.5]] });
      let release!: () => void;
      const holder = withOptionQuoteLock(() => new Promise<void>((r) => (release = r)));
      let settled = false;
      const quote = fetchOptionQuote(db, req(), { api: api as unknown as IBApiNext, now: () => NOW }).then((v) => {
        settled = true;
        return v;
      });
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await quote).toEqual({ ok: false, reason: "broker-busy", bid: null, ask: null, last: null });
      expect(api.getContractDetails).not.toHaveBeenCalled();
      expect(api.getMarketData).not.toHaveBeenCalled();
      expect(api.setMarketDataType).not.toHaveBeenCalled();
      release();
      await holder;
      // The refused waiter's place in the chain is passed on: the next caller runs at once.
      await expect(withOptionQuoteLock(async () => "free")).resolves.toBe("free");
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("the type is not restored when the connection dropped during the quote", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = fakeApi({ option: new Error("connection lost") });
    const plain = api.getMarketData.getMockImplementation()!;
    api.getMarketData.mockImplementation((contract: { secType?: string }) => {
      mockedGetIbApi.mockReturnValue(null);
      return plain(contract);
    });
    const r = await fetchOptionQuote(db, req(), { api: api as unknown as IBApiNext, now: () => NOW });
    expect(r).toEqual({ ok: false, reason: "not-connected", bid: null, ask: null, last: null });
    expect(api.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN]]);
    warn.mockRestore();
  });

  it("brokerExpiryDay reads the day of a suffixed broker expiry; a bare month or junk is null", () => {
    expect(brokerExpiryDay("20261218")).toBe("2026-12-18");
    expect(brokerExpiryDay("20261218 16:00 US/Eastern")).toBe("2026-12-18");
    expect(brokerExpiryDay(" 20261218 ")).toBe("2026-12-18");
    expect(brokerExpiryDay("202612")).toBeNull();
    expect(brokerExpiryDay("202612189")).toBeNull();
    expect(brokerExpiryDay(undefined)).toBeNull();
  });
});

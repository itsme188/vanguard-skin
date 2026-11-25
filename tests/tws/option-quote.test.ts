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
import {
  fetchOptionQuote,
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
    getMarketDataSnapshot: vi.fn((contract: { secType?: string }) =>
      contract.secType === SecType.OPT
        ? resolveOrFail(o.option === undefined ? [] : o.option).then((t) => marketData(t as Ticks))
        : resolveOrFail(o.underlying === undefined ? [] : o.underlying).then((t) => marketData(t as Ticks)),
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
    expect(api.getMarketDataSnapshot).toHaveBeenCalledTimes(2);
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
    expect(none.getMarketDataSnapshot).not.toHaveBeenCalled();

    // The broker answers an unknown contract with error 200 ("No security definition has been found").
    const err200 = fakeApi({ details: new IBApiNextError(new Error("No security definition has been found for the request"), 200 as ErrorCode, 7) });
    expect(await fetchOptionQuote(db, req(), { api: err200 as unknown as IBApiNext })).toMatchObject({ ok: false, reason: "no-contract" });
    expect(err200.getMarketDataSnapshot).not.toHaveBeenCalled();

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
    expect(api.getMarketDataSnapshot).not.toHaveBeenCalled();
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
    const optCall = two.getMarketDataSnapshot.mock.calls.find((c) => (c[0] as { secType?: string }).secType === SecType.OPT);
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
    expect(ambiguous.getMarketDataSnapshot).not.toHaveBeenCalled();
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
    expect(typeThrows.getMarketDataSnapshot).not.toHaveBeenCalled();

    const syncThrow = fakeApi();
    syncThrow.getMarketDataSnapshot.mockImplementation(() => {
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
    const calls = api.getMarketDataSnapshot.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const opt = calls.find((c) => c.secType === SecType.OPT)!;
    expect(opt).toMatchObject({ conId: OPTION_CON_ID, multiplier: 100, exchange: "SMART", currency: "USD" });
    const und = calls.find((c) => c.secType === SecType.STK)!;
    expect(und).toEqual({ conId: UNDERLYING_CON_ID, secType: SecType.STK, exchange: "SMART", currency: "USD" });
    for (const c of api.getMarketDataSnapshot.mock.calls) expect(c.slice(1)).toEqual(["", false]);
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

/**
 * The guarded option-chain reader (Gains at risk step 3, Task S2: P11, D1, D7, F9).
 * A fake IB API and a migrated in-memory database; `@/lib/tws/client` is mocked.
 * Synthetic ZZ* tickers and invented figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ErrorCode, IBApiNextError, OptionType, SecType, type IBApiNext } from "@stoqey/ib";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(),
}));

import { getIbApi } from "@/lib/tws/client";
import {
  fetchOptionChain,
  OPTION_CHAIN_RATE_LIMIT,
  OPTION_CHAIN_RATE_WINDOW_MS,
  reserveOptionChainSlots,
  resetOptionChainLimiter,
} from "@/lib/tws/option-chain-reader";

const mockedGetIbApi = vi.mocked(getIbApi);
// 2026-11-10 14:32 Eastern.
const NOW = new Date("2026-11-10T19:32:00Z");
const UNDERLYING_CON_ID = 5201;

let db: Database.Database;
let underlyingId: number;

function detail(strike: number, patch: Record<string, unknown> = {}, expiry = "20270115") {
  return {
    contract: {
      conId: Math.round(strike * 100),
      symbol: "ZZA",
      secType: "OPT",
      right: "P",
      lastTradeDateOrContractMonth: expiry,
      strike,
      multiplier: "100",
      tradingClass: "ZZA",
      ...patch,
    },
  };
}

function fakeApi(o: { params?: unknown[] | Error | "hang"; details?: (expiry: string) => unknown[] | Error | "hang" } = {}) {
  const settle = <T>(v: T | Error | "hang") =>
    v === "hang" ? new Promise<never>(() => {}) : v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  return {
    getSecDefOptParams: vi.fn(() => settle(o.params ?? [])),
    getContractDetails: vi.fn((c: { lastTradeDateOrContractMonth?: string }) => settle(o.details?.(c.lastTradeDateOrContractMonth ?? "") ?? [])),
    getMarketData: vi.fn(),
    getHistoricalData: vi.fn(),
    setMarketDataType: vi.fn(),
  };
}

const run = (api: ReturnType<typeof fakeApi>, req: Partial<Parameters<typeof fetchOptionChain>[1]> = {}, deps = {}) =>
  fetchOptionChain(db, { underlyingSecurityId: underlyingId, right: "put", ...req }, { api: api as unknown as IBApiNext, now: () => NOW, ...deps });

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  mockedGetIbApi.mockReset();
  mockedGetIbApi.mockReturnValue({} as unknown as IBApiNext);
  resetOptionChainLimiter();
  underlyingId = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency, ib_con_id) VALUES ('ZZA', 'ZZA Corp', 'Stock', 'USD', ?)")
    .run(UNDERLYING_CON_ID).lastInsertRowid as number;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.mocked(console.warn).mockRestore();
});

describe("fetchOptionChain", () => {
  it("expiries: today or later, multiplier 100 only, ascending, unique", async () => {
    const api = fakeApi({
      params: [
        { exchange: "SMART", underlyingConId: UNDERLYING_CON_ID, tradingClass: "ZZA", multiplier: "100", expirations: ["20270115", "20261110", "20261120"], strikes: [40, 45] },
        { exchange: "CBOE", underlyingConId: UNDERLYING_CON_ID, tradingClass: "ZZA", multiplier: 100, expirations: ["20261120", "20261109", "20261218"], strikes: [40] },
        { exchange: "SMART", underlyingConId: UNDERLYING_CON_ID, tradingClass: "2ZZA", multiplier: "50", expirations: ["20261127"], strikes: [41] },
      ],
    });
    expect(await run(api)).toEqual({ ok: true, kind: "expiries", expiries: ["2026-11-10", "2026-11-20", "2026-12-18", "2027-01-15"] });
    expect(api.getSecDefOptParams).toHaveBeenCalledTimes(1);
    expect(api.getSecDefOptParams).toHaveBeenCalledWith("ZZA", "", SecType.STK, UNDERLYING_CON_ID);
    expect(api.getContractDetails).not.toHaveBeenCalled();
    expect(api.getHistoricalData).not.toHaveBeenCalled();
  });

  it("T24 strikes per expiry: conId, trading class, multiplier 100 per strike; non-standard and doubled strikes dropped and counted", async () => {
    const api = fakeApi({
      details: (expiry) =>
        expiry === "20270115"
          ? [
              detail(45),
              detail(40),
              detail(42.5, { multiplier: "50" }),
              detail(43, { tradingClass: "ZZA1" }),
              detail(44, { conId: 0 }),
              detail(46, {}, "20270122"),
              detail(47),
              detail(47, { conId: 99_999 }),
            ]
          : [detail(50, {}, "20270219")],
    });
    const r = await run(api, { expiries: ["2027-01-15", "2027-02-19"] });
    expect(r).toEqual({
      ok: true,
      kind: "strikes",
      byExpiry: [
        {
          expiry: "2027-01-15",
          contracts: [
            { conId: 4000, strike: 40, tradingClass: "ZZA", multiplier: 100 },
            { conId: 4500, strike: 45, tradingClass: "ZZA", multiplier: 100 },
          ],
          droppedNonStandard: 4,
          droppedAmbiguous: 1,
        },
        { expiry: "2027-02-19", contracts: [{ conId: 5000, strike: 50, tradingClass: "ZZA", multiplier: 100 }], droppedNonStandard: 0, droppedAmbiguous: 0 },
      ],
    });
    expect(api.getContractDetails).toHaveBeenCalledTimes(2);
    expect(api.getContractDetails).toHaveBeenNthCalledWith(1, {
      symbol: "ZZA",
      secType: SecType.OPT,
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: "20270115",
      right: OptionType.Put,
      multiplier: 100,
    });
    expect(api.getSecDefOptParams).not.toHaveBeenCalled();

    // "No security definition" for an expiry is an empty list, not a failure.
    const none = fakeApi({ details: () => new IBApiNextError(new Error("No security definition"), 200 as ErrorCode, 7) });
    expect(await run(none, { right: "call", expiries: ["2027-01-15"] })).toEqual({
      ok: true,
      kind: "strikes",
      byExpiry: [{ expiry: "2027-01-15", contracts: [], droppedNonStandard: 0, droppedAmbiguous: 0 }],
    });
    expect(none.getContractDetails.mock.calls[0][0]).toMatchObject({ right: OptionType.Call });
  });

  it("D7 bound: a pull needing more than the free slots is refused with retryAfterSeconds and sends nothing", async () => {
    expect(OPTION_CHAIN_RATE_LIMIT).toBe(12);
    expect(OPTION_CHAIN_RATE_WINDOW_MS).toBe(60_000);
    const t0 = NOW.getTime();
    expect(reserveOptionChainSlots(10, t0 - 30_000)).toEqual({ ok: true });
    const api = fakeApi({ details: () => [detail(40)] });
    // 2 free: a 3-expiry pull is refused whole; the 10 slots free at t0 + 30 s.
    expect(await run(api, { expiries: ["2027-01-15", "2027-02-19", "2027-03-19"] })).toEqual({
      ok: false,
      reason: "rate-limit",
      retryAfterSeconds: 30,
    });
    expect(api.getContractDetails).not.toHaveBeenCalled();
    // A 2-expiry pull fits exactly; then even an expiries pull is refused.
    expect(await run(api, { expiries: ["2027-01-15", "2027-02-19"] })).toMatchObject({ ok: true, kind: "strikes" });
    expect(await run(api)).toEqual({ ok: false, reason: "rate-limit", retryAfterSeconds: 30 });
    expect(api.getSecDefOptParams).not.toHaveBeenCalled();
    // The (asked - free)th oldest slot decides the wait.
    resetOptionChainLimiter();
    for (let i = 0; i < 12; i++) reserveOptionChainSlots(1, t0 + i * 1_000);
    expect(reserveOptionChainSlots(3, t0 + 12_000)).toEqual({ ok: false, retryAfterSeconds: 50 });
  });

  it("refusals before sending: not connected, no contract id → zero calls", async () => {
    const api = fakeApi();
    mockedGetIbApi.mockReturnValue(null);
    expect(await fetchOptionChain(db, { underlyingSecurityId: underlyingId, right: "put" })).toEqual({ ok: false, reason: "not-connected" });
    expect(await run(api, {}, { api: null })).toEqual({ ok: false, reason: "not-connected" });
    mockedGetIbApi.mockReturnValue({} as unknown as IBApiNext);
    expect(await run(api, { underlyingSecurityId: 99_999 })).toEqual({ ok: false, reason: "no-underlying-contract" });
    db.prepare("UPDATE securities SET ib_con_id = NULL WHERE id = ?").run(underlyingId);
    expect(await run(api, { expiries: ["2027-01-15"] })).toEqual({ ok: false, reason: "no-underlying-contract" });
    expect(api.getSecDefOptParams).not.toHaveBeenCalled();
    expect(api.getContractDetails).not.toHaveBeenCalled();
    // No slot was used by any of these.
    expect(reserveOptionChainSlots(12)).toEqual({ ok: true });
  });

  it("timeouts, broker errors and a dropped connection are answers, never throws", async () => {
    expect(await run(fakeApi({ params: "hang" }), {}, { timeoutMs: 5 })).toEqual({ ok: false, reason: "timeout" });
    resetOptionChainLimiter();
    const slow = fakeApi({ details: (e) => (e === "20270115" ? [detail(40)] : "hang") });
    expect(await run(slow, { expiries: ["2027-01-15", "2027-02-19", "2027-03-19"] }, { timeoutMs: 5 })).toEqual({ ok: false, reason: "timeout" });
    // The reader stops sending after the timeout: the third expiry is never asked.
    expect(slow.getContractDetails).toHaveBeenCalledTimes(2);
    resetOptionChainLimiter();
    const broken = fakeApi({ params: new IBApiNextError(new Error("Error validating request"), 321 as ErrorCode, 7) });
    expect(await run(broken)).toEqual({ ok: false, reason: "broker-error" });
    expect(vi.mocked(console.warn).mock.calls.at(-1)).toEqual(["[option-chain] structure failed: code 321"]);
    mockedGetIbApi.mockReturnValue(null);
    expect(await run(broken, {}, { api: broken as unknown as IBApiNext })).toEqual({ ok: false, reason: "not-connected" });
  });

  it("a malformed expiries list is a programming error, before anything is sent", async () => {
    const api = fakeApi();
    await expect(run(api, { expiries: [] })).rejects.toThrow(RangeError);
    await expect(run(api, { expiries: ["2027-01-15", "2027-02-19", "2027-03-19", "2027-04-16"] })).rejects.toThrow(RangeError);
    await expect(run(api, { expiries: ["20270115"] })).rejects.toThrow(RangeError);
    expect(api.getContractDetails).not.toHaveBeenCalled();
  });
});

describe("S2 fix round 1: chain reader", () => {
  it("strikes: a suffixed broker expiry is kept as standard; a different day is still dropped", async () => {
    const api = fakeApi({
      details: () => [detail(40, {}, "20270115 16:00 US/Eastern"), detail(45, {}, "20270122 16:00 US/Eastern")],
    });
    expect(await run(api, { expiries: ["2027-01-15"] })).toEqual({
      ok: true,
      kind: "strikes",
      byExpiry: [
        { expiry: "2027-01-15", contracts: [{ conId: 4000, strike: 40, tradingClass: "ZZA", multiplier: 100 }], droppedNonStandard: 1, droppedAmbiguous: 0 },
      ],
    });
  });

  it("expiries: an adjusted class's expiry is never offered", async () => {
    const api = fakeApi({
      params: [
        { exchange: "SMART", underlyingConId: UNDERLYING_CON_ID, tradingClass: "ZZA", multiplier: "100", expirations: ["20270115"], strikes: [40] },
        { exchange: "SMART", underlyingConId: UNDERLYING_CON_ID, tradingClass: "ZZA1", multiplier: "100", expirations: ["20270122"], strikes: [40] },
      ],
    });
    expect(await run(api)).toEqual({ ok: true, kind: "expiries", expiries: ["2027-01-15"] });
  });

  it("expiries: today's expiry is offered before the 16:00 Eastern close and not from it (injected clock)", async () => {
    const params = [
      { exchange: "SMART", underlyingConId: UNDERLYING_CON_ID, tradingClass: "ZZA", multiplier: 100, expirations: ["20261110", "20261113"], strikes: [40] },
    ];
    const before = new Date("2026-11-10T20:59:00Z"); // 15:59 Eastern
    const after = new Date("2026-11-10T21:00:00Z"); // 16:00 Eastern
    expect(await run(fakeApi({ params }), {}, { now: () => before })).toEqual({ ok: true, kind: "expiries", expiries: ["2026-11-10", "2026-11-13"] });
    expect(await run(fakeApi({ params }), {}, { now: () => after })).toEqual({ ok: true, kind: "expiries", expiries: ["2026-11-13"] });
  });
});

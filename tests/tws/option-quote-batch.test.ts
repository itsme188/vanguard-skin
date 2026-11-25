/**
 * The step 3 quote batch (Gains at risk step 3, Task S2: P10, D1, D2, D6, D7, F5, F7, F9).
 *
 * A fake IB API (scripted snapshots, a controllable clock) and a migrated in-memory
 * database; no TWS connection is ever made (`@/lib/tws/client` is mocked). Synthetic
 * ZZ* tickers and invented figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ErrorCode, IBApiNextError, MarketDataType, SecType, type IBApiNext } from "@stoqey/ib";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(),
}));

import { getIbApi } from "@/lib/tws/client";
import { setMarketDataTypeCounted } from "@/lib/tws/market-data-type";
import {
  OPTION_QUOTE_LOCK_WAIT_MS,
  OPTION_SNAPSHOT_BACKSTOP_MS,
  reserveOptionQuoteSlots,
  resetOptionQuoteLimiter,
  takeOptionQuoteSlot,
  withOptionQuoteLock,
} from "@/lib/tws/option-quote";
import {
  fetchOptionQuoteBatch,
  OPTION_QUOTE_BATCH_DEADLINE_MS,
  type BatchContractRequest,
  type OptionQuoteBatchDeps,
} from "@/lib/tws/option-quote-batch";

const mockedGetIbApi = vi.mocked(getIbApi);

const T0 = new Date("2026-11-10T19:32:00Z").getTime();
const UNDERLYING_CON_ID = 5101;
const EXPIRY = "2027-01-15";

type Ticks = Array<[number, number]>;
function marketData(ticks: Ticks): Map<number, { value: number }> {
  return new Map(ticks.map(([type, value]) => [type, { value }]));
}

interface SnapScript {
  ticks?: Ticks;
  error?: Error;
  hang?: boolean;
  /** Held until the test calls the returned complete(). */
  manual?: boolean;
  /** The clock moves this far while the snapshot runs (before it completes). */
  advanceMs?: number;
  /** Runs at subscribe time. */
  onSubscribe?: () => void;
}

let t = T0;
const clock = () => new Date(t);

function contract(i: number, patch: Partial<BatchContractRequest> = {}): BatchContractRequest {
  return { conId: 9000 + i, right: "put", expiry: EXPIRY, strike: 40 + i, multiplier: 100, tradingClass: "ZZA", ...patch };
}

function description(c: BatchContractRequest, patch: Record<string, unknown> = {}) {
  return {
    contract: {
      conId: c.conId,
      symbol: "ZZA",
      secType: "OPT",
      right: c.right === "put" ? "P" : "C",
      lastTradeDateOrContractMonth: c.expiry.replace(/-/g, ""),
      strike: c.strike,
      multiplier: "100",
      tradingClass: "ZZA",
      ...patch,
    },
  };
}

interface BrokerOpts {
  underlying?: (call: number) => SnapScript;
  option?: (conId: number, call: number) => SnapScript;
  details?: (conId: number) => unknown[] | Error | "hang" | (() => Promise<unknown[]>);
  contracts?: BatchContractRequest[];
}

function fakeBroker(o: BrokerOpts = {}) {
  let open = 0;
  let maxOpen = 0;
  let underlyingCalls = 0;
  const optionCalls = new Map<number, number>();
  const manual: Array<() => void> = [];
  const unsubscribes = vi.fn();
  const byConId = new Map((o.contracts ?? []).map((c) => [c.conId, c]));

  const api = {
    getContractDetails: vi.fn((lookup: { conId: number }) => {
      const scripted = o.details?.(lookup.conId);
      if (scripted === "hang") return new Promise<never>(() => {});
      if (scripted instanceof Error) return Promise.reject(scripted);
      if (typeof scripted === "function") return scripted();
      if (scripted !== undefined) return Promise.resolve(scripted);
      const c = byConId.get(lookup.conId);
      return Promise.resolve(c ? [description(c)] : []);
    }),
    getMarketData: vi.fn((c: { secType?: string; conId?: number }) => {
      const isOption = c.secType === SecType.OPT;
      let script: SnapScript;
      if (isOption) {
        const n = (optionCalls.get(c.conId!) ?? 0) + 1;
        optionCalls.set(c.conId!, n);
        script = o.option?.(c.conId!, n) ?? { ticks: [[1, 1.2], [2, 1.3]] };
      } else {
        underlyingCalls++;
        script = o.underlying?.(underlyingCalls) ?? { ticks: [[4, 50]] };
      }
      return {
        subscribe(observer: { next: (u: unknown) => void; error: (e: unknown) => void; complete: () => void }) {
          let closed = false;
          open++;
          maxOpen = Math.max(maxOpen, open);
          script.onSubscribe?.();
          const deliver = () => {
            if (closed) return;
            t += script.advanceMs ?? 0;
            if (script.error) observer.error(script.error);
            else {
              observer.next({ all: marketData(script.ticks ?? []) });
              observer.complete();
            }
          };
          if (script.manual) manual.push(deliver);
          else if (!script.hang) queueMicrotask(deliver);
          return {
            unsubscribe: () => {
              if (!closed) open--;
              closed = true;
              unsubscribes();
            },
          };
        },
      };
    }),
    setMarketDataType: vi.fn(),
    cancelMktData: vi.fn(),
    getHistoricalData: vi.fn(),
  };
  return {
    api,
    unsubscribes,
    manual,
    get maxOpen() {
      return maxOpen;
    },
    get open() {
      return open;
    },
    get underlyingCalls() {
      return underlyingCalls;
    },
    optionSnapshotCount: () => [...optionCalls.values()].reduce((a, b) => a + b, 0),
    optionSnapshotsFor: (conId: number) => optionCalls.get(conId) ?? 0,
  };
}

let db: Database.Database;
let underlyingId: number;

function run(contracts: BatchContractRequest[], broker: ReturnType<typeof fakeBroker>, deps: OptionQuoteBatchDeps = {}) {
  return fetchOptionQuoteBatch(
    db,
    { underlyingSecurityId: underlyingId, contracts },
    { api: broker.api as unknown as IBApiNext, now: clock, isSyncing: () => false, ...deps },
  );
}

const tick = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeEach(() => {
  t = T0;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  mockedGetIbApi.mockReset();
  mockedGetIbApi.mockReturnValue({} as unknown as IBApiNext);
  resetOptionQuoteLimiter();
  underlyingId = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency, ib_con_id) VALUES ('ZZA', 'ZZA Corp', 'Stock', 'USD', ?)")
    .run(UNDERLYING_CON_ID).lastInsertRowid as number;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.mocked(console.warn).mockRestore();
  vi.useRealTimers();
});

describe("fetchOptionQuoteBatch", () => {
  it("quotes each contract with both arrival times and the underlying's own price", async () => {
    expect(OPTION_QUOTE_BATCH_DEADLINE_MS).toBe(120_000);
    const cs = [contract(1), contract(2)];
    const broker = fakeBroker({ contracts: cs, option: () => ({ ticks: [[1, 1.2], [2, 1.3], [4, 1.25]], advanceMs: 1_000 }) });
    const r = await run(cs, broker);
    expect(r).toEqual({
      ok: true,
      contracts: [
        {
          conId: 9001,
          ok: true,
          bid: 1.2,
          ask: 1.3,
          mid: 1.25,
          last: 1.25,
          tickKind: "live",
          optionObservedAt: new Date(T0 + 1_000).toISOString(),
          underlyingObservedAt: new Date(T0).toISOString(),
          underlyingPrice: 50,
        },
        expect.objectContaining({ conId: 9002, ok: true, optionObservedAt: new Date(T0 + 2_000).toISOString() }),
      ],
    });
    // Looked up by contract id, with secType, exchange and currency.
    expect(broker.api.getContractDetails).toHaveBeenNthCalledWith(1, { conId: 9001, secType: SecType.OPT, exchange: "SMART", currency: "USD" });
    for (const c of broker.api.getMarketData.mock.calls) expect(c.slice(1)).toEqual(["", true, false]);
    expect(broker.api.getHistoricalData).not.toHaveBeenCalled();
  });

  it("refusals before sending: not connected, no contract id, a sync running → zero broker calls (spies)", async () => {
    const cs = [contract(1)];
    const broker = fakeBroker({ contracts: cs });
    mockedGetIbApi.mockReturnValue(null);
    expect(await fetchOptionQuoteBatch(db, { underlyingSecurityId: underlyingId, contracts: cs })).toEqual({ ok: false, reason: "not-connected" });
    expect(await run(cs, broker, { api: null })).toEqual({ ok: false, reason: "not-connected" });
    mockedGetIbApi.mockReturnValue({} as unknown as IBApiNext);

    expect(await run(cs, broker, { isSyncing: () => true })).toEqual({ ok: false, reason: "sync-running" });

    expect(await fetchOptionQuoteBatch(db, { underlyingSecurityId: 99999, contracts: cs }, { api: broker.api as unknown as IBApiNext })).toEqual({
      ok: false,
      reason: "no-underlying-contract",
    });
    db.prepare("UPDATE securities SET ib_con_id = NULL WHERE id = ?").run(underlyingId);
    expect(await run(cs, broker)).toEqual({ ok: false, reason: "no-underlying-contract" });

    expect(broker.api.getContractDetails).not.toHaveBeenCalled();
    expect(broker.api.getMarketData).not.toHaveBeenCalled();
    expect(broker.api.setMarketDataType).not.toHaveBeenCalled();
    // None of these refusals used a limiter slot.
    expect(reserveOptionQuoteSlots(30, T0)).toEqual({ granted: 30, retryAfterSeconds: null });
  });

  it("T15 no free slot: whole pull refused with retryAfterSeconds, zero calls; 30 - 25 = 5 free of 8 asked: 5 quoted, 3 not-quoted-rate-limit, no request for them", async () => {
    const cs = Array.from({ length: 8 }, (_, i) => contract(i + 1));
    const full = fakeBroker({ contracts: cs });
    for (let i = 0; i < 30; i++) takeOptionQuoteSlot(T0 - 20_000);
    expect(await run(cs, full)).toEqual({ ok: false, reason: "rate-limit", retryAfterSeconds: 40 });
    expect(full.api.getContractDetails).not.toHaveBeenCalled();
    expect(full.api.getMarketData).not.toHaveBeenCalled();
    expect(full.api.setMarketDataType).not.toHaveBeenCalled();

    resetOptionQuoteLimiter();
    for (let i = 0; i < 25; i++) takeOptionQuoteSlot(T0 - 10_000);
    const broker = fakeBroker({ contracts: cs });
    const r = await run(cs, broker);
    if (!r.ok) throw new Error("expected rows");
    expect(r.contracts.map((c) => c.ok)).toEqual([true, true, true, true, true, false, false, false]);
    for (const row of r.contracts.slice(5)) {
      expect(row).toEqual({ conId: row.conId, ok: false, reason: "not-quoted-rate-limit", retryAfterSeconds: 50, bid: null, ask: null, last: null });
    }
    expect(broker.api.getContractDetails).toHaveBeenCalledTimes(5);
    for (const c of cs.slice(5)) expect(broker.optionSnapshotsFor(c.conId)).toBe(0);
  });

  it("T24 a description differing in symbol, right, expiry, strike, multiplier or trading class, or matching twice → not-standard-contract, no price", async () => {
    const variants: Record<string, unknown>[] = [
      { symbol: "ZZB" },
      { right: "C" },
      { lastTradeDateOrContractMonth: "20270122" },
      { strike: 41.5 },
      { multiplier: "50" },
      { tradingClass: "ZZA1" },
    ];
    const cs = variants.map((_, i) => contract(i + 1));
    const doubled = contract(7);
    const otherId = contract(8);
    const tcMismatch = contract(9, { tradingClass: "ZZA2" });
    const all = [...cs, doubled, otherId, tcMismatch];
    const broker = fakeBroker({
      contracts: all,
      details: (conId) => {
        const i = cs.findIndex((c) => c.conId === conId);
        if (i >= 0) return [description(cs[i], variants[i])];
        if (conId === doubled.conId) return [description(doubled), description(doubled)];
        if (conId === otherId.conId) return [description(otherId, { conId: 1 })];
        if (conId === tcMismatch.conId) return [description(tcMismatch, { tradingClass: "ZZA2" })];
        return [];
      },
    });
    const r = await run(all, broker);
    if (!r.ok) throw new Error("expected rows");
    for (const row of r.contracts) {
      expect(row).toEqual({ conId: row.conId, ok: false, reason: "not-standard-contract", bid: null, ask: null, last: null });
    }
    expect(broker.optionSnapshotCount()).toBe(0);

    // The broker's "no security definition" for a contract id is not a standard contract either.
    const gone = fakeBroker({
      contracts: [contract(1)],
      details: () => new IBApiNextError(new Error("No security definition"), 200 as ErrorCode, 7),
    });
    const r2 = await run([contract(1)], gone);
    expect(r2).toMatchObject({ ok: true, contracts: [{ ok: false, reason: "not-standard-contract" }] });

    // A call, and a long-form right, are matched by the right asked.
    const call = contract(1, { right: "call" });
    const callBroker = fakeBroker({ contracts: [call], details: () => [description(call, { right: "CALL" })] });
    expect(await run([call], callBroker)).toMatchObject({ ok: true, contracts: [{ ok: true }] });
  });

  it("one type setting per batch, restored once; contracts requested one after another (never two open subscriptions)", async () => {
    const cs = Array.from({ length: 4 }, (_, i) => contract(i + 1));
    const broker = fakeBroker({ contracts: cs });
    const r = await run(cs, broker);
    expect(r.ok && r.contracts.every((c) => c.ok)).toBe(true);
    expect(broker.api.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN], [MarketDataType.REALTIME]]);
    expect(broker.maxOpen).toBe(1);
    expect(broker.open).toBe(0);
    expect(broker.underlyingCalls).toBe(1);
  });

  it("T27 with a fake clock, a contract whose quote would land more than 30 s after the underlying gets a fresh underlying snapshot first", async () => {
    const cs = [contract(1), contract(2)];
    const broker = fakeBroker({
      contracts: cs,
      // The second lookup takes 20 s: 30 - 11 = 19 s is the most an underlying may age before a contract starts.
      details: (conId) => () => {
        if (conId === 9002) t += 20_000;
        return Promise.resolve([description(cs.find((c) => c.conId === conId)!)]);
      },
      underlying: (n) => ({ ticks: [[4, n === 1 ? 50 : 51]] }),
    });
    const r = await run(cs, broker);
    if (!r.ok) throw new Error("expected rows");
    expect(broker.underlyingCalls).toBe(2);
    expect(r.contracts[0]).toMatchObject({ ok: true, underlyingPrice: 50, underlyingObservedAt: new Date(T0).toISOString() });
    expect(r.contracts[1]).toMatchObject({ ok: true, underlyingPrice: 51, underlyingObservedAt: new Date(T0 + 20_000).toISOString() });

    // An underlying 19 s old is still fresh enough to start a contract.
    t = T0;
    const fresh = fakeBroker({
      contracts: cs,
      details: (conId) => () => {
        if (conId === 9002) t += 19_000;
        return Promise.resolve([description(cs.find((c) => c.conId === conId)!)]);
      },
    });
    await run(cs, fresh);
    expect(fresh.underlyingCalls).toBe(1);
  });

  it("F5 a gap still over 30 s after the fresh snapshot: not-quoted-prices-too-far-apart, no bid/ask filled; an underlying with no last: not-quoted-no-underlying-price", async () => {
    const cs = [contract(1)];
    const slow = fakeBroker({
      contracts: cs,
      option: () => ({ ticks: [[1, 1.2], [2, 1.3]], advanceMs: 31_000 }),
      underlying: (n) => ({ ticks: [[4, 50]], advanceMs: n === 1 ? 0 : 31_000 }),
    });
    const r = await run(cs, slow);
    expect(r).toEqual({
      ok: true,
      contracts: [{ conId: 9001, ok: false, reason: "not-quoted-prices-too-far-apart", bid: null, ask: null, last: null }],
    });
    expect(slow.underlyingCalls).toBe(2);

    // The extra underlying read lands close to the option: the row stands, with the NEW underlying.
    t = T0;
    const healed = fakeBroker({
      contracts: cs,
      option: () => ({ ticks: [[1, 1.2], [2, 1.3]], advanceMs: 31_000 }),
      underlying: (n) => ({ ticks: [[4, n === 1 ? 50 : 52]], advanceMs: n === 1 ? 0 : 2_000 }),
    });
    expect(await run(cs, healed)).toMatchObject({
      ok: true,
      contracts: [{ ok: true, underlyingPrice: 52, underlyingObservedAt: new Date(T0 + 33_000).toISOString() }],
    });

    t = T0;
    const two = [contract(1), contract(2)];
    const noLast = fakeBroker({ contracts: two, underlying: () => ({ ticks: [[1, 49.9], [4, -1]] }) });
    const r2 = await run(two, noLast);
    expect(r2).toEqual({
      ok: true,
      contracts: two.map((c) => ({ conId: c.conId, ok: false, reason: "not-quoted-no-underlying-price", bid: null, ask: null, last: null })),
    });
    expect(noLast.optionSnapshotCount()).toBe(0);
  });

  it("F7 lock-wait overrun: the deadline passes while waiting for the lock → every row timed out, zero broker calls, type never set", async () => {
    const cs = [contract(1), contract(2)];
    const broker = fakeBroker({ contracts: cs });
    let release!: () => void;
    const holder = withOptionQuoteLock(() => new Promise<void>((r) => (release = r)));
    const pending = run(cs, broker, { deadlineMs: 5_000 });
    await tick();
    t += 6_000;
    release();
    await holder;
    const r = await pending;
    expect(r).toEqual({
      ok: true,
      contracts: cs.map((c) => ({ conId: c.conId, ok: false, reason: "not-quoted-timed-out", bid: null, ask: null, last: null })),
    });
    expect(broker.api.getContractDetails).not.toHaveBeenCalled();
    expect(broker.api.getMarketData).not.toHaveBeenCalled();
    expect(broker.api.setMarketDataType).not.toHaveBeenCalled();
  });

  it("F7 a sync starting during the lock wait → whole pull sync-running, zero broker calls", async () => {
    const cs = [contract(1)];
    const broker = fakeBroker({ contracts: cs });
    let syncing = false;
    let release!: () => void;
    const holder = withOptionQuoteLock(() => new Promise<void>((r) => (release = r)));
    const pending = run(cs, broker, { isSyncing: () => syncing });
    await tick();
    syncing = true;
    release();
    await holder;
    expect(await pending).toEqual({ ok: false, reason: "sync-running" });
    expect(broker.api.getContractDetails).not.toHaveBeenCalled();
    expect(broker.api.getMarketData).not.toHaveBeenCalled();
    expect(broker.api.setMarketDataType).not.toHaveBeenCalled();
  });

  it("F7 lookup overrun: the deadline passes during a contract-details call → its reply is awaited, no snapshot is sent for it, later rows timed out", async () => {
    const cs = [contract(1), contract(2), contract(3)];
    const broker = fakeBroker({
      contracts: cs,
      details: (conId) => () => {
        if (conId === 9002) t += 10_000;
        return Promise.resolve([description(cs.find((c) => c.conId === conId)!)]);
      },
    });
    const r = await run(cs, broker, { deadlineMs: 5_000 });
    if (!r.ok) throw new Error("expected rows");
    expect(r.contracts.map((c) => (c.ok ? "ok" : c.reason))).toEqual(["ok", "not-quoted-timed-out", "not-quoted-timed-out"]);
    expect(broker.api.getContractDetails).toHaveBeenCalledTimes(2);
    expect(broker.optionSnapshotsFor(9002)).toBe(0);
    expect(broker.optionSnapshotsFor(9003)).toBe(0);
    expect(broker.api.setMarketDataType.mock.calls.at(-1)).toEqual([MarketDataType.REALTIME]);
  });

  it("T25 a generation change during a contract's snapshot retries it once; a second change answers not-quoted-broker-busy", async () => {
    const other = { setMarketDataType: vi.fn() };
    const cs = [contract(1), contract(2)];
    const broker = fakeBroker({
      contracts: cs,
      option: (conId, n) => ({
        ticks: [[1, 1.2], [2, 1.3]],
        // 9001: moved once (the retry succeeds); 9002: moved on both attempts.
        onSubscribe: () => {
          if ((conId === 9001 && n === 1) || conId === 9002) setMarketDataTypeCounted(other, MarketDataType.REALTIME);
        },
      }),
    });
    const r = await run(cs, broker);
    if (!r.ok) throw new Error("expected rows");
    expect(r.contracts[0]).toMatchObject({ ok: true });
    expect(r.contracts[1]).toEqual({ conId: 9002, ok: false, reason: "not-quoted-broker-busy", bid: null, ask: null, last: null });
    expect(broker.optionSnapshotsFor(9001)).toBe(2);
    expect(broker.optionSnapshotsFor(9002)).toBe(2);
    expect(broker.api.setMarketDataType.mock.calls).toEqual([
      [MarketDataType.DELAYED_FROZEN],
      [MarketDataType.DELAYED_FROZEN],
      [MarketDataType.DELAYED_FROZEN],
      [MarketDataType.REALTIME],
    ]);
  });

  it("F7 retry overrun: the deadline passes before the one generation retry → the retry is not sent; the row is timed out", async () => {
    const other = { setMarketDataType: vi.fn() };
    const cs = [contract(1)];
    const broker = fakeBroker({
      contracts: cs,
      option: () => ({
        ticks: [[1, 1.2], [2, 1.3]],
        advanceMs: 6_000,
        onSubscribe: () => setMarketDataTypeCounted(other, MarketDataType.REALTIME),
      }),
    });
    const r = await run(cs, broker, { deadlineMs: 5_000 });
    expect(r).toEqual({ ok: true, contracts: [{ conId: 9001, ok: false, reason: "not-quoted-timed-out", bid: null, ask: null, last: null }] });
    expect(broker.optionSnapshotsFor(9001)).toBe(1);
    expect(broker.api.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN], [MarketDataType.REALTIME]]);
  });

  it("F7 a sync starting mid-batch: later rows not-quoted-sync-running, no request for them", async () => {
    let syncing = false;
    const cs = [contract(1), contract(2), contract(3)];
    const broker = fakeBroker({ contracts: cs, option: () => ({ ticks: [[1, 1.2], [2, 1.3]], onSubscribe: () => (syncing = true) }) });
    const r = await run(cs, broker, { isSyncing: () => syncing });
    if (!r.ok) throw new Error("expected rows");
    expect(r.contracts.map((c) => (c.ok ? "ok" : c.reason))).toEqual(["ok", "not-quoted-sync-running", "not-quoted-sync-running"]);
    expect(broker.api.getContractDetails).toHaveBeenCalledTimes(1);
    expect(broker.optionSnapshotCount()).toBe(1);
  });

  it("F9 one injected now(): every arrival time and the deadline read it", async () => {
    const cs = [contract(1), contract(2)];
    const now = vi.fn(clock);
    const broker = fakeBroker({ contracts: cs, option: () => ({ ticks: [[1, 1.2], [2, 1.3]], advanceMs: 7_000 }) });
    const r = await run(cs, broker, { now, deadlineMs: 10_000 });
    if (!r.ok) throw new Error("expected rows");
    // The first option arrives at +7 s (inside the deadline); the clock then reads +7 s > ... the second starts at +7 s and arrives at +14 s.
    expect(r.contracts[0]).toMatchObject({ ok: true, optionObservedAt: new Date(T0 + 7_000).toISOString(), underlyingObservedAt: new Date(T0).toISOString() });
    expect(r.contracts[1]).toMatchObject({ ok: true, optionObservedAt: new Date(T0 + 14_000).toISOString() });
    expect(now).toHaveBeenCalled();
    // With the deadline at +5 s, the second contract is never started.
    t = T0;
    const late = fakeBroker({ contracts: cs, option: () => ({ ticks: [[1, 1.2], [2, 1.3]], advanceMs: 7_000 }) });
    const r2 = await run(cs, late, { deadlineMs: 5_000 });
    if (!r2.ok) throw new Error("expected rows");
    expect(r2.contracts.map((c) => (c.ok ? "ok" : c.reason))).toEqual(["ok", "not-quoted-timed-out"]);
  });

  it("T28 a deadline passing while a snapshot is pending (controllable fake snapshot): the lock is held and REALTIME not restored until it settles; then restored once, lock released", async () => {
    const cs = [contract(1), contract(2)];
    const broker = fakeBroker({ contracts: cs, option: (conId) => (conId === 9001 ? { ticks: [[1, 1.2], [2, 1.3]], manual: true } : {}) });
    const pending = run(cs, broker, { deadlineMs: 5_000 });
    let waiterRan = false;
    const waiter = withOptionQuoteLock(async () => {
      waiterRan = true;
    });
    await tick(50);
    expect(broker.manual).toHaveLength(1);
    t += 6_000; // the deadline passes with the snapshot still pending
    await tick(50);
    expect(broker.api.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN]]);
    expect(waiterRan).toBe(false);
    broker.manual[0]();
    const r = await pending;
    await waiter;
    if (!r.ok) throw new Error("expected rows");
    expect(r.contracts.map((c) => (c.ok ? "ok" : c.reason))).toEqual(["ok", "not-quoted-timed-out"]);
    expect(broker.api.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN], [MarketDataType.REALTIME]]);
    expect(waiterRan).toBe(true);
  });

  it("T28 no broker operation starts after the deadline (no getContractDetails, no getMarketData); unreached rows read not-quoted-timed-out", async () => {
    const cs = [contract(1), contract(2)];
    const broker = fakeBroker({ contracts: cs, underlying: () => ({ ticks: [[4, 50]], advanceMs: 6_000 }) });
    const r = await run(cs, broker, { deadlineMs: 5_000 });
    expect(r).toEqual({
      ok: true,
      contracts: cs.map((c) => ({ conId: c.conId, ok: false, reason: "not-quoted-timed-out", bid: null, ask: null, last: null })),
    });
    expect(broker.api.getContractDetails).not.toHaveBeenCalled();
    expect(broker.api.getMarketData).toHaveBeenCalledTimes(1); // the underlying only, started before the deadline
    expect(broker.api.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN], [MarketDataType.REALTIME]]);
  });

  it("T28 a snapshot that never completes ends at the 13 s backstop, then the type is restored and the lock released", async () => {
    expect(OPTION_SNAPSHOT_BACKSTOP_MS).toBe(13_000);
    vi.useFakeTimers();
    const cs = [contract(1)];
    const broker = fakeBroker({ contracts: cs, option: () => ({ hang: true }) });
    let settled = false;
    const pending = run(cs, broker).then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(12_999);
    expect(settled).toBe(false);
    expect(broker.api.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true, contracts: [{ conId: 9001, ok: false, reason: "timeout", bid: null, ask: null, last: null }] });
    expect(broker.api.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN], [MarketDataType.REALTIME]]);
    expect(broker.open).toBe(0);
    await expect(withOptionQuoteLock(async () => "free")).resolves.toBe("free");
  });

  it("T28 a disconnect and a throw: the subscription is unsubscribed, the type restored only if still connected, the lock released in finally; unreached rows broker-disconnected", async () => {
    const cs = [contract(1), contract(2)];
    const dropped = fakeBroker({
      contracts: cs,
      option: () => ({
        error: new Error("connection lost"),
        onSubscribe: () => mockedGetIbApi.mockReturnValue(null),
      }),
    });
    const r = await run(cs, dropped);
    expect(r).toEqual({
      ok: true,
      contracts: cs.map((c) => ({ conId: c.conId, ok: false, reason: "broker-disconnected", bid: null, ask: null, last: null })),
    });
    expect(dropped.open).toBe(0);
    expect(dropped.unsubscribes).toHaveBeenCalled();
    expect(dropped.api.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN]]);
    await expect(withOptionQuoteLock(async () => "free")).resolves.toBe("free");

    // A throw while sending, still connected: that row is a broker error, the next row is quoted, the type restored.
    mockedGetIbApi.mockReturnValue({} as unknown as IBApiNext);
    const throwing = fakeBroker({ contracts: cs });
    const plain = throwing.api.getMarketData.getMockImplementation()!;
    throwing.api.getMarketData.mockImplementation((c: { secType?: string; conId?: number }) => {
      if (c.conId === 9001) throw new Error("socket write failed");
      return plain(c);
    });
    const r2 = await run(cs, throwing);
    if (!r2.ok) throw new Error("expected rows");
    expect(r2.contracts.map((c) => (c.ok ? "ok" : c.reason))).toEqual(["broker-error", "ok"]);
    expect(throwing.api.setMarketDataType.mock.calls.at(-1)).toEqual([MarketDataType.REALTIME]);

    // A throw while sending after the connection dropped: unreached rows broker-disconnected, type not restored.
    const gone = fakeBroker({ contracts: cs });
    const plainGone = gone.api.getMarketData.getMockImplementation()!;
    gone.api.getMarketData.mockImplementation((c: { secType?: string; conId?: number }) => {
      if (c.conId === 9001) {
        mockedGetIbApi.mockReturnValue(null);
        throw new Error("socket closed");
      }
      return plainGone(c);
    });
    const r3 = await run(cs, gone);
    if (!r3.ok) throw new Error("expected rows");
    expect(r3.contracts.map((c) => (c.ok ? "ok" : c.reason))).toEqual(["broker-disconnected", "broker-disconnected"]);
    expect(gone.api.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN]]);
    await expect(withOptionQuoteLock(async () => "free")).resolves.toBe("free");
  });

  it("no broker cancel is claimed: the fake's cancelMktData is never called for a snapshot", async () => {
    const cs = [contract(1), contract(2)];
    const broker = fakeBroker({ contracts: cs });
    await run(cs, broker);
    expect(broker.api.cancelMktData).not.toHaveBeenCalled();
  });

  it("bid 0.15, ask 0.15 locked: ok, mid 0.15; bid 0.12345 → off-tick-grid", async () => {
    const cs = [contract(1), contract(2), contract(3)];
    const broker = fakeBroker({
      contracts: cs,
      option: (conId) =>
        conId === 9001
          ? { ticks: [[1, 0.15], [2, 0.15]] }
          : conId === 9002
            ? { ticks: [[1, 0.12345], [2, 0.15]] }
            : { ticks: [[66, 0.05], [67, 0.1]] },
    });
    const r = await run(cs, broker);
    if (!r.ok) throw new Error("expected rows");
    expect(r.contracts[0]).toMatchObject({ ok: true, bid: 0.15, ask: 0.15, mid: 0.15, tickKind: "live" });
    expect(r.contracts[1]).toEqual({ conId: 9002, ok: false, reason: "off-tick-grid", bid: null, ask: null, last: null });
    // A half-tick mid stays on the 1/10,000 grid, never rounded coarser; delayed ticks label the row delayed.
    expect(r.contracts[2]).toMatchObject({ ok: true, mid: 0.075, tickKind: "delayed" });
  });

  it("one-sided and crossed option quotes fill nothing (the shared rule)", async () => {
    const cs = [contract(1), contract(2)];
    const broker = fakeBroker({
      contracts: cs,
      option: (conId) => (conId === 9001 ? { ticks: [[1, 1.2], [4, 1.1]] } : { ticks: [[1, 1.4], [2, 1.3]] }),
    });
    const r = await run(cs, broker);
    expect(r).toEqual({
      ok: true,
      contracts: [
        { conId: 9001, ok: false, reason: "no-two-sided-quote", bid: 1.2, ask: null, last: 1.1 },
        { conId: 9002, ok: false, reason: "no-two-sided-quote", bid: 1.4, ask: 1.3, last: null },
      ],
    });
  });

  it("reserveOptionQuoteSlots shares the 30-per-minute window with takeOptionQuoteSlot", () => {
    for (let i = 0; i < 25; i++) expect(takeOptionQuoteSlot(T0)).toEqual({ ok: true });
    expect(reserveOptionQuoteSlots(8, T0 + 1_000)).toEqual({ granted: 5, retryAfterSeconds: 59 });
    expect(takeOptionQuoteSlot(T0 + 1_000)).toEqual({ ok: false, retryAfterSeconds: 59 });
    expect(reserveOptionQuoteSlots(1, T0 + 1_000)).toEqual({ granted: 0, retryAfterSeconds: 59 });
    // Once the first 25 leave the window, 25 are free again.
    expect(reserveOptionQuoteSlots(3, T0 + 60_000)).toEqual({ granted: 3, retryAfterSeconds: null });
  });

  it("a malformed request (no contracts, or more than 15) is a programming error, before anything is sent", async () => {
    const broker = fakeBroker();
    await expect(run([], broker)).rejects.toThrow(RangeError);
    await expect(run(Array.from({ length: 16 }, (_, i) => contract(i)), broker)).rejects.toThrow(RangeError);
    expect(broker.api.getMarketData).not.toHaveBeenCalled();
  });
});

describe("S2 fix round 1: batch", () => {
  const allSlotsFree = () => expect(reserveOptionQuoteSlots(30, t)).toEqual({ granted: 30, retryAfterSeconds: null });

  it("D1 reads the expiry DAY: a suffixed broker expiry passes, a different day is still refused", async () => {
    const cs = [contract(1), contract(2)];
    const broker = fakeBroker({
      contracts: cs,
      details: (conId) =>
        conId === 9001
          ? [description(cs[0], { lastTradeDateOrContractMonth: "20270115 16:00 US/Eastern" })]
          : [description(cs[1], { lastTradeDateOrContractMonth: "20270122 16:00 US/Eastern" })],
    });
    const r = await run(cs, broker);
    if (!r.ok) throw new Error("expected rows");
    expect(r.contracts.map((c) => (c.ok ? "ok" : c.reason))).toEqual(["ok", "not-standard-contract"]);
  });

  it("a lock wait past OPTION_QUOTE_LOCK_WAIT_MS refuses the whole pull broker-busy: zero broker requests, no slot spent", async () => {
    expect(OPTION_QUOTE_LOCK_WAIT_MS).toBe(20_000);
    vi.useFakeTimers();
    const cs = [contract(1)];
    const broker = fakeBroker({ contracts: cs });
    let release!: () => void;
    const holder = withOptionQuoteLock(() => new Promise<void>((r) => (release = r)));
    const pending = run(cs, broker);
    await vi.advanceTimersByTimeAsync(OPTION_QUOTE_LOCK_WAIT_MS);
    expect(await pending).toEqual({ ok: false, reason: "broker-busy" });
    expect(broker.api.getContractDetails).not.toHaveBeenCalled();
    expect(broker.api.getMarketData).not.toHaveBeenCalled();
    expect(broker.api.setMarketDataType).not.toHaveBeenCalled();
    release();
    await holder;
    allSlotsFree();
  });

  it("slots are reserved only after the lock and the sync and deadline checks: those refusals spend none", async () => {
    const cs = [contract(1), contract(2)];
    // A sync before the lock.
    await run(cs, fakeBroker({ contracts: cs }), { isSyncing: () => true });
    allSlotsFree();
    resetOptionQuoteLimiter();

    // A sync that started during the lock wait.
    let syncing = false;
    let release!: () => void;
    let holder = withOptionQuoteLock(() => new Promise<void>((r) => (release = r)));
    let pending = run(cs, fakeBroker({ contracts: cs }), { isSyncing: () => syncing });
    await tick();
    syncing = true;
    release();
    await holder;
    expect(await pending).toEqual({ ok: false, reason: "sync-running" });
    allSlotsFree();
    resetOptionQuoteLimiter();

    // The deadline passed during the lock wait.
    holder = withOptionQuoteLock(() => new Promise<void>((r) => (release = r)));
    pending = run(cs, fakeBroker({ contracts: cs }), { deadlineMs: 1_000 });
    await tick();
    t += 2_000;
    release();
    await holder;
    expect(await pending).toMatchObject({ ok: true, contracts: [{ reason: "not-quoted-timed-out" }, { reason: "not-quoted-timed-out" }] });
    allSlotsFree();
    resetOptionQuoteLimiter();

    // A pull that goes ahead spends one slot per contract.
    await run(cs, fakeBroker({ contracts: cs }));
    expect(reserveOptionQuoteSlots(30, t)).toEqual({ granted: 28, retryAfterSeconds: 60 });
  });

  it("D2 covers the underlying read: a foreign type change during it re-reads it once; a second change makes the contracts broker busy", async () => {
    const other = { setMarketDataType: vi.fn() };
    const cs = [contract(1), contract(2)];
    const once = fakeBroker({
      contracts: cs,
      underlying: (n) => ({ ticks: [[4, n === 1 ? 50 : 51]], onSubscribe: () => n === 1 && setMarketDataTypeCounted(other, MarketDataType.REALTIME) }),
    });
    const r = await run(cs, once);
    expect(once.underlyingCalls).toBe(2);
    expect(r).toMatchObject({ ok: true, contracts: [{ ok: true, underlyingPrice: 51 }, { ok: true, underlyingPrice: 51 }] });
    expect(once.api.setMarketDataType.mock.calls).toEqual([
      [MarketDataType.DELAYED_FROZEN],
      [MarketDataType.DELAYED_FROZEN],
      [MarketDataType.REALTIME],
    ]);

    const always = fakeBroker({
      contracts: cs,
      underlying: () => ({ ticks: [[4, 50]], onSubscribe: () => setMarketDataTypeCounted(other, MarketDataType.REALTIME) }),
    });
    const r2 = await run(cs, always);
    expect(r2).toEqual({
      ok: true,
      contracts: cs.map((c) => ({ conId: c.conId, ok: false, reason: "not-quoted-broker-busy", bid: null, ask: null, last: null })),
    });
    expect(always.underlyingCalls).toBe(2);
    expect(always.optionSnapshotCount()).toBe(0);
    expect(always.api.setMarketDataType.mock.calls.at(-1)).toEqual([MarketDataType.REALTIME]);
  });
});

/**
 * The one-security daily-bar fetch (Gains at risk step 2, Task S2, ruling R9).
 *
 * Synthetic ZZ* securities and round figures only. A migrated in-memory
 * database and an injected bar fetcher; no TWS connection is ever made
 * (`@/lib/tws/client` is mocked).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { IBApiNext } from "@stoqey/ib";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(),
}));

import { getIbApi } from "@/lib/tws/client";
import {
  DAILY_BAR_ENSURE_FAILURE_COOLDOWN_MS,
  DAILY_BAR_ENSURE_MAX_FAILURES_PER_DAY,
  ensureDailyBarsForSecurity,
  runDailyBarCapture,
} from "@/lib/tws/daily-bar-capture";
import { storableDailyBars, type FetchOhlcvOptions, type FetchOhlcvResult, type fetchOhlcvBars } from "@/lib/tws/ohlcv";
import { getPricedDailyBarRange } from "@/lib/queries/ohlcv";
import { addDays } from "@/lib/calendar/date-utils";
import { isMarketClosed } from "@/lib/calendar/market-holidays";

const mockedGetIbApi = vi.mocked(getIbApi);
const TODAY = "2026-11-10"; // a Tuesday
const YESTERDAY = "2026-11-09";
const T0 = Date.parse("2026-11-10T15:00:00Z");
const API = {} as unknown as IBApiNext;

type G = {
  __tws_dailyBarLedger?: { day: string; succeeded: Set<number>; exhausted: Set<number>; failed: Set<number> };
  __tws_dailyBarLastBatchAt?: number;
  __tws_dailyBarRunning?: boolean;
};
const gl = globalThis as unknown as G;

let db: Database.Database;
let accountId: number;
let nextConId = 1000;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  accountId = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Test')").run().lastInsertRowid as number;
  delete gl.__tws_dailyBarLedger;
  delete gl.__tws_dailyBarLastBatchAt;
  delete gl.__tws_dailyBarRunning;
  delete (globalThis as unknown as { __tws_dailyBarEnsureFailures?: unknown }).__tws_dailyBarEnsureFailures;
  vi.clearAllMocks();
  mockedGetIbApi.mockReturnValue(API);
});

function security(symbol: string, opts: { type?: string; conId?: number | null; currency?: string } = {}): number {
  const conId = opts.conId === undefined ? nextConId++ : opts.conId;
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, ib_con_id, currency) VALUES (?, ?, ?, ?, ?)")
    .run(symbol, `${symbol} name`, opts.type ?? "Stock", conId, opts.currency ?? "USD").lastInsertRowid as number;
}

function hold(securityId: number): void {
  db.prepare("INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 10, ?)").run(
    accountId,
    securityId,
    YESTERDAY,
  );
}

function sessionsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isMarketClosed(d)) out.push(d);
  return out;
}

function fakeFetch(o: { fail?: boolean; gate?: Promise<void> } = {}) {
  const calls: FetchOhlcvOptions[] = [];
  const fn = vi.fn(async (_db: Database.Database, opts: FetchOhlcvOptions): Promise<FetchOhlcvResult> => {
    calls.push(opts);
    if (o.gate) await o.gate;
    if (o.fail) throw new Error("Timeout after 30s");
    const from = opts.durationStr === "2 Y" ? addDays(TODAY, -730) : addDays(TODAY, -Number(/^(\d+)/.exec(opts.durationStr ?? "365")![1]));
    let bars = sessionsBetween(from, TODAY).map((d) => ({ date: d, open: 100, high: 100, low: 100, close: 100, volume: 100 }));
    if (opts.maxBarDate) bars = storableDailyBars(bars, opts.maxBarDate);
    return { bars, barsInserted: 0, fromCache: false, symbol: "ZZ" };
  });
  return { fn: fn as unknown as typeof fetchOhlcvBars, calls };
}

function tableCounts(): Record<string, number> {
  const names = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  const out: Record<string, number> = {};
  for (const n of names) out[n] = (db.prepare(`SELECT COUNT(*) AS n FROM "${n}"`).get() as { n: number }).n;
  return out;
}

describe("ensureDailyBarsForSecurity", () => {
  it("fetches one security through the capture body and records success in the ledger", async () => {
    const id = security("ZZA"); // not held: a trial-only underlying
    const f = fakeFetch();
    const r = await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, fetch: f.fn });
    expect(r).toEqual({ ok: true, outcome: "succeeded" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ securityId: id, durationStr: "2 Y", incremental: false, store: false, maxBarDate: YESTERDAY });
    expect(getPricedDailyBarRange(db, id)?.latest).toBe(YESTERDAY);
    expect(gl.__tws_dailyBarLedger?.succeeded.has(id)).toBe(true);
    expect(gl.__tws_dailyBarRunning).toBe(false);

    // A following batch does not fetch it again today (held now, so it is a target).
    hold(id);
    const f2 = fakeFetch();
    const b = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f2.fn });
    expect(b.attempted).toBe(0);
    expect(b.doneToday).toBe(1);
    expect(f2.calls).toHaveLength(0);
  });

  it("answers exhausted for a short broker history and records it", async () => {
    const id = security("ZZA");
    const short = vi.fn(async (_d: Database.Database, o: FetchOhlcvOptions): Promise<FetchOhlcvResult> => ({
      bars: storableDailyBars(
        sessionsBetween("2026-06-01", TODAY).map((d) => ({ date: d, open: 100, high: 100, low: 100, close: 100, volume: 1 })),
        o.maxBarDate!,
      ),
      barsInserted: 0,
      fromCache: false,
      symbol: "ZZ",
    }));
    const r = await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, fetch: short as unknown as typeof fetchOhlcvBars });
    expect(r).toEqual({ ok: true, outcome: "exhausted" });
    expect(gl.__tws_dailyBarLedger?.exhausted.has(id)).toBe(true);
  });

  it("is not held to the 25-minute batch window and does not move it", async () => {
    hold(security("ZZB"));
    const f = fakeFetch();
    await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(gl.__tws_dailyBarLastBatchAt).toBe(T0);
    const id = security("ZZA");
    const r = await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, fetch: f.fn });
    expect(r).toEqual({ ok: true, outcome: "succeeded" });
    expect(gl.__tws_dailyBarLastBatchAt).toBe(T0);

    // With no batch ever run, it leaves the window unset.
    delete gl.__tws_dailyBarLastBatchAt;
    const id2 = security("ZZC");
    await ensureDailyBarsForSecurity(db, API, id2, { today: TODAY, fetch: f.fn });
    expect(gl.__tws_dailyBarLastBatchAt).toBeUndefined();
  });

  it("is refused while a batch is running; a batch started during it answers already-running", async () => {
    hold(security("ZZB"));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slow = fakeFetch({ gate });
    const batch = runDailyBarCapture(db, { today: TODAY, now: T0, fetch: slow.fn });
    const id = security("ZZA");
    const f = fakeFetch();
    expect(await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, fetch: f.fn })).toEqual({
      ok: false,
      reason: "batch-running",
    });
    expect(f.calls).toHaveLength(0);
    release();
    await batch;

    // The other way round: the one-security call holds the running flag.
    let release2!: () => void;
    const gate2 = new Promise<void>((res) => (release2 = res));
    const slow2 = fakeFetch({ gate: gate2 });
    const one = ensureDailyBarsForSecurity(db, API, id, { today: TODAY, fetch: slow2.fn });
    const during = await runDailyBarCapture(db, { today: TODAY, now: T0 + 26 * 60_000, ignoreBatchWindow: true, fetch: f.fn });
    expect(during.skippedReason).toBe("already-running");
    release2();
    expect(await one).toEqual({ ok: true, outcome: "succeeded" });
    expect(gl.__tws_dailyBarRunning).toBe(false);
  });

  it("refuses an ineligible row (a mutual fund), a row with no contract id, an unknown id, and no connection", async () => {
    const f = fakeFetch();
    const mf = security("ZZMF", { type: "Mutual Fund" });
    expect(await ensureDailyBarsForSecurity(db, API, mf, { today: TODAY, fetch: f.fn })).toEqual({
      ok: false,
      reason: "ineligible",
      ineligibleReason: "mutual-fund",
    });
    const opt = security("ZZA   261218C00100000", { type: "Option" });
    expect(await ensureDailyBarsForSecurity(db, API, opt, { today: TODAY, fetch: f.fn })).toEqual({
      ok: false,
      reason: "ineligible",
      ineligibleReason: "option",
    });
    const foreign = security("ZZK", { currency: "KRW" });
    expect(await ensureDailyBarsForSecurity(db, API, foreign, { today: TODAY, fetch: f.fn })).toEqual({
      ok: false,
      reason: "ineligible",
      ineligibleReason: "not-us-session",
    });
    const noCon = security("ZZN", { conId: null });
    expect(await ensureDailyBarsForSecurity(db, API, noCon, { today: TODAY, fetch: f.fn })).toEqual({
      ok: false,
      reason: "no-contract-id",
    });
    expect(await ensureDailyBarsForSecurity(db, API, 99_999, { today: TODAY, fetch: f.fn })).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(await ensureDailyBarsForSecurity(db, API, -1, { today: TODAY, fetch: f.fn })).toEqual({ ok: false, reason: "not-found" });
    const ok = security("ZZA");
    expect(await ensureDailyBarsForSecurity(db, null, ok, { today: TODAY, fetch: f.fn })).toEqual({
      ok: false,
      reason: "not-connected",
    });
    expect(f.calls).toHaveLength(0);
    expect(gl.__tws_dailyBarLedger?.failed.size ?? 0).toBe(0);
  });

  it("a failure is recorded and answered failed, never thrown", async () => {
    const id = security("ZZA");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeFetch({ fail: true });
    const r = await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, fetch: f.fn });
    expect(r).toEqual({ ok: false, reason: "failed" });
    expect(gl.__tws_dailyBarLedger?.failed.has(id)).toBe(true);
    expect(gl.__tws_dailyBarRunning).toBe(false);
    // Content-free log: a symbol and an error class, never the message.
    const lines = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(lines).toContain("ZZA");
    expect(lines).toContain("timeout");
    expect(lines).not.toContain("30s");
    warn.mockRestore();

    // The next batch skips it today.
    hold(id);
    const f2 = fakeFetch();
    const b = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f2.fn });
    expect(f2.calls).toHaveLength(0);
    expect(b.attempted).toBe(0);

    // A database error is answered too, never thrown.
    const broken = { prepare: () => { throw new Error("SQLITE_BUSY"); } } as unknown as Database.Database;
    const w2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await ensureDailyBarsForSecurity(broken, API, id, { today: TODAY, fetch: f2.fn })).toEqual({ ok: false, reason: "failed" });
    w2.mockRestore();
  });

  it("a disconnect during the request is answered not-connected and left unrecorded", async () => {
    const id = security("ZZA");
    const dropping = vi.fn(async () => {
      mockedGetIbApi.mockReturnValue(null);
      throw new Error("TWS not connected");
    });
    const r = await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, fetch: dropping as unknown as typeof fetchOhlcvBars });
    expect(r).toEqual({ ok: false, reason: "not-connected" });
    expect(gl.__tws_dailyBarLedger?.failed.has(id) ?? false).toBe(false);
  });

  it("already-today makes no request", async () => {
    const id = security("ZZA");
    const f = fakeFetch();
    expect(await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, fetch: f.fn })).toEqual({ ok: true, outcome: "succeeded" });
    expect(await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, fetch: f.fn })).toEqual({ ok: true, outcome: "already-today" });
    expect(f.calls).toHaveLength(1);
    // A batch's exhausted security too.
    const ex = security("ZZB");
    gl.__tws_dailyBarLedger!.exhausted.add(ex);
    expect(await ensureDailyBarsForSecurity(db, API, ex, { today: TODAY, fetch: f.fn })).toEqual({ ok: true, outcome: "already-today" });
    expect(f.calls).toHaveLength(1);
    // A new Eastern day fetches again.
    expect((await ensureDailyBarsForSecurity(db, API, id, { today: "2026-11-11", fetch: f.fn })).ok).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it("writes nothing outside ohlcv_bars", async () => {
    const id = security("ZZA");
    hold(security("ZZB"));
    const before = tableCounts();
    const r = await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, fetch: fakeFetch().fn });
    expect(r.ok).toBe(true);
    const after = tableCounts();
    expect(after.ohlcv_bars).toBeGreaterThan(before.ohlcv_bars);
    delete after.ohlcv_bars;
    delete before.ohlcv_bars;
    expect(after).toEqual(before);
  });
});

describe("fix round 1: retries of a failing name are bounded", () => {
  const MIN = 60_000;
  const reasonOf = (r: Awaited<ReturnType<typeof ensureDailyBarsForSecurity>>) => (r.ok ? null : r.reason);

  it("exports the two numbers", () => {
    expect(DAILY_BAR_ENSURE_FAILURE_COOLDOWN_MS).toBe(10 * MIN);
    expect(DAILY_BAR_ENSURE_MAX_FAILURES_PER_DAY).toBe(3);
  });

  it("ten calls on a failing name send one request, then refuse cooling-down with the seconds remaining", async () => {
    const id = security("ZZA");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeFetch({ fail: true });
    const answers = [];
    for (let i = 0; i < 10; i++) {
      answers.push(await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, now: T0 + i * 1000, fetch: f.fn }));
    }
    warn.mockRestore();
    expect(f.calls).toHaveLength(1);
    expect(answers[0]).toEqual({ ok: false, reason: "failed" });
    expect(answers[1]).toEqual({ ok: false, reason: "cooling-down", retryAfterSeconds: 599 });
    expect(answers[9]).toEqual({ ok: false, reason: "cooling-down", retryAfterSeconds: 591 });
    expect(gl.__tws_dailyBarRunning).toBe(false);
  });

  it("a refusal writes nothing", async () => {
    const id = security("ZZA");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, now: T0, fetch: fakeFetch({ fail: true }).fn });
    warn.mockRestore();
    const before = tableCounts();
    const ok = fakeFetch();
    expect((await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, now: T0 + MIN, fetch: ok.fn })).ok).toBe(false);
    expect(ok.calls).toHaveLength(0);
    expect(tableCounts()).toEqual(before);
  });

  it("after the cooldown a second try is allowed; the third failure gives failed-today; a new Eastern day resets", async () => {
    const id = security("ZZA");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeFetch({ fail: true });
    const at = (m: number, today = TODAY) => ensureDailyBarsForSecurity(db, API, id, { today, now: T0 + m * MIN, fetch: f.fn });
    expect(await at(0)).toEqual({ ok: false, reason: "failed" });
    expect(reasonOf(await at(9))).toBe("cooling-down");
    expect(await at(10)).toEqual({ ok: false, reason: "failed" });
    expect(await at(20)).toEqual({ ok: false, reason: "failed" });
    expect(f.calls).toHaveLength(3);
    expect(await at(31)).toEqual({ ok: false, reason: "failed-today" });
    expect(await at(300)).toEqual({ ok: false, reason: "failed-today" });
    expect(f.calls).toHaveLength(3);
    // The next Eastern day: allowed again.
    const ok = fakeFetch();
    expect(
      await ensureDailyBarsForSecurity(db, API, id, { today: "2026-11-11", now: T0 + 24 * 60 * MIN, fetch: ok.fn }),
    ).toEqual({ ok: true, outcome: "succeeded" });
    expect(ok.calls).toHaveLength(1);
    warn.mockRestore();
  });

  it("a success clears the name's failure state", async () => {
    const id = security("ZZA");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const at = (m: number, fail: boolean, today = TODAY) =>
      ensureDailyBarsForSecurity(db, API, id, { today, now: T0 + m * MIN, fetch: fakeFetch({ fail }).fn });
    expect(reasonOf(await at(0, true))).toBe("failed");
    expect(reasonOf(await at(10, true))).toBe("failed");
    expect(await at(20, false)).toEqual({ ok: true, outcome: "succeeded" });
    // Bars are stale again the next day; two more failures do not reach the day's limit,
    // because the earlier two were cleared (and the day changed).
    expect(reasonOf(await at(24 * 60, true, "2026-11-11"))).toBe("failed");
    expect(reasonOf(await at(24 * 60 + 10, true, "2026-11-11"))).toBe("failed");
    expect(reasonOf(await at(24 * 60 + 20, true, "2026-11-11"))).toBe("failed");
    expect(reasonOf(await at(24 * 60 + 30, true, "2026-11-11"))).toBe("failed-today");
    warn.mockRestore();
  });

  it("a success the same day clears the count", async () => {
    const id = security("ZZA");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const at = (m: number, fail: boolean) =>
      ensureDailyBarsForSecurity(db, API, id, { today: TODAY, now: T0 + m * MIN, fetch: fakeFetch({ fail }).fn });
    await at(0, true);
    await at(10, true);
    expect(await at(20, false)).toEqual({ ok: true, outcome: "succeeded" });
    const state = (globalThis as unknown as { __tws_dailyBarEnsureFailures?: { byId: Map<number, unknown> } })
      .__tws_dailyBarEnsureFailures;
    expect(state?.byId.has(id) ?? false).toBe(false);
    warn.mockRestore();
  });

  it("a disconnect is not a failure and starts no cooldown", async () => {
    const id = security("ZZA");
    const dropping = vi.fn(async () => {
      mockedGetIbApi.mockReturnValue(null);
      throw new Error("TWS not connected");
    });
    expect(
      await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, now: T0, fetch: dropping as unknown as typeof fetchOhlcvBars }),
    ).toEqual({ ok: false, reason: "not-connected" });
    mockedGetIbApi.mockReturnValue(API);
    expect(await ensureDailyBarsForSecurity(db, API, id, { today: TODAY, now: T0 + 1000, fetch: fakeFetch().fn })).toEqual({
      ok: true,
      outcome: "succeeded",
    });
  });
});


/**
 * Daily-bar capture (Gains at risk addendum, Task A4; rulings B5, C1-C4, C8, C9).
 *
 * Synthetic ZZ* securities and round figures only. Every test runs against a
 * migrated in-memory database and an injected bar fetcher; no TWS connection
 * is ever made (`@/lib/tws/client` is mocked).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(),
}));

import { getIbApi } from "@/lib/tws/client";
import {
  dailyBarCaptureEligibility,
  type DailyBarEligibilityRow,
  DAILY_BAR_BATCH_MIN_INTERVAL_MS,
  DAILY_BAR_CAPTURE_MAX_PER_BATCH,
  listDailyBarTargets,
  runDailyBarCapture,
} from "@/lib/tws/daily-bar-capture";
import { fetchOhlcvBars, storableDailyBars, type FetchOhlcvOptions, type FetchOhlcvResult } from "@/lib/tws/ohlcv";
import { getPricedDailyBarRange, getPricedDailyCloses, getOhlcvBars } from "@/lib/queries/ohlcv";
import { replaceDailyBarsInWindow, upsertOhlcvBars } from "@/lib/mutations/ohlcv";
import { GAINS_AT_RISK_DRIVERS } from "@/lib/analysis/gains-at-risk-input";
import { isUsSessionSecurity } from "@/lib/compute/security-regression";
import { addDays } from "@/lib/calendar/date-utils";
import { isMarketClosed } from "@/lib/calendar/market-holidays";
import { anchorIndex } from "../helpers/source-anchor";
import type { Bar } from "@stoqey/ib";

const mockedGetIbApi = vi.mocked(getIbApi);
const TODAY = "2026-11-10"; // a Tuesday
const YESTERDAY = "2026-11-09"; // the previous trading day
const T0 = Date.parse("2026-11-10T15:00:00Z");

let db: Database.Database;
let accountId: number;
let nextConId = 1000;

type G = {
  __tws_dailyBarLedger?: unknown;
  __tws_dailyBarLastBatchAt?: number;
  __tws_dailyBarRunning?: boolean;
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  accountId = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Test')").run().lastInsertRowid as number;
  const g = globalThis as unknown as G;
  delete g.__tws_dailyBarLedger;
  delete g.__tws_dailyBarLastBatchAt;
  delete g.__tws_dailyBarRunning;
  vi.clearAllMocks();
  mockedGetIbApi.mockReturnValue({} as unknown as ReturnType<typeof getIbApi>);
});

function security(
  symbol: string,
  opts: { type?: string; conId?: number | null; currency?: string; fundCategory?: string; underlying?: string; expiration?: string } = {},
): number {
  const conId = opts.conId === undefined ? nextConId++ : opts.conId;
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, ib_con_id, currency, fund_category, underlying_symbol,
                               strike_price, expiration_date, option_type, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      symbol,
      `${symbol} name`,
      opts.type ?? "Stock",
      conId,
      opts.currency ?? "USD",
      opts.fundCategory ?? null,
      opts.underlying ?? null,
      opts.underlying ? 100 : null,
      opts.expiration ?? null,
      opts.underlying ? "CALL" : null,
      opts.underlying ? 100 : null,
    ).lastInsertRowid as number;
}

function hold(securityId: number, qty = 10, asOf = YESTERDAY): void {
  db.prepare("INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, ?)").run(
    accountId,
    securityId,
    qty,
    asOf,
  );
}

function sessionsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isMarketClosed(d)) out.push(d);
  return out;
}

function bar(date: string, close: number) {
  return { date, open: close, high: close, low: close, close, volume: 100 };
}

function storeBars(id: number, dates: string[], close: (d: string) => number): void {
  upsertOhlcvBars(db, id, "1 day", dates.map((d) => bar(d, close(d))));
}

function startOfDuration(durationStr: string, today = TODAY): string {
  if (durationStr === "2 Y") return addDays(today, -730);
  const m = /^(\d+) D$/.exec(durationStr);
  if (!m) throw new Error(`unexpected duration ${durationStr}`);
  return addDays(today, -Number(m[1]));
}

interface FakeOpts {
  /** Close the broker reports for a security on a date (today's is a partial). */
  close?: (id: number, date: string) => number;
  /** First date the broker has history for, per security. */
  historyStart?: (id: number) => string;
  fail?: (id: number) => boolean;
  today?: string;
}

/** A fake of fetchOhlcvBars that honours durationStr and maxBarDate, and returns today's partial bar when not told otherwise. */
function fakeFetch(o: FakeOpts = {}) {
  const today = o.today ?? TODAY;
  const calls: FetchOhlcvOptions[] = [];
  const fn = vi.fn(async (_db: Database.Database, opts: FetchOhlcvOptions): Promise<FetchOhlcvResult> => {
    calls.push(opts);
    if (o.fail?.(opts.securityId)) throw new Error("Timeout after 30s");
    let from = startOfDuration(opts.durationStr ?? "1 Y", today);
    const hs = o.historyStart?.(opts.securityId);
    if (hs && hs > from) from = hs;
    const close = o.close ?? (() => 100);
    let bars = sessionsBetween(from, today).map((d) => bar(d, close(opts.securityId, d)));
    if (opts.maxBarDate) bars = storableDailyBars(bars, opts.maxBarDate);
    return { bars, barsInserted: 0, fromCache: false, symbol: "ZZ" };
  });
  return { fn: fn as unknown as typeof fetchOhlcvBars, calls, mock: fn };
}

const FULL_HISTORY = sessionsBetween(addDays(TODAY, -729), YESTERDAY);

describe("listDailyBarTargets", () => {
  it("targets held identities, option underlyings, the drivers and seeded tracked indexes; never options, bonds, cash or non-USD", () => {
    const stock = security("ZZA");
    hold(stock);
    const fund = security("ZZF", { type: "ETF" });
    hold(fund, -5); // a short still counts
    const under = security("ZZU"); // held only through an option
    const opt = security("ZZU   261218C00100000", { type: "Option", underlying: "ZZU", expiration: "2026-12-18" });
    hold(opt, 1);
    const bond = security("ZZB", { type: "Bond" });
    hold(bond);
    const cash = security("ZZM", { type: "Mutual Fund", fundCategory: "Cash Equivalent" });
    hold(cash);
    const foreign = security("ZZK", { currency: "KRW" });
    hold(foreign);
    const noCon = security("ZZN", { conId: null });
    hold(noCon);
    const flat = security("ZZZ");
    hold(flat, 0);
    const notHeld = security("ZZX");
    const driver = security(GAINS_AT_RISK_DRIVERS[0], { type: "ETF" }); // held or not
    const driverNoCon = security(GAINS_AT_RISK_DRIVERS[1], { type: "ETF", conId: null }); // no contract id: not a target
    const tracked = security("ZZT", { type: "ETF" });

    const r = listDailyBarTargets(db, TODAY, { trackedIndexSeeds: { ZZL: "zzt" } });
    expect([...r.targets].sort((a, b) => a - b)).toEqual([stock, fund, under, driver, tracked].sort((a, b) => a - b));
    expect(r.targets).not.toContain(opt);
    expect(r.targets).not.toContain(bond);
    expect(r.targets).not.toContain(cash);
    expect(r.targets).not.toContain(flat);
    expect(r.targets).not.toContain(notHeld);
    expect(r.targets).not.toContain(driverNoCon);
    expect(r.foreignSession).toBe(1);
    expect(r.noContractId).toBe(1);
  });

  it("orders no priced bars first, then the oldest priced latest bar; a corrupt row never counts", () => {
    const fresh = security("ZZA");
    const stale = security("ZZB");
    const none = security("ZZC");
    const corrupt = security("ZZD");
    for (const id of [fresh, stale, none, corrupt]) hold(id);
    storeBars(fresh, ["2026-11-05", "2026-11-06"], () => 100);
    storeBars(stale, ["2026-10-01", "2026-10-02"], () => 100);
    // Only a zero-close row: no priced bar at all.
    db.prepare(
      "INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close) VALUES (?, '2026-11-09', '1 day', 0, 0, 0, 0)",
    ).run(corrupt);
    const r = listDailyBarTargets(db, TODAY);
    expect(r.targets).toEqual([none, corrupt, stale, fresh]);
  });
});

describe("OHLCV readers and the window replace", () => {
  it("getPricedDailyBarRange and getPricedDailyCloses skip corrupt rows and other bar sizes", () => {
    const id = security("ZZA");
    storeBars(id, ["2026-11-02", "2026-11-03"], () => 100);
    db.prepare(
      "INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close) VALUES (?, '2026-11-09', '1 day', 10, 10, 0, 0)",
    ).run(id);
    upsertOhlcvBars(db, id, "5 mins", [bar("2026-11-06 10:00:00", 100)]);
    expect(getPricedDailyBarRange(db, id)).toEqual({ earliest: "2026-11-02", latest: "2026-11-03" });
    expect([...getPricedDailyCloses(db, id, "2026-11-03").entries()]).toEqual([["2026-11-03", 100]]);
    expect(getPricedDailyBarRange(db, security("ZZB"))).toBeNull();
  });

  it("replaceDailyBarsInWindow deletes the window's daily rows and writes through the bad-bar guard, in one transaction", () => {
    const id = security("ZZA");
    storeBars(id, ["2026-10-01", "2026-11-02", "2026-11-03"], () => 200);
    upsertOhlcvBars(db, id, "5 mins", [bar("2026-11-03 10:00:00", 200)]);
    const res = replaceDailyBarsInWindow(db, id, "2026-11-01", [bar("2026-11-02", 100), { ...bar("2026-11-04", 100), low: 0 }]);
    expect(res).toEqual({ inserted: 1, rejected: 1, olderDeleted: 0 });
    expect(getOhlcvBars(db, id, "1 day").map((b) => [b.date, b.close])).toEqual([
      ["2026-10-01", 200],
      ["2026-11-02", 100],
    ]);
    expect(getOhlcvBars(db, id, "5 mins")).toHaveLength(1);
  });

  it("replaceDailyBarsInWindow with no sane bar changes nothing", () => {
    const id = security("ZZA");
    storeBars(id, ["2026-11-02"], () => 200);
    expect(replaceDailyBarsInWindow(db, id, "2026-11-01", [])).toEqual({ inserted: 0, rejected: 0, olderDeleted: 0 });
    expect(replaceDailyBarsInWindow(db, id, "2026-11-01", [{ ...bar("2026-11-03", 1), close: 0 }])).toEqual({
      inserted: 0,
      rejected: 1,
      olderDeleted: 0,
    });
    expect(getOhlcvBars(db, id, "1 day").map((b) => b.close)).toEqual([200]);
  });
});

describe("runDailyBarCapture", () => {
  it("a mid-session bar stored yesterday by Charts is replaced by the true close on the next capture", async () => {
    const id = security("ZZA");
    hold(id);
    storeBars(id, FULL_HISTORY, (d) => (d === YESTERDAY ? 101.3 : 100));
    const f = fakeFetch({ close: () => 100 });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(r).toMatchObject({ attempted: 1, written: 1, basisChanges: 0, fullRefetches: 0, failed: 0 });
    expect(getPricedDailyCloses(db, id, YESTERDAY).get(YESTERDAY)).toBe(100);
    // The overlap request: 14 calendar days before the stored latest, through the previous trading day.
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ securityId: id, incremental: false, store: false, maxBarDate: YESTERDAY });
    expect(startOfDuration(f.calls[0].durationStr!) <= addDays(YESTERDAY, -14)).toBe(true);
    // Never a bar for today.
    expect(getPricedDailyBarRange(db, id)?.latest).toBe(YESTERDAY);
  });

  it("a corrupt latest row does not mark a security fresh", async () => {
    const id = security("ZZA");
    hold(id);
    const older = FULL_HISTORY.filter((d) => d <= "2026-11-02");
    storeBars(id, older, () => 100);
    db.prepare(
      "INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close) VALUES (?, ?, '1 day', 100, 100, 0, 0)",
    ).run(id, YESTERDAY);
    expect(listDailyBarTargets(db, TODAY).targets).toEqual([id]);
    const f = fakeFetch();
    await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(f.calls).toHaveLength(1);
    // The overlap is measured from the latest PRICED bar (2026-11-02), not the corrupt one.
    expect(startOfDuration(f.calls[0].durationStr!) <= addDays("2026-11-02", -14)).toBe(true);
    expect(getPricedDailyCloses(db, id, YESTERDAY).get(YESTERDAY)).toBe(100);
  });

  it("a split between two captures triggers one full refetch that replaces the window", async () => {
    const id = security("ZZA");
    hold(id);
    // Stored on the old basis (200), the broker now reports the 2:1 basis (100) for every date.
    storeBars(id, FULL_HISTORY, () => 200);
    const f = fakeFetch({ close: () => 100 });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(r).toMatchObject({ fullRefetches: 1, basisChanges: 1, written: 1, failed: 0 });
    expect(f.calls.map((c) => c.durationStr)).toEqual([expect.stringMatching(/ D$/), "2 Y"]);
    const closes = getPricedDailyCloses(db, id, addDays(TODAY, -730));
    expect(closes.size).toBe(FULL_HISTORY.length);
    expect([...closes.values()].every((c) => c === 100)).toBe(true);
    expect(closes.has(TODAY)).toBe(false);
  });

  it("the stored latest bar alone differing is not a basis change", async () => {
    const id = security("ZZA");
    hold(id);
    storeBars(id, FULL_HISTORY, (d) => (d === YESTERDAY ? 150 : 100));
    const f = fakeFetch({ close: () => 100 });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(r).toMatchObject({ basisChanges: 0, fullRefetches: 0, written: 1 });
    expect(f.calls).toHaveLength(1);
  });

  it("a difference within 0.5% is not a basis change; fewer than 5 compared sessions refetches in full but is not one", async () => {
    const within = security("ZZA");
    hold(within);
    storeBars(within, FULL_HISTORY, () => 100.4);
    const sparse = security("ZZB");
    hold(sparse);
    // Two years deep but only 3 stored sessions in the overlap before the latest.
    const sparseDates = [...FULL_HISTORY.filter((d) => d < "2026-10-20"), "2026-10-28", "2026-10-29", "2026-10-30", YESTERDAY];
    storeBars(sparse, sparseDates, () => 100);
    const f = fakeFetch({ close: () => 100 });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(r.basisChanges).toBe(0);
    expect(f.calls.filter((c) => c.securityId === within).map((c) => c.durationStr)).toEqual([expect.stringMatching(/ D$/)]);
    expect(f.calls.filter((c) => c.securityId === sparse).map((c) => c.durationStr)).toEqual([
      expect.stringMatching(/ D$/),
      "2 Y",
    ]);
  });

  it("no stored bars, or a history that starts too late, fetches the full two years", async () => {
    const empty = security("ZZA");
    hold(empty);
    const shallow = security("ZZB");
    hold(shallow);
    storeBars(shallow, sessionsBetween("2026-01-05", YESTERDAY), () => 100);
    const f = fakeFetch();
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(f.calls.map((c) => [c.securityId, c.durationStr, c.incremental, c.store])).toEqual([
      [empty, "2 Y", false, false],
      [shallow, "2 Y", false, false],
    ]);
    expect(r).toMatchObject({ attempted: 2, written: 2, fullRefetches: 2, basisChanges: 0 });
    expect(getPricedDailyBarRange(db, empty)).toEqual({ earliest: FULL_HISTORY[0], latest: YESTERDAY });
    expect(getPricedDailyBarRange(db, shallow)?.earliest).toBe(FULL_HISTORY[0]);
  });

  it("caps at 20 and runs at most one batch per 25 minutes", async () => {
    expect(DAILY_BAR_CAPTURE_MAX_PER_BATCH).toBe(20);
    expect(DAILY_BAR_BATCH_MIN_INTERVAL_MS).toBe(25 * 60 * 1000);
    for (let i = 0; i < 45; i++) hold(security(`ZZ${String(i).padStart(2, "0")}`));
    const f = fakeFetch();
    const r1 = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(r1.attempted).toBe(20);
    const r2 = await runDailyBarCapture(db, { today: TODAY, now: T0 + 10 * 60_000, fetch: f.fn });
    expect(r2.skippedReason).toBe("batch-window");
    expect(r2.attempted).toBe(0);
    const r3 = await runDailyBarCapture(db, { today: TODAY, now: T0 + 26 * 60_000, fetch: f.fn });
    expect(r3.attempted).toBe(20);
    expect(new Set(f.calls.map((c) => c.securityId)).size).toBe(40);
    expect(r3.doneToday).toBe(40);
  });

  it("fairness: 45 short-history targets are each fetched once per day across three batches", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 45; i++) {
      const id = security(`ZZ${String(i).padStart(2, "0")}`);
      hold(id);
      ids.push(id);
    }
    const f = fakeFetch({ historyStart: () => "2026-06-01" });
    const batches: number[][] = [];
    for (let b = 0; b < 4; b++) {
      const before = f.calls.length;
      const r = await runDailyBarCapture(db, { today: TODAY, now: T0 + b * 26 * 60_000, fetch: f.fn });
      batches.push(f.calls.slice(before).map((c) => c.securityId));
      if (b === 3) expect(r).toMatchObject({ attempted: 0, exhausted: 45 });
    }
    expect(batches.map((b) => b.length)).toEqual([20, 20, 5, 0]);
    expect(new Set(batches.flat()).size).toBe(45);
    // A new Eastern day resets the ledger.
    const next = await runDailyBarCapture(db, {
      today: "2026-11-11",
      now: T0 + 24 * 3_600_000,
      fetch: fakeFetch({ historyStart: () => "2026-06-01", today: "2026-11-11" }).fn,
    });
    expect(next.attempted).toBe(20);
  });

  it("passes maxBarDate = previous trading day; storableDailyBars drops today and closed days", async () => {
    const bars = [
      bar("2026-11-05", 1),
      bar("2026-11-06", 1),
      bar("2026-11-07", 1), // Saturday
      bar("2026-11-09", 1),
    ];
    expect(storableDailyBars(bars, "2026-11-06").map((b) => b.date)).toEqual(["2026-11-05", "2026-11-06"]);
    expect(storableDailyBars([bar("2026-11-26", 1), bar("2026-11-25", 1)], "2026-11-30").map((b) => b.date)).toEqual([
      "2026-11-25",
    ]); // Thanksgiving dropped

    // Monday's capture asks through the Friday before.
    const id = security("ZZA");
    hold(id);
    const f = fakeFetch({ today: "2026-11-09" });
    await runDailyBarCapture(db, { today: "2026-11-09", now: T0, fetch: f.fn });
    expect(f.calls[0].maxBarDate).toBe("2026-11-06");

    // Even a fetcher that ignores maxBarDate never gets a bar for today stored.
    const id2 = security("ZZB");
    hold(id2);
    const leaky = vi.fn(async (_db: Database.Database, o: FetchOhlcvOptions): Promise<FetchOhlcvResult> => ({
      bars: [bar("2026-11-06", 100), bar("2026-11-07", 100), bar(TODAY, 100)].map((b) => ({ ...b })),
      barsInserted: 0,
      fromCache: false,
      symbol: String(o.securityId),
    }));
    const g = globalThis as unknown as G;
    delete g.__tws_dailyBarLedger;
    await runDailyBarCapture(db, { today: TODAY, now: T0 + 26 * 60_000, fetch: leaky as unknown as typeof fetchOhlcvBars });
    const stored = db.prepare("SELECT bar_date FROM ohlcv_bars WHERE security_id = ? ORDER BY bar_date").all(id2) as {
      bar_date: string;
    }[];
    expect(stored.map((s) => s.bar_date)).toEqual(["2026-11-06"]);
  });

  it("the real fetcher with maxBarDate and store:false returns storable bars and writes nothing; absent options are unchanged", async () => {
    const id = security("ZZA");
    const raw: Bar[] = [
      { time: "20261106", open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: "20261109", open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: "20261110", open: 101, high: 101, low: 101, close: 101, volume: 1 },
    ];
    const api = { getHistoricalData: vi.fn().mockResolvedValue(raw) };
    mockedGetIbApi.mockReturnValue(api as unknown as ReturnType<typeof getIbApi>);

    const res = await fetchOhlcvBars(db, {
      securityId: id,
      durationStr: "30 D",
      incremental: false,
      store: false,
      maxBarDate: "2026-11-06",
    });
    expect(res.bars.map((b) => b.date)).toEqual(["2026-11-06"]);
    expect(res.barsInserted).toBe(0);
    expect(getOhlcvBars(db, id, "1 day")).toHaveLength(0);
    expect(api.getHistoricalData.mock.calls[0].slice(1)).toEqual(["", "30 D", "1 day", "TRADES", 1, 1]);

    // Charts path (no new options): stores every bar, today's included, and returns the cached set.
    const charts = await fetchOhlcvBars(db, { securityId: id, durationStr: "30 D", incremental: false });
    expect(charts.barsInserted).toBe(3);
    expect(charts.bars.map((b) => b.date)).toEqual(["2026-11-06", "2026-11-09", "2026-11-10"]);
  }, 10_000);

  it("a failure is counted, never thrown, and not retried that day", async () => {
    const bad = security("ZZA");
    hold(bad);
    const good = security("ZZB");
    hold(good);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeFetch({ fail: (id) => id === bad });
    const r1 = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(r1).toMatchObject({ attempted: 2, failed: 1, written: 1 });
    const r2 = await runDailyBarCapture(db, { today: TODAY, now: T0 + 26 * 60_000, fetch: f.fn });
    expect(r2).toMatchObject({ attempted: 0, failed: 0 });
    expect(f.calls.filter((c) => c.securityId === bad)).toHaveLength(1);
    // Content-free log: a symbol and an error class, never the message.
    const lines = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(lines).toContain("ZZA");
    expect(lines).not.toContain("30s");
    log.mockRestore();
  });

  it("not connected and already-running are no-ops", async () => {
    hold(security("ZZA"));
    const f = fakeFetch();
    mockedGetIbApi.mockReturnValue(null);
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(r.skippedReason).toBe("tws-not-connected");
    expect(f.calls).toHaveLength(0);

    mockedGetIbApi.mockReturnValue({} as unknown as ReturnType<typeof getIbApi>);
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slow = vi.fn(async (d: Database.Database, o: FetchOhlcvOptions) => {
      await gate;
      return f.fn(d, o);
    });
    const first = runDailyBarCapture(db, { today: TODAY, now: T0, fetch: slow as unknown as typeof fetchOhlcvBars });
    const second = await runDailyBarCapture(db, {
      today: TODAY,
      now: T0,
      ignoreBatchWindow: true,
      fetch: slow as unknown as typeof fetchOhlcvBars,
    });
    expect(second.skippedReason).toBe("already-running");
    release();
    expect((await first).attempted).toBe(1);
    // A not-connected run did not use up the batch window.
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("a disconnect mid-run stops the batch without counting failures", async () => {
    hold(security("ZZA"));
    hold(security("ZZB"));
    const f = fakeFetch();
    const dropping = vi.fn(async (d: Database.Database, o: FetchOhlcvOptions) => {
      const res = await f.fn(d, o);
      mockedGetIbApi.mockReturnValue(null);
      return res;
    });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: dropping as unknown as typeof fetchOhlcvBars });
    expect(r).toMatchObject({ attempted: 1, failed: 0 });
  });
});

describe("fix round 1: a short full reply never deletes good bars", () => {
  function dailyCount(id: number): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM ohlcv_bars WHERE security_id = ? AND bar_size = '1 day'").get(id) as { n: number }).n;
  }
  const LAST_21 = sessionsBetween(addDays(TODAY, -40), YESTERDAY).slice(-21);

  it("253 stored bars and a two-year reply of only the last 21 sessions: refused, failed, nothing changed", async () => {
    const id = security("ZZA");
    hold(id);
    const year = sessionsBetween(addDays(TODAY, -400), YESTERDAY).slice(-253);
    storeBars(id, year, () => 100);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeFetch({ historyStart: () => LAST_21[0] });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    warn.mockRestore();
    expect(r).toMatchObject({ failed: 1, written: 0, exhausted: 0, doneToday: 0 });
    expect(dailyCount(id)).toBe(253);
  });

  it("513 old-basis bars and a 21-bar reply after a basis change: refused, failed, nothing changed", async () => {
    const id = security("ZZA");
    hold(id);
    const stored = FULL_HISTORY.slice(-513);
    storeBars(id, [...FULL_HISTORY.slice(0, 3), ...stored], () => 200);
    const before = dailyCount(id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeFetch({
      close: () => 100,
      historyStart: () => LAST_21[0],
    });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    warn.mockRestore();
    expect(r).toMatchObject({ basisChanges: 1, failed: 1, written: 0, exhausted: 0, staleOlderBarsDeleted: 0 });
    expect(dailyCount(id)).toBe(before);
    expect([...getPricedDailyCloses(db, id, "2000-01-01").values()].every((c) => c === 200)).toBe(true);
  });

  it("a first fill of 21 bars is accepted and marks the security exhausted", async () => {
    const id = security("ZZA");
    hold(id);
    const f = fakeFetch({ historyStart: () => LAST_21[0] });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(r).toMatchObject({ failed: 0, written: 1, exhausted: 1 });
    expect(dailyCount(id)).toBe(21);
  });

  it("a legitimately longer reply replaces a short stored history", async () => {
    const id = security("ZZA");
    hold(id);
    storeBars(id, sessionsBetween("2026-06-01", YESTERDAY), () => 100);
    const f = fakeFetch();
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(r).toMatchObject({ failed: 0, written: 1, doneToday: 1, exhausted: 0, staleOlderBarsDeleted: 0 });
    expect(getPricedDailyBarRange(db, id)).toEqual({ earliest: FULL_HISTORY[0], latest: YESTERDAY });
  });
});

describe("fix round 1: bars older than the window after a basis change", () => {
  it("are deleted in the same transaction as the replace; intraday rows survive", async () => {
    const id = security("ZZA");
    hold(id);
    const older = sessionsBetween(addDays(TODAY, -900), addDays(TODAY, -731));
    storeBars(id, [...older, ...FULL_HISTORY], () => 200);
    upsertOhlcvBars(db, id, "5 mins", [bar(`${older[0]} 10:00:00`, 200), bar(`${YESTERDAY} 10:00:00`, 200)]);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const f = fakeFetch({ close: () => 100 });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    info.mockRestore();
    expect(r).toMatchObject({ basisChanges: 1, staleOlderBarsDeleted: older.length, written: 1 });
    expect(getPricedDailyBarRange(db, id)?.earliest).toBe(FULL_HISTORY[0]);
    expect(getOhlcvBars(db, id, "5 mins")).toHaveLength(2);
  });

  it("an ordinary full fetch with no basis change deletes nothing older", async () => {
    const id = security("ZZA");
    hold(id);
    const older = sessionsBetween(addDays(TODAY, -900), addDays(TODAY, -800));
    storeBars(id, [...older, ...sessionsBetween("2026-06-01", YESTERDAY)], () => 100);
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: fakeFetch().fn });
    expect(r.staleOlderBarsDeleted).toBe(0);
    expect(getPricedDailyBarRange(db, id)?.earliest).toBe(older[0]);
  });

  it("replaceDailyBarsInWindow deletes older daily rows only when asked", () => {
    const id = security("ZZA");
    storeBars(id, ["2024-01-02", "2026-11-02"], () => 200);
    upsertOhlcvBars(db, id, "5 mins", [bar("2024-01-02 10:00:00", 200)]);
    expect(replaceDailyBarsInWindow(db, id, "2026-11-01", [bar("2026-11-02", 100)])).toMatchObject({ olderDeleted: 0 });
    expect(
      replaceDailyBarsInWindow(db, id, "2026-11-01", [bar("2026-11-02", 100)], { deleteOlderDailyBars: true }),
    ).toMatchObject({ inserted: 1, olderDeleted: 1 });
    expect(getOhlcvBars(db, id, "1 day").map((b) => b.date)).toEqual(["2026-11-02"]);
    expect(getOhlcvBars(db, id, "5 mins")).toHaveLength(1);
  });
});

describe("fix round 1: targets, duplicate requests, disconnects, US session", () => {
  it("leaves out mutual funds and bond-fund ETFs, counted with a reason", () => {
    const mf = security("ZZMF", { type: "Mutual Fund" });
    hold(mf);
    const bf = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, ib_con_id, currency, fund_category, sector) VALUES ('ZZBF', 'ZZ Treasury Fund', 'ETF', 7777, 'USD', 'US Treasury', 'Fixed Income')",
      )
      .run().lastInsertRowid as number;
    hold(bf);
    const eq = security("ZZE", { type: "ETF" });
    hold(eq);
    const r = listDailyBarTargets(db, TODAY);
    expect(r.targets).toEqual([eq]);
    expect(r).toMatchObject({ mutualFund: 1, bondFund: 1 });
  });

  it("an overlap request that already covers the full window is not sent twice and is not a basis change", async () => {
    const id = security("ZZA");
    hold(id);
    // Two years deep, but nothing stored in the last year: the overlap request is already "2 Y".
    storeBars(id, sessionsBetween(addDays(TODAY, -729), addDays(TODAY, -400)), () => 100);
    const f = fakeFetch({ close: () => 100 });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(f.calls.map((c) => c.durationStr)).toEqual(["2 Y"]);
    expect(r).toMatchObject({ basisChanges: 0, written: 1, failed: 0 });
    expect(getPricedDailyBarRange(db, id)?.latest).toBe(YESTERDAY);
  });

  it("a stored latest older than the window is fetched once and stored as a fill", async () => {
    const id = security("ZZA");
    hold(id);
    storeBars(id, sessionsBetween(addDays(TODAY, -900), addDays(TODAY, -800)), () => 300);
    const f = fakeFetch({ close: () => 100 });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(f.calls.map((c) => c.durationStr)).toEqual(["2 Y"]);
    expect(r).toMatchObject({ basisChanges: 0, written: 1, failed: 0 });
  });

  it("a real basis change inside a two-year overlap reuses the reply", async () => {
    const id = security("ZZA");
    hold(id);
    storeBars(id, sessionsBetween(addDays(TODAY, -729), addDays(TODAY, -380)), () => 200);
    const f = fakeFetch({ close: () => 100 });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(f.calls.map((c) => c.durationStr)).toEqual(["2 Y"]);
    expect(r).toMatchObject({ basisChanges: 1, written: 1 });
    expect([...getPricedDailyCloses(db, id, addDays(TODAY, -730)).values()].every((c) => c === 100)).toBe(true);
  });

  it("a disconnect during a fetch leaves the in-flight security unrecorded, so it is retried", async () => {
    const id = security("ZZA");
    hold(id);
    const dropping = vi.fn(async () => {
      mockedGetIbApi.mockReturnValue(null);
      throw new Error("TWS not connected");
    });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: dropping as unknown as typeof fetchOhlcvBars });
    expect(r).toMatchObject({ failed: 0, written: 0 });
    mockedGetIbApi.mockReturnValue({} as unknown as ReturnType<typeof getIbApi>);
    const f = fakeFetch();
    const r2 = await runDailyBarCapture(db, { today: TODAY, now: T0 + 26 * 60_000, fetch: f.fn });
    expect(r2.attempted).toBe(1);
    expect(f.calls[0].securityId).toBe(id);
  });

  it("uses the shared US-session rule", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/tws/daily-bar-capture.ts"), "utf8");
    expect(src).toMatch(/import \{[^}]*isUsSessionSecurity[^}]*\} from "@\/lib\/compute\/security-regression"/);
    expect(src).not.toContain("function isUsdSession");
    expect(isUsSessionSecurity(" usd ")).toBe(true);
  });
});

describe("final review: older-bar delete only on a real mismatch", () => {
  const older = () => sessionsBetween(addDays(TODAY, -900), addDays(TODAY, -731));

  it("a real mismatch deletes older daily bars and counts a basis change", async () => {
    const id = security("ZZA");
    hold(id);
    storeBars(id, [...older(), ...FULL_HISTORY], () => 200);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: fakeFetch({ close: () => 100 }).fn });
    info.mockRestore();
    expect(r).toMatchObject({ basisChanges: 1, staleOlderBarsDeleted: older().length });
  });

  it("too few comparable sessions (a halt or a sparse name): full refetch and window replace, nothing older deleted, no basis change", async () => {
    const id = security("ZZA");
    hold(id);
    // Two years deep plus older bars, but a halt left only 3 sessions in the overlap before the latest.
    const halted = [...older(), ...FULL_HISTORY.filter((d) => d < "2026-10-20"), "2026-10-28", "2026-10-29", "2026-10-30", YESTERDAY];
    storeBars(id, halted, () => 100);
    upsertOhlcvBars(db, id, "5 mins", [bar(`${YESTERDAY} 10:00:00`, 100)]);
    const f = fakeFetch({ close: () => 100 });
    const r = await runDailyBarCapture(db, { today: TODAY, now: T0, fetch: f.fn });
    expect(f.calls.map((c) => c.durationStr)).toEqual([expect.stringMatching(/ D$/), "2 Y"]);
    expect(r).toMatchObject({ basisChanges: 0, staleOlderBarsDeleted: 0, fullRefetches: 1, written: 1, failed: 0 });
    expect(getPricedDailyBarRange(db, id)?.earliest).toBe(older()[0]);
    // The window was replaced: the halt's gap is filled.
    expect(getPricedDailyCloses(db, id, "2026-10-20").has("2026-10-21")).toBe(true);
    expect(getOhlcvBars(db, id, "5 mins")).toHaveLength(1);
  });
});

describe("dailyBarCaptureEligibility: the one pure rule", () => {
  const base: DailyBarEligibilityRow = {
    security_type: "Stock",
    fund_category: null,
    sector: null,
    name: "ZZ name",
    duration_years: null,
    currency: "USD",
    ib_con_id: 1,
  };
  it("answers each reason, in order", () => {
    expect(dailyBarCaptureEligibility(base)).toEqual({ eligible: true });
    expect(dailyBarCaptureEligibility({ ...base, security_type: "ETF", currency: null })).toEqual({ eligible: true });
    expect(dailyBarCaptureEligibility({ ...base, security_type: " option " })).toEqual({ eligible: false, reason: "option" });
    expect(dailyBarCaptureEligibility({ ...base, security_type: "Put", ib_con_id: null })).toEqual({ eligible: false, reason: "option" });
    expect(dailyBarCaptureEligibility({ ...base, security_type: "Bond" })).toEqual({ eligible: false, reason: "bond-or-cash" });
    expect(dailyBarCaptureEligibility({ ...base, security_type: "Mutual Fund", fund_category: "Cash Equivalent" })).toEqual({
      eligible: false,
      reason: "bond-or-cash",
    });
    expect(dailyBarCaptureEligibility({ ...base, security_type: "money_market" })).toEqual({ eligible: false, reason: "bond-or-cash" });
    expect(dailyBarCaptureEligibility({ ...base, security_type: "mutual_fund" })).toEqual({ eligible: false, reason: "mutual-fund" });
    expect(
      dailyBarCaptureEligibility({ ...base, security_type: "ETF", fund_category: "US Treasury", sector: "Fixed Income" }),
    ).toEqual({ eligible: false, reason: "bond-fund" });
    expect(dailyBarCaptureEligibility({ ...base, currency: "KRW", ib_con_id: null })).toEqual({ eligible: false, reason: "not-us-session" });
    expect(dailyBarCaptureEligibility({ ...base, ib_con_id: null })).toEqual({ eligible: false, reason: "no-contract-id" });
  });

  it("the list builder reads the same rule (one source)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/tws/daily-bar-capture.ts"), "utf8");
    const list = src.slice(anchorIndex(src, "export function listDailyBarTargets"));
    expect(list).toContain("dailyBarCaptureEligibility(");
    expect(list).not.toContain("isBondFundWithoutMarketMove(");
    expect(list).not.toContain("isUsSessionSecurity(");
    expect(src).not.toMatch(/is_option|is_bond|is_cash/);
  });

  it("is pure: it reads no database and needs no broker", () => {
    mockedGetIbApi.mockReturnValue(null);
    expect(dailyBarCaptureEligibility(base)).toEqual({ eligible: true });
    expect(mockedGetIbApi).not.toHaveBeenCalled();
  });
});

describe("auto-refresh Step 7", () => {
  it("auto-refresh starts Step 7 after Step 6 without awaiting it and never adds to errors", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/tws/auto-refresh.ts"), "utf8");
    const step6 = anchorIndex(src, "runLevelScanCycle(db,");
    const step7 = anchorIndex(src, "// ── Step 7", step6);
    const done = anchorIndex(src, "// ── Done", step7);
    const block = src.slice(step7, done);
    expect(block).toContain("getIbApi()");
    expect(block).toContain("void runDailyBarCapture(db)");
    expect(block).not.toMatch(/await\s+runDailyBarCapture/);
    expect(block).not.toContain("errors.push");
    expect(block).not.toMatch(/level\s*===/); // both refresh levels
    expect(src).not.toMatch(/await\s+runDailyBarCapture/);
  });

  it("the capture's default fetcher is the shared, rate-limited fetchOhlcvBars", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/tws/daily-bar-capture.ts"), "utf8");
    expect(src).toMatch(/opts\.fetch \?\? fetchOhlcvBars/);
    expect(src).not.toContain("getHistoricalData");
    expect(src).not.toMatch(/from ["']@\/lib\/db["']/);
  });
});


/**
 * The batch pin (Gains at risk step 2, Task S2). Frozen from the code BEFORE
 * the per-security body moved into `captureDailyBarsForSecurity`: the batch's
 * results, its requests, its logs and every stored bar, per scenario, must
 * stay exactly the same.
 */
describe("batch pin: runDailyBarCapture output is unchanged by the S2 refactor", () => {
  const PIN_PATH = path.join(process.cwd(), "tests/fixtures/daily-bar-capture-pin.json");
  const OLDER = () => sessionsBetween(addDays(TODAY, -900), addDays(TODAY, -731));
  const LAST_21 = () => sessionsBetween(addDays(TODAY, -40), YESTERDAY).slice(-21);

  type Scenario = { name: string; setup: () => { fetch: typeof fetchOhlcvBars; runs?: number } };
  const scenarios: Scenario[] = [
    {
      name: "first fill",
      setup: () => {
        hold(security("ZZA"));
        return { fetch: fakeFetch().fn };
      },
    },
    {
      name: "overlap agree, mid-session latest replaced",
      setup: () => {
        const id = security("ZZA");
        hold(id);
        storeBars(id, FULL_HISTORY, (d) => (d === YESTERDAY ? 101.3 : 100));
        return { fetch: fakeFetch({ close: () => 100 }).fn };
      },
    },
    {
      name: "too few compared sessions",
      setup: () => {
        const id = security("ZZA");
        hold(id);
        storeBars(id, [...OLDER(), ...FULL_HISTORY.filter((d) => d < "2026-10-20"), "2026-10-28", "2026-10-29", "2026-10-30", YESTERDAY], () => 100);
        return { fetch: fakeFetch({ close: () => 100 }).fn };
      },
    },
    {
      name: "basis change deletes older bars",
      setup: () => {
        const id = security("ZZA");
        hold(id);
        storeBars(id, [...OLDER(), ...FULL_HISTORY], () => 200);
        return { fetch: fakeFetch({ close: () => 100 }).fn };
      },
    },
    {
      name: "short full reply refused",
      setup: () => {
        const id = security("ZZA");
        hold(id);
        storeBars(id, sessionsBetween(addDays(TODAY, -400), YESTERDAY).slice(-253), () => 100);
        return { fetch: fakeFetch({ historyStart: () => LAST_21()[0] }).fn };
      },
    },
    {
      name: "short reply after a basis change refused",
      setup: () => {
        const id = security("ZZA");
        hold(id);
        storeBars(id, [...FULL_HISTORY.slice(0, 3), ...FULL_HISTORY.slice(-513)], () => 200);
        return { fetch: fakeFetch({ close: () => 100, historyStart: () => LAST_21()[0] }).fn };
      },
    },
    {
      name: "exhausted history (first fill of 21 bars) and a second run",
      setup: () => {
        hold(security("ZZA"));
        hold(security("ZZB"));
        return { fetch: fakeFetch({ historyStart: (id) => (id === 1 ? LAST_21()[0] : "2026-06-01") }).fn, runs: 2 };
      },
    },
    {
      name: "failure counted, not retried",
      setup: () => {
        const bad = security("ZZA");
        hold(bad);
        hold(security("ZZB"));
        return { fetch: fakeFetch({ fail: (id) => id === bad }).fn, runs: 2 };
      },
    },
    {
      name: "disconnect mid-run",
      setup: () => {
        hold(security("ZZA"));
        hold(security("ZZB"));
        const f = fakeFetch();
        const dropping = vi.fn(async (d: Database.Database, o: FetchOhlcvOptions) => {
          const res = await f.fn(d, o);
          mockedGetIbApi.mockReturnValue(null);
          return res;
        });
        return { fetch: dropping as unknown as typeof fetchOhlcvBars };
      },
    },
    {
      name: "disconnect during a fetch",
      setup: () => {
        hold(security("ZZA"));
        const dropping = vi.fn(async () => {
          mockedGetIbApi.mockReturnValue(null);
          throw new Error("TWS not connected");
        });
        return { fetch: dropping as unknown as typeof fetchOhlcvBars };
      },
    },
    {
      name: "ineligible names skipped and counted",
      setup: () => {
        hold(security("ZZMF", { type: "Mutual Fund" }));
        hold(security("ZZK", { currency: "KRW" }));
        hold(security("ZZN", { conId: null }));
        hold(security("ZZB", { type: "Bond" }));
        hold(security("ZZE", { type: "ETF" }));
        return { fetch: fakeFetch().fn };
      },
    },
    {
      name: "cap of 20 with a mixed book",
      setup: () => {
        for (let i = 0; i < 23; i++) {
          const id = security(`ZZ${String(i).padStart(2, "0")}`);
          hold(id);
          if (i % 3 === 0) storeBars(id, FULL_HISTORY, () => 100);
          if (i % 3 === 1) storeBars(id, FULL_HISTORY, () => 200);
        }
        return { fetch: fakeFetch({ close: () => 100 }).fn };
      },
    },
  ];

  async function runScenario(s: Scenario) {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    accountId = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Test')").run().lastInsertRowid as number;
    nextConId = 1000;
    const gl = globalThis as unknown as G;
    delete gl.__tws_dailyBarLedger;
    delete gl.__tws_dailyBarLastBatchAt;
    delete gl.__tws_dailyBarRunning;
    mockedGetIbApi.mockReturnValue({} as unknown as ReturnType<typeof getIbApi>);
    const logs: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void logs.push(`warn ${a.join(" ")}`));
    const info = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(`log ${a.join(" ")}`));
    try {
      const { fetch, runs = 1 } = s.setup();
      const calls: { securityId: number; durationStr?: string; maxBarDate?: string; incremental?: boolean; store?: boolean }[] = [];
      const recording = (async (d: Database.Database, o: FetchOhlcvOptions) => {
        calls.push({ securityId: o.securityId, durationStr: o.durationStr, maxBarDate: o.maxBarDate, incremental: o.incremental, store: o.store });
        return fetch(d, o);
      }) as unknown as typeof fetchOhlcvBars;
      const results = [];
      for (let i = 0; i < runs; i++) {
        results.push(await runDailyBarCapture(db, { today: TODAY, now: T0 + i * 26 * 60_000, fetch: recording }));
      }
      const rows = db
        .prepare(
          `SELECT s.symbol, b.bar_date, b.bar_size, b.open, b.high, b.low, b.close, b.volume
             FROM ohlcv_bars b JOIN securities s ON s.id = b.security_id
            ORDER BY s.symbol, b.bar_size, b.bar_date`,
        )
        .all() as { symbol: string; bar_date: string; bar_size: string; open: number; high: number; low: number; close: number; volume: number | null }[];
      // Every stored row, digested per symbol and bar size (the full rows would make a multi-megabyte fixture).
      const groups = new Map<string, typeof rows>();
      for (const r of rows) {
        const k = `${r.symbol} ${r.bar_size}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
      }
      const bars = [...groups.entries()].map(([key, g]) => ({
        key,
        count: g.length,
        first: g[0].bar_date,
        last: g[g.length - 1].bar_date,
        closes: [...new Set(g.map((r) => r.close))].sort((a, b) => a - b),
        sha256: createHash("sha256")
          .update(g.map((r) => [r.bar_date, r.open, r.high, r.low, r.close, r.volume].join("|")).join("\n"))
          .digest("hex"),
      }));
      return { name: s.name, results, calls, logs, bars };
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  }

  it("every scenario matches the frozen fixture", async () => {
    const actual = [];
    for (const s of scenarios) actual.push(await runScenario(s));
    // Frozen once (2026-11-24) from the code before the refactor, by a one-off write of
    // `JSON.stringify(actual, null, 1)` to PIN_PATH. Never regenerate it to make this pass.
    const frozen = JSON.parse(fs.readFileSync(PIN_PATH, "utf8"));
    expect(JSON.parse(JSON.stringify(actual))).toStrictEqual(frozen);
  }, 60_000);
});

describe("fix round 1 (S2): a database error while handling a fetch failure still stops the batch", () => {
  it("fetch fails, then prepare throws: capture stopped, attempted 1, ledger empty, retried next batch", async () => {
    const a = security("ZZA");
    hold(a);
    hold(security("ZZB"));
    let broken = false;
    const proxied = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare" && broken) {
          return () => {
            throw new Error("SQLITE_BUSY");
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Database.Database;
    const failing = vi.fn(async () => {
      broken = true;
      throw new Error("Timeout after 30s");
    });
    const logs: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...x: unknown[]) => void logs.push(x.join(" ")));
    const r = await runDailyBarCapture(proxied, { today: TODAY, now: T0, fetch: failing as unknown as typeof fetchOhlcvBars });
    warn.mockRestore();
    // Exactly what the code before the refactor answered.
    expect(r).toStrictEqual({
      attempted: 1,
      written: 0,
      fullRefetches: 1,
      basisChanges: 0,
      staleOlderBarsDeleted: 0,
      failed: 1,
      doneToday: 0,
      exhausted: 0,
      foreignSession: 0,
      noContractId: 0,
      mutualFund: 0,
      bondFund: 0,
    });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(["[daily-bars] capture stopped: Error"]);
    const ledger = (globalThis as unknown as { __tws_dailyBarLedger: { succeeded: Set<number>; exhausted: Set<number>; failed: Set<number> } })
      .__tws_dailyBarLedger;
    expect([ledger.succeeded.size, ledger.exhausted.size, ledger.failed.size]).toEqual([0, 0, 0]);
    expect((globalThis as unknown as G).__tws_dailyBarRunning).toBe(false);
    // Nothing was recorded, so the next batch tries both names again.
    const f = fakeFetch();
    const r2 = await runDailyBarCapture(db, { today: TODAY, now: T0 + 26 * 60_000, fetch: f.fn });
    expect(r2.attempted).toBe(2);
    expect(f.calls[0].securityId).toBe(a);
  });
});

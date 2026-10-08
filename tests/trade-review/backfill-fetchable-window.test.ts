/**
 * The price backfill decides fetchability BEFORE it asks the broker.
 *
 * The request ends today and reaches back at most two years. A trade that
 * exited before that can never be covered, so asking again on every
 * generation is a wasted broker request, forever. Bound under test: in one
 * generation a security is requested at most once; a security whose window is
 * unfetchable is requested zero times, on this run and on every later run.
 * Dates are relative to today so the fixture never goes stale. All figures
 * synthetic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { GroupedTrade } from "@/lib/compute/trade-roundtrips";
import { todayET } from "@/lib/calendar/date-utils";

const { fetchHistoricalPrices, fetchBenchmarkPrices } = vi.hoisted(() => ({
  fetchHistoricalPrices: vi.fn(
    async (_db: unknown, _options: { securityIds: number[]; durationStr: string }) => []
  ),
  fetchBenchmarkPrices: vi.fn(async (_db: unknown, _options: unknown) => []),
}));
vi.mock("@/lib/tws/client", () => ({ getIbApi: () => ({}) }));
vi.mock("@/lib/tws/historical", () => ({ fetchHistoricalPrices }));
vi.mock("@/lib/tws/benchmark", () => ({ fetchBenchmarkPrices }));

import {
  MAX_BACKFILL_LOOKBACK_DAYS,
  backfillDurationStr,
  backfillPriceData,
  isBackfillWindowFetchable,
  priceCoverageReachesExit,
} from "@/lib/trade-review/generate";

const TODAY = todayET();

function daysAgo(n: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

let db: Database.Database;
let aaa: number;
let zzz: number;

beforeEach(() => {
  fetchHistoricalPrices.mockClear();
  fetchBenchmarkPrices.mockClear();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const ins = db.prepare(
    "INSERT INTO securities (symbol, name, security_type, multiplier) VALUES (?, ?, 'Stock', 1)"
  );
  aaa = ins.run("AAA", "AAA Corp").lastInsertRowid as number;
  zzz = ins.run("ZZZ", "ZZZ Corp").lastInsertRowid as number;
});

/** One priced daily bar per calendar day from `fromAgo` down to `toAgo` days ago. */
function bars(securityId: number, fromAgo: number, toAgo: number): void {
  const stmt = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', 50, 51, 49, 50, 1000)`
  );
  for (let n = fromAgo; n >= toAgo; n--) stmt.run(securityId, daysAgo(n));
}

/** Enough SPY closes over the window that the benchmark never needs a fetch. */
function coverSpy(fromAgo: number, toAgo: number): void {
  const stmt = db.prepare(
    "INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, 400, 'tws')"
  );
  for (let n = fromAgo; n >= toAgo; n--) stmt.run(daysAgo(n));
}

function trade(securityId: number, symbol: string, entryAgo: number, exitAgo: number): GroupedTrade {
  return {
    securityId,
    symbol,
    earliestEntryDate: daysAgo(entryAgo),
    exitDate: daysAgo(exitAgo),
  } as GroupedTrade;
}

function requestedIds(): number[] {
  return fetchHistoricalPrices.mock.calls.flatMap((c) => c[1].securityIds);
}

describe("backfillPriceData asks the broker only for a window it can fill", () => {
  it("a trade that exited 3 years ago is never requested, and is graded without a price range", async () => {
    const old = trade(aaa, "AAA", 1125, 1095);
    const messages: string[] = [];
    await backfillPriceData(db, [old], (m) => messages.push(m));
    // ... and on every later run: nothing was stored, so the answer is the same.
    await backfillPriceData(db, [old]);

    expect(fetchHistoricalPrices).not.toHaveBeenCalled();
    expect(fetchBenchmarkPrices).not.toHaveBeenCalled();
    // The grading step drops the price range for exactly this condition.
    expect(priceCoverageReachesExit(db, aaa, old.earliestEntryDate, old.exitDate)).toBe(false);
    expect(messages.join("\n")).toMatch(/AAA/);
    expect(messages.join("\n")).toMatch(/without a price range/);
  });

  it("an old trade with a few stale points is still not requested", async () => {
    bars(aaa, 1125, 1120); // 6 points, stops 25 days before the exit
    await backfillPriceData(db, [trade(aaa, "AAA", 1125, 1095)]);
    expect(fetchHistoricalPrices).not.toHaveBeenCalled();
  });

  it("last month's trade with prices stopping 10 days before the exit is requested once, with the smallest window", async () => {
    bars(aaa, 40, 20);
    coverSpy(40, 10);
    await backfillPriceData(db, [trade(aaa, "AAA", 40, 10)]);

    expect(fetchHistoricalPrices).toHaveBeenCalledTimes(1);
    expect(fetchHistoricalPrices.mock.calls[0]).toEqual([
      db,
      { securityIds: [aaa], durationStr: "50 D" },
    ]);
    expect(fetchBenchmarkPrices).not.toHaveBeenCalled();
  });

  it("prices reaching the exit need no request", async () => {
    bars(aaa, 40, 10);
    coverSpy(40, 10);
    const messages: string[] = [];
    await backfillPriceData(db, [trade(aaa, "AAA", 40, 10)], (m) => messages.push(m));
    expect(fetchHistoricalPrices).not.toHaveBeenCalled();
    expect(fetchBenchmarkPrices).not.toHaveBeenCalled();
    expect(messages).toContain("Price data sufficient — skipping TWS fetch");
  });

  it("a security with several short trades is requested once in a generation", async () => {
    coverSpy(60, 10);
    await backfillPriceData(db, [
      trade(aaa, "AAA", 60, 50),
      trade(aaa, "AAA", 40, 30),
      trade(aaa, "AAA", 20, 10),
    ]);
    expect(requestedIds()).toEqual([aaa]);
    // The window reaches back to the earliest entry that needs prices.
    expect(fetchHistoricalPrices.mock.calls[0][1]).toMatchObject({ durationStr: "70 D" });
  });

  it("an old trade does not widen, or cause, the request for a recent one", async () => {
    coverSpy(40, 10);
    await backfillPriceData(db, [
      trade(zzz, "ZZZ", 1125, 1095), // unfetchable
      trade(aaa, "AAA", 1100, 1095), // unfetchable trade of a security that also traded recently
      trade(aaa, "AAA", 40, 10),
    ]);
    expect(requestedIds()).toEqual([aaa]);
    expect(fetchHistoricalPrices.mock.calls[0][1]).toMatchObject({ durationStr: "50 D" });
  });

  it("each security is requested with its own window, never twice", async () => {
    coverSpy(500, 10);
    await backfillPriceData(db, [trade(aaa, "AAA", 500, 400), trade(zzz, "ZZZ", 40, 10)]);
    const calls = fetchHistoricalPrices.mock.calls.map((c) => c[1]);
    expect(calls).toEqual([
      { securityIds: [aaa], durationStr: "2 Y" },
      { securityIds: [zzz], durationStr: "50 D" },
    ]);
  });

  it("the SPY benchmark is not requested for a period older than a request can reach", async () => {
    bars(aaa, 40, 10);
    await backfillPriceData(db, [trade(aaa, "AAA", 40, 10)]);
    expect(fetchBenchmarkPrices).toHaveBeenCalledTimes(1); // recent period, no SPY cached

    fetchBenchmarkPrices.mockClear();
    await backfillPriceData(db, [trade(zzz, "ZZZ", 1125, 1095)]);
    expect(fetchBenchmarkPrices).not.toHaveBeenCalled();
  });
});

describe("the fetchability rule", () => {
  it("a window is fetchable when the exit is no older than the longest request", () => {
    expect(MAX_BACKFILL_LOOKBACK_DAYS).toBe(730);
    expect(isBackfillWindowFetchable("2024-10-07", "2026-10-07")).toBe(true); // exactly 730 days
    expect(isBackfillWindowFetchable("2024-10-06", "2026-10-07")).toBe(false);
    expect(isBackfillWindowFetchable("2026-10-07", "2026-10-07")).toBe(true);
  });

  it("the duration is the smallest request that reaches back to the start", () => {
    expect(backfillDurationStr("2026-10-01", "2026-10-07")).toBe("30 D");
    expect(backfillDurationStr("2026-08-28", "2026-10-07")).toBe("50 D");
    // IB takes a day count up to 365; anything longer must be asked in years.
    expect(backfillDurationStr("2025-10-17", "2026-10-07")).toBe("365 D");
    expect(backfillDurationStr("2025-10-16", "2026-10-07")).toBe("2 Y");
    expect(backfillDurationStr("2020-01-01", "2026-10-07")).toBe("2 Y");
  });
});

describe("benchmark window obeys the same duration rule", () => {
  it("a start 356 to 365 days back is asked in years, never as more than 365 days", () => {
    const today = "2026-10-07";
    for (let back = 350; back <= 370; back++) {
      const start = new Date(Date.UTC(2026, 9, 7) - back * 86_400_000).toISOString().slice(0, 10);
      const d = backfillDurationStr(start, today);
      const m = /^(\d+) D$/.exec(d);
      if (m) expect(Number(m[1])).toBeLessThanOrEqual(365);
      else expect(d).toBe("2 Y");
    }
  });
});

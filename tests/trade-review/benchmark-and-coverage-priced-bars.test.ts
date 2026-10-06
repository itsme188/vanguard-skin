/**
 * Legacy zero bars — the two trade-review readers the 2026-09-11 priced-bar
 * pass did not reach (TODO: qa-landing 2026-09-11 follow-ups (e)).
 *
 *  1. `getBenchmarkReturn`'s SPY-in-`ohlcv_bars` fallback picked the first /
 *     last bar of the window raw. A zero close at the window's start divides
 *     by zero; one at the end reads as a -100% benchmark period.
 *  2. The trade-review price-coverage count (does TWS need to backfill?)
 *     counted a zero bar as a real data point, while `getStockPriceContext`
 *     drops it — so a thin series could be judged "covered" and then fail the
 *     reader's own quality gate.
 *
 * Rule under test: a filtered-out bar is simply ABSENT. The result must equal
 * the result of the same series with that row deleted. All figures synthetic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getMarketContext,
  countCachedPricePoints,
} from "@/lib/trade-review/market-context";
import type { GroupedTrade } from "@/lib/compute/trade-roundtrips";

const ACCOUNT_ID = 1; // seeded by runMigrations
const START = "2026-01-05";
const END = "2026-03-06";

function makeDb(): { db: Database.Database; spyId: number; tradeSecId: number } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const ins = db.prepare(
    "INSERT INTO securities (symbol, name, security_type, multiplier) VALUES (?, ?, ?, 1)",
  );
  const spyId = ins.run("SPY", "Synthetic Index Fund", "ETF").lastInsertRowid as number;
  const tradeSecId = ins.run("QZBAR", "Zero Bar Test Co", "Stock").lastInsertRowid as number;
  return { db, spyId, tradeSecId };
}

/** Weekday daily bars from START; close ramps 100, 101, 102, … */
function seedRamp(db: Database.Database, securityId: number, count: number): string[] {
  const stmt = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`,
  );
  const dates: string[] = [];
  const cursor = new Date(`${START}T00:00:00Z`);
  while (dates.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      const iso = cursor.toISOString().slice(0, 10);
      const close = 100 + dates.length;
      stmt.run(securityId, iso, close, close + 2, close - 2, close);
      dates.push(iso);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function zeroBar(db: Database.Database, securityId: number, date: string): void {
  // The observed legacy defect: real open/high, low = 0 AND close = 0.
  db.prepare(
    "UPDATE ohlcv_bars SET low = 0, close = 0 WHERE security_id = ? AND bar_date = ?",
  ).run(securityId, date);
}

function deleteBar(db: Database.Database, securityId: number, date: string): void {
  db.prepare("DELETE FROM ohlcv_bars WHERE security_id = ? AND bar_date = ?").run(
    securityId,
    date,
  );
}

function makeTrade(securityId: number, start: string, end: string): GroupedTrade {
  return {
    saleTransactionId: 100,
    securityId,
    symbol: "QZBAR",
    securityName: "Zero Bar Test Co",
    lots: [],
    totalQuantity: 10,
    sellTransactionQty: 10,
    lotCoverage: 1,
    avgEntryPrice: 100,
    exitPrice: 104,
    exitDate: end,
    earliestEntryDate: start,
    latestEntryDate: start,
    avgHoldingDays: 30,
    maxHoldingDays: 30,
    minHoldingDays: 30,
    totalCost: 1000,
    totalProceeds: 1040,
    realizedPnl: 40,
    returnPct: 4,
    usdPerUnit: 1,
    conventionPending: false,
    isSyntheticClose: false,
  } as GroupedTrade;
}

function benchmark(db: Database.Database, tradeSecId: number, start: string, end: string) {
  return getMarketContext(db, [makeTrade(tradeSecId, start, end)], ACCOUNT_ID)[0]
    .benchmarkReturn;
}

describe("getBenchmarkReturn — SPY ohlcv_bars fallback reads priced bars only", () => {
  let dates: string[];
  let clean: ReturnType<typeof makeDb>;

  beforeEach(() => {
    clean = makeDb();
    dates = seedRamp(clean.db, clean.spyId, 30);
  });

  it("baseline: first-to-last close over the window", () => {
    const r = benchmark(clean.db, clean.tradeSecId, dates[0], dates[29]);
    expect(r).toBeCloseTo((129 - 100) / 100, 10);
  });

  it.each([
    ["at the window start", 0],
    ["in the middle", 14],
    ["at the window end", 29],
  ])("a zero bar %s gives the same return as the series without that bar", (_label, idx) => {
    const withZero = makeDb();
    const dz = seedRamp(withZero.db, withZero.spyId, 30);
    zeroBar(withZero.db, withZero.spyId, dz[idx]);

    const without = makeDb();
    const dw = seedRamp(without.db, without.spyId, 30);
    deleteBar(without.db, without.spyId, dw[idx]);

    const got = benchmark(withZero.db, withZero.tradeSecId, dates[0], dates[29]);
    const expected = benchmark(without.db, without.tradeSecId, dates[0], dates[29]);

    expect(expected).not.toBeNull();
    expect(Number.isFinite(expected!)).toBe(true);
    expect(got).toBe(expected);
    // Never the fabricated moves the raw read produced.
    expect(got).not.toBe(-1);
    expect(Number.isFinite(got!)).toBe(true);
  });

  it("a window whose only priced bar is one date stays null (single-point gate)", () => {
    const db2 = makeDb();
    const d = seedRamp(db2.db, db2.spyId, 3);
    zeroBar(db2.db, db2.spyId, d[0]);
    zeroBar(db2.db, db2.spyId, d[2]);
    expect(benchmark(db2.db, db2.tradeSecId, d[0], d[2])).toBeNull();
  });
});

describe("countCachedPricePoints — coverage count ignores zero bars", () => {
  it("counts priced daily bars plus prices rows in the window", () => {
    const { db, tradeSecId } = makeDb();
    const d = seedRamp(db, tradeSecId, 6);
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'manual')",
    ).run(tradeSecId, d[0], 100);
    expect(countCachedPricePoints(db, tradeSecId, START, END)).toBe(7);
  });

  it("a zero bar is not a data point — same count as the series without it", () => {
    const withZero = makeDb();
    const dz = seedRamp(withZero.db, withZero.tradeSecId, 6);
    zeroBar(withZero.db, withZero.tradeSecId, dz[3]);

    const without = makeDb();
    const dw = seedRamp(without.db, without.tradeSecId, 6);
    deleteBar(without.db, without.tradeSecId, dw[3]);

    expect(countCachedPricePoints(withZero.db, withZero.tradeSecId, START, END)).toBe(5);
    expect(countCachedPricePoints(withZero.db, withZero.tradeSecId, START, END)).toBe(
      countCachedPricePoints(without.db, without.tradeSecId, START, END),
    );
  });

  it("intraday bars are not counted", () => {
    const { db, tradeSecId } = makeDb();
    db.prepare(
      `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
       VALUES (?, ?, '1 hour', 100, 101, 99, 100, 10)`,
    ).run(tradeSecId, START);
    expect(countCachedPricePoints(db, tradeSecId, START, END)).toBe(0);
  });
});

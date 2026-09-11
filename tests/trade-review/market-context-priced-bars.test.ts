/**
 * PR #72 review follow-up (2026-09-11): the shared priced-bar guard
 * (PRICED_BAR_SQL, lib/queries/ohlcv.ts) was applied to the three display
 * readers but NOT to getStockPriceContext's period high/low map, which read
 * `ohlcv_bars` raw.
 *
 * A legacy zero-priced bar (real open/high, low = 0 AND close = 0 — the
 * defect class the write guard only started rejecting on 2026-09-06) sets
 * that date's low to 0, which becomes `periodLow: 0` for the whole holding
 * period. That number is not displayed and then forgotten: it goes into the
 * trade-review PROMPT, where the model narrates it as a real drawdown the
 * security never had ("it fell to zero before you sold").
 *
 * The fix drops the corrupt bar rather than clamping it, so the `prices`
 * fill-in still covers that date from the other pipeline when it can.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getMarketContext } from "@/lib/trade-review/market-context";
import type { GroupedTrade } from "@/lib/compute/trade-roundtrips";

const ACCOUNT_ID = 1; // seeded by runMigrations
const START = "2026-01-05";
const END = "2026-03-06";

let db: Database.Database;
let securityId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  securityId = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, multiplier) VALUES (?, ?, 'Stock', 1)",
    )
    .run("QPBAR", "Priced Bar Test Co").lastInsertRowid as number;
});

/** Weekday daily bars from START, `count` of them, all flat at `price`. */
function seedDailyBars(count: number, price: number): string[] {
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
      stmt.run(securityId, iso, price, price + 2, price - 2, price);
      dates.push(iso);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function makeTrade(overrides: Partial<GroupedTrade> = {}): GroupedTrade {
  return {
    saleTransactionId: 100,
    securityId,
    symbol: "QPBAR",
    securityName: "Priced Bar Test Co",
    lots: [],
    totalQuantity: 10,
    sellTransactionQty: 10,
    lotCoverage: 1,
    avgEntryPrice: 100,
    exitPrice: 104,
    exitDate: END,
    earliestEntryDate: START,
    latestEntryDate: START,
    avgHoldingDays: 61,
    maxHoldingDays: 61,
    minHoldingDays: 61,
    totalCost: 1000,
    totalProceeds: 1040,
    realizedPnl: 40,
    returnPct: 4,
    usdPerUnit: 1,
    conventionPending: false,
    isSyntheticClose: false,
    ...overrides,
  } as GroupedTrade;
}

describe("getStockPriceContext — priced-bar guard on the period high/low map", () => {
  it("baseline: a clean flat series reports the real period low", () => {
    seedDailyBars(40, 100);
    const [ctx] = getMarketContext(db, [makeTrade()], ACCOUNT_ID);
    expect(ctx.stockContext).not.toBeNull();
    expect(ctx.stockContext!.periodLow).toBe(98);
    // The exit price is always folded into the range (it is a real traded
    // price on that date), and here it tops the bar highs.
    expect(ctx.stockContext!.periodHigh).toBe(104);
  });

  it("a zero-priced bar inside the window does not become periodLow: 0", () => {
    const dates = seedDailyBars(40, 100);
    // Corrupt one in-window bar in place: real open/high, low and close 0.
    db.prepare(
      `UPDATE ohlcv_bars SET open = 2780, high = 2960, low = 0, close = 0
       WHERE security_id = ? AND bar_date = ?`,
    ).run(securityId, dates[10]);

    const [ctx] = getMarketContext(db, [makeTrade()], ACCOUNT_ID);
    expect(ctx.stockContext).not.toBeNull();
    // Unguarded this was 0 (and periodHigh 2960) — a fabricated crash and a
    // fabricated spike, both fed to the trade-review model.
    expect(ctx.stockContext!.periodLow).toBe(98);
    expect(ctx.stockContext!.periodLowDate).not.toBe(dates[10]);
    expect(ctx.stockContext!.periodHigh).toBe(104);
  });

  it("the `prices` fill-in still covers the corrupt bar's date", () => {
    const dates = seedDailyBars(40, 100);
    db.prepare(
      `UPDATE ohlcv_bars SET open = 2780, high = 2960, low = 0, close = 0
       WHERE security_id = ? AND bar_date = ?`,
    ).run(securityId, dates[10]);
    // The other pipeline has a real close for that same date — dropping the
    // corrupt bar must let it through, not blacklist the date.
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'manual')",
    ).run(securityId, dates[10], 93);

    const [ctx] = getMarketContext(db, [makeTrade()], ACCOUNT_ID);
    expect(ctx.stockContext!.periodLow).toBe(93);
    expect(ctx.stockContext!.periodLowDate).toBe(dates[10]);
  });

  it("a high < low bar is dropped too (the other half of the guard)", () => {
    const dates = seedDailyBars(40, 100);
    db.prepare(
      `UPDATE ohlcv_bars SET open = 100, high = 3, low = 90, close = 95
       WHERE security_id = ? AND bar_date = ?`,
    ).run(securityId, dates[15]);

    const [ctx] = getMarketContext(db, [makeTrade()], ACCOUNT_ID);
    expect(ctx.stockContext!.periodLow).toBe(98);
    expect(ctx.stockContext!.periodHigh).toBe(104);
  });

  it("dropping corrupt bars can push a thin series below the coverage gate rather than inventing a range", () => {
    // 6 bars over a two-month window is already thin; wiping 3 of them leaves
    // too few real points, and the honest answer is null (no context), not a
    // range built from zero-priced rows.
    const dates = seedDailyBars(6, 100);
    for (const d of dates.slice(0, 3)) {
      db.prepare(
        "UPDATE ohlcv_bars SET low = 0, close = 0 WHERE security_id = ? AND bar_date = ?",
      ).run(securityId, d);
    }
    const [ctx] = getMarketContext(db, [makeTrade()], ACCOUNT_ID);
    expect(ctx.stockContext).toBeNull();
  });
});

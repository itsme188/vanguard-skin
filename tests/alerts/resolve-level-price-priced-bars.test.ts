/**
 * PR #72 review follow-up (2026-09-11): the shared priced-bar guard
 * (PRICED_BAR_SQL, lib/queries/ohlcv.ts) was applied to the three display
 * readers but NOT to computeMovingAverage, which read `ohlcv_bars` raw and
 * with no bar_size filter at all.
 *
 * That is not a cosmetic gap. An MA level's effective price IS the trigger
 * threshold findCrossedLevels compares against, so a legacy zero-priced
 * close (real open/high, low = 0 AND close = 0 — the defect class the write
 * guard only started rejecting on 2026-09-06) drags the average DOWN and
 * changes whether a support fires. A stray intraday series under the same
 * security_id does the same thing by making "sma_50" a 50-row average over
 * mixed timeframes instead of the 50-DAY average the level was drawn on.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeMovingAverage, resolveLevelPrice } from "@/lib/alerts/resolve-level-price";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, name) VALUES (?, ?)")
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

/** `count` consecutive daily bars ending today, every close at `close`. */
function seedDailyBars(
  securityId: number,
  count: number,
  close: number,
  barSize = "1 day",
): void {
  const stmt = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, date('now', '-' || ? || ' days'), ?, ?, ?, ?, ?, 1000)`,
  );
  for (let i = 0; i < count; i++) {
    stmt.run(securityId, count - 1 - i, barSize, close, close + 1, close - 1, close);
  }
}

describe("computeMovingAverage — priced-bar guard", () => {
  it("baseline: a clean 20-bar series at 100 gives an sma_9 of exactly 100", () => {
    const id = seedSecurity("QCLEAN");
    seedDailyBars(id, 20, 100);
    expect(computeMovingAverage(db, id, "sma_9")).toBeCloseTo(100, 6);
  });

  it("a zero-priced bar inside the window does not drag the SMA down", () => {
    const id = seedSecurity("QZERO");
    seedDailyBars(id, 20, 100);
    // Corrupt one in-window bar in place: real open/high, low and close 0 —
    // the exact shape of the legacy rows that predate the write guard.
    db.prepare(
      `UPDATE ohlcv_bars SET open = 2780, high = 2960, low = 0, close = 0
       WHERE security_id = ? AND bar_date = date('now', '-3 days')`,
    ).run(id);

    // Unguarded, one 0 among nine 100s would pull the sma_9 to ~88.9.
    expect(computeMovingAverage(db, id, "sma_9")).toBeCloseTo(100, 6);
  });

  it("the same zero bar would otherwise flip an armed support level's trigger state", () => {
    const id = seedSecurity("QTRIGGER");
    seedDailyBars(id, 20, 100);
    db.prepare(
      `UPDATE ohlcv_bars SET open = 2780, high = 2960, low = 0, close = 0
       WHERE security_id = ? AND bar_date = date('now', '-1 days')`,
    ).run(id);

    const effective = resolveLevelPrice(db, {
      security_id: id,
      price: 100,
      price_source: "sma_9",
    });
    expect(effective).not.toBeNull();
    // A current price of 95 must NOT be "at or below" a 100 support. With the
    // zero bar averaged in the threshold drops to ~88.9 — either way the
    // number the scanner compares against is fiction.
    expect(effective!).toBeGreaterThan(95);
  });

  it("an EMA is guarded the same way", () => {
    const id = seedSecurity("QEMA");
    seedDailyBars(id, 40, 50);
    db.prepare(
      `UPDATE ohlcv_bars SET open = 51, high = 52, low = 0, close = 0
       WHERE security_id = ? AND bar_date = date('now', '-2 days')`,
    ).run(id);
    expect(computeMovingAverage(db, id, "ema_21")).toBeCloseTo(50, 6);
  });

  it("a corrupt bar does not consume one of the period*2 slots — history stays sufficient", () => {
    const id = seedSecurity("QSLOTS");
    // Exactly `period` usable bars plus one corrupt one. Filtering AFTER the
    // LIMIT would leave 8 rows and return null ("insufficient history").
    seedDailyBars(id, 10, 100);
    db.prepare(
      `UPDATE ohlcv_bars SET low = 0, close = 0
       WHERE security_id = ? AND bar_date = date('now', '-9 days')`,
    ).run(id);
    expect(computeMovingAverage(db, id, "sma_9")).toBeCloseTo(100, 6);
  });

  it("still returns null when there genuinely is not enough usable history", () => {
    const id = seedSecurity("QTHIN");
    seedDailyBars(id, 12, 100);
    // Wipe 5 of them: 7 usable bars is fewer than the 9 an sma_9 needs.
    db.prepare(
      `UPDATE ohlcv_bars SET low = 0, close = 0
       WHERE security_id = ? AND bar_date >= date('now', '-4 days')`,
    ).run(id);
    expect(computeMovingAverage(db, id, "sma_9")).toBeNull();
  });
});

describe("computeMovingAverage — bar_size filter", () => {
  it("ignores a non-daily series stored under the same security", () => {
    const id = seedSecurity("QMIXED");
    seedDailyBars(id, 20, 100);
    // A 1-hour series at a very different level, on the same bar_dates.
    seedDailyBars(id, 20, 5, "1 hour");
    // Unguarded, the DESC-LIMIT window would interleave both series and the
    // "50-day" average would be a mixture of timeframes.
    expect(computeMovingAverage(db, id, "sma_9")).toBeCloseTo(100, 6);
  });
});

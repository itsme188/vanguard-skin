/**
 * A trade is graded on a price range only when its cached prices reach the
 * exit. A history that stalled mid-period passes a plain point count and
 * still ends before the later move, so its "period high" is the high of the
 * cached part only (the stored assessment that cited a period high the stock
 * had already beaten). All figures synthetic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  MAX_EXIT_PRICE_GAP_DAYS,
  priceCoverageReachesExit,
} from "@/lib/trade-review/generate";
import { countCachedPricePoints } from "@/lib/trade-review/market-context";
import { sliceBetween } from "@/tests/helpers/source-anchor";

const ENTRY = "2026-03-02";
const EXIT = "2026-03-31";
let db: Database.Database;
let secId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  secId = db
    .prepare("INSERT INTO securities (symbol, name, security_type, multiplier) VALUES ('AAA', 'AAA Corp', 'Stock', 1)")
    .run().lastInsertRowid as number;
});

function bar(date: string, close = 50): void {
  db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`
  ).run(secId, date, close, close + 1, close - 1, close);
}

function price(date: string, close = 50): void {
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'manual')").run(
    secId,
    date,
    close
  );
}

describe("priceCoverageReachesExit", () => {
  it("a history that stalls mid-period has enough points and still does not reach the exit", () => {
    for (const d of ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-09"]) bar(d);
    expect(countCachedPricePoints(db, secId, ENTRY, EXIT)).toBeGreaterThanOrEqual(5);
    expect(priceCoverageReachesExit(db, secId, ENTRY, EXIT)).toBe(false);
  });

  it("reaches the exit when the last bar is within the allowed gap", () => {
    bar("2026-03-02");
    bar("2026-03-26"); // 5 days before the exit
    expect(MAX_EXIT_PRICE_GAP_DAYS).toBe(5);
    expect(priceCoverageReachesExit(db, secId, ENTRY, EXIT)).toBe(true);
  });

  it("one day past the allowed gap does not reach", () => {
    bar("2026-03-25"); // 6 days before the exit
    expect(priceCoverageReachesExit(db, secId, ENTRY, EXIT)).toBe(false);
  });

  it("a daily close in `prices` counts, as it does in the price context", () => {
    bar("2026-03-09");
    price("2026-03-30");
    expect(priceCoverageReachesExit(db, secId, ENTRY, EXIT)).toBe(true);
  });

  it("no cached price at all does not reach", () => {
    expect(priceCoverageReachesExit(db, secId, ENTRY, EXIT)).toBe(false);
  });

  it("a zero-priced legacy bar near the exit is not coverage", () => {
    bar("2026-03-09");
    db.prepare(
      `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
       VALUES (?, '2026-03-31', '1 day', 50, 51, 0, 0, 0)`
    ).run(secId);
    expect(priceCoverageReachesExit(db, secId, ENTRY, EXIT)).toBe(false);
  });

  it("prices after the exit or for another security do not count", () => {
    bar("2026-03-09");
    bar("2026-04-01");
    const other = db
      .prepare("INSERT INTO securities (symbol, name, security_type, multiplier) VALUES ('ZZZ', 'ZZZ Corp', 'Stock', 1)")
      .run().lastInsertRowid as number;
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-03-31', 9, 'manual')").run(other);
    expect(priceCoverageReachesExit(db, secId, ENTRY, EXIT)).toBe(false);
  });

  it("a same-day trade with a bar that day reaches", () => {
    bar("2026-03-31");
    expect(priceCoverageReachesExit(db, secId, EXIT, EXIT)).toBe(true);
  });
});

describe("the generator uses the check in both places (source pin)", () => {
  const src = readFileSync("lib/trade-review/generate.ts", "utf8");

  it("the backfill fetches a security whose history stops short of the exit", () => {
    const backfill = sliceBetween(src, "async function backfillPriceData(", "// Check SPY benchmark coverage");
    expect(backfill).toMatch(/if \(priceCount < MIN_PRICE_POINTS\)/);
    expect(backfill).toMatch(/!priceCoverageReachesExit\(db, trade\.securityId, trade\.earliestEntryDate, trade\.exitDate\)/);
  });

  it("the fetch window is measured back from today, not from the period's end", () => {
    const duration = sliceBetween(src, "// Compute duration string from date range", "// Fetch security prices");
    expect(duration).toMatch(/const durationStr = backfillDurationStr\(overallStart, todayET\(\)\)/);
  });

  it("a trade whose history stops short is graded without a price range", () => {
    const ctx = sliceBetween(src, "const marketContexts = getMarketContext(", "let marketContextStr");
    expect(ctx).toMatch(/!priceCoverageReachesExit\(/);
    expect(ctx).toMatch(/\{ \.\.\.ctx, stockContext: null \}/);
  });
});

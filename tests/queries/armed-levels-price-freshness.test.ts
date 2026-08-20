/**
 * Gap 1 pin (follow-up to f7823b6): getArmedLevels mirrored only HALF of the
 * scanner's skip conditions. findCrossedLevels also requires a price no older
 * than the freshness window, but getArmedLevels' CTEs had no freshness bound
 * and returned no price date — so an armed level whose last price was weeks
 * old rendered as live coverage ("Now $100 · 3% away") while every scan pass
 * skipped it.
 *
 * These tests pin the two query sites to the SAME window: whatever
 * findCrossedLevels refuses to scan, getArmedLevels must flag.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getArmedLevels,
  findCrossedLevels,
  getLatestScanPriceForSecurity,
} from "@/lib/queries/security-levels";
import { upsertLevel } from "@/lib/mutations/security-levels";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string, securityType = "stock"): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, ?, 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`, securityType).lastInsertRowid as number;
}

/** Seed a price N days back, dated by SQLite so the test never straddles a
 *  local-vs-UTC midnight (date('now') is UTC). */
function seedPriceDaysAgo(securityId: number, price: number, daysAgo: number): void {
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source)
     VALUES (?, date('now', '-' || ? || ' days'), ?, 'manual')`,
  ).run(securityId, daysAgo, price);
}

function armedFor(symbol: string) {
  const row = getArmedLevels(db).find((l) => l.symbol === symbol);
  if (!row) throw new Error(`no armed level for ${symbol}`);
  return row;
}

describe("getArmedLevels price freshness", () => {
  it("surfaces the price date the current price came from", () => {
    const sec = seedSecurity("FRESHQA");
    seedPriceDaysAgo(sec, 100, 0);
    upsertLevel(db, { security_id: sec, level_type: "support", price: 90 });

    const today = db.prepare("SELECT date('now') AS d").get() as { d: string };
    expect(armedFor("FRESHQA").price_date).toBe(today.d);
  });

  it("does not flag a price inside the scanner's window", () => {
    const sec = seedSecurity("RECENTQA");
    seedPriceDaysAgo(sec, 100, 4); // exactly at the edge — still scanned
    // Support at 110 vs price 100: the condition holds, so a fresh price means
    // the scanner really does pick this row up.
    upsertLevel(db, { security_id: sec, level_type: "support", price: 110 });

    expect(armedFor("RECENTQA").price_is_stale).toBe(false);
    expect(findCrossedLevels(db).map((r) => r.security_id)).toContain(sec);
    expect(getLatestScanPriceForSecurity(db, sec).isFresh).toBe(true);
  });

  it("flags an armed level whose only price is older than the window", () => {
    const sec = seedSecurity("STALEQA");
    seedPriceDaysAgo(sec, 100, 30);
    // Support at 110 with price 100 → condition satisfied, so if the price
    // were fresh the scanner WOULD fire it. It doesn't: the price is stale.
    upsertLevel(db, { security_id: sec, level_type: "support", price: 110 });

    const row = armedFor("STALEQA");
    expect(row.price_is_stale).toBe(true);
    expect(row.current_price).toBe(100); // still listed — the view shows it…
    expect(findCrossedLevels(db)).toHaveLength(0); // …but the scanner skips it
    expect(getLatestScanPriceForSecurity(db, sec).isFresh).toBe(false);
  });

  it("does not call a missing price stale — absent is not stale", () => {
    const sec = seedSecurity("NOPRICEQA");
    upsertLevel(db, { security_id: sec, level_type: "entry", price: 50 });

    const row = armedFor("NOPRICEQA");
    expect(row.current_price).toBeNull();
    expect(row.price_date).toBeNull();
    expect(row.price_is_stale).toBe(false);
  });

  it("flags a stale benchmark-sourced price too (same COALESCE the scanner uses)", () => {
    const sec = seedSecurity("BENCHQA");
    db.prepare(
      `INSERT INTO benchmark_prices (symbol, date, close_price)
       VALUES ('BENCHQA', date('now', '-20 days'), 100)`,
    ).run();
    upsertLevel(db, { security_id: sec, level_type: "support", price: 90 });

    const row = armedFor("BENCHQA");
    expect(row.current_price).toBe(100);
    expect(row.price_is_stale).toBe(true);
  });

  it("applies freshness to options too — only the plausibility band exempts them", () => {
    const sec = seedSecurity("OPTFRESHQA", "option");
    seedPriceDaysAgo(sec, 100, 30);
    upsertLevel(db, { security_id: sec, level_type: "exit", price: 300 });

    const row = armedFor("OPTFRESHQA");
    expect(row.beyond_scan_range).toBe(false); // options exempt from the band
    expect(row.price_is_stale).toBe(true); // but NOT from the freshness gate
  });
});

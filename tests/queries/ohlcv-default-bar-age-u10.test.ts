import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getDefaultChartSecurityId } from "@/lib/queries/ohlcv";

function sec(db: Database.Database, symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, security_type, ib_con_id) VALUES (?, 'Stock', ?)")
    .run(symbol, Math.floor(Math.random() * 1_000_000) + 1).lastInsertRowid as number;
}

function holding(db: Database.Database, securityId: number, qty: number) {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (1, ?, ?, '2026-10-07', ?)`,
  ).run(securityId, qty, `h-${securityId}`);
}

function price(db: Database.Database, securityId: number, date: string, close: number) {
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(securityId, date, close);
}

function bar(db: Database.Database, securityId: number, date: string) {
  db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', 10, 11, 9, 10, 100)`,
  ).run(securityId, date);
}

describe("getDefaultChartSecurityId bar age", () => {
  it("does not treat a very old daily bar as coverage when the security has a recent price", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const staleBars = sec(db, "ZZST");
    holding(db, staleBars, 100);
    price(db, staleBars, "2026-10-07", 200);
    bar(db, staleBars, "2026-01-01");

    const freshBars = sec(db, "ZZFR");
    holding(db, freshBars, 10);
    price(db, freshBars, "2026-10-07", 50);
    bar(db, freshBars, "2026-10-06");

    expect(getDefaultChartSecurityId(db)).toBe(freshBars);
  });

  it("uses the book-wide latest price date for bar freshness, so stale tiny holdings do not beat current large ones", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const large = sec(db, "ZZLG");
    holding(db, large, 100);
    price(db, large, "2026-10-07", 200);
    bar(db, large, "2026-08-25"); // 43 days old against the book-wide latest price date.

    const tiny = sec(db, "ZZTY");
    holding(db, tiny, 1);
    price(db, tiny, "2025-10-07", 10);
    bar(db, tiny, "2025-10-06");

    expect(getDefaultChartSecurityId(db)).toBe(large);
  });

  it("with no fresh bars anywhere, a holding that has bars beats a larger one with none (never an empty chart)", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const bigNoBars = sec(db, "ZZNB");
    holding(db, bigNoBars, 1000);
    price(db, bigNoBars, "2026-10-07", 200);

    const smallStaleBars = sec(db, "ZZSB");
    holding(db, smallStaleBars, 10);
    price(db, smallStaleBars, "2026-10-07", 50);
    bar(db, smallStaleBars, "2026-01-01");

    expect(getDefaultChartSecurityId(db)).toBe(smallStaleBars);
  });
});

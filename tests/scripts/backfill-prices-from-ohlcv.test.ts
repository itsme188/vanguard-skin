import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  resolveSecurityIds,
  backfillPricesFromOhlcv,
} from "@/scripts/backfill-prices-from-ohlcv";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function seedSecurity(db: Database.Database, symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')")
    .run(symbol, symbol).lastInsertRowid as number;
}

function seedBar(
  db: Database.Database,
  securityId: number,
  date: string,
  close: number,
  barSize = "1 day",
): void {
  db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(securityId, date, barSize, close, close, close, close);
}

function seedPrice(
  db: Database.Database,
  securityId: number,
  date: string,
  closePrice: number,
  source = "tws",
): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, ?)",
  ).run(securityId, date, closePrice, source);
}

function seedHolding(db: Database.Database, accountId: number, securityId: number, asOfDate: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 1, ?, ?)`,
  ).run(accountId, securityId, asOfDate, `hold-${accountId}-${securityId}-${asOfDate}`);
}

function priceRows(db: Database.Database, securityId: number): Array<{ date: string; close_price: number; source: string }> {
  return db
    .prepare("SELECT date, close_price, source FROM prices WHERE security_id = ? ORDER BY date")
    .all(securityId) as Array<{ date: string; close_price: number; source: string }>;
}

const IBKR_ACCOUNT_ID = 3; // seeded by 002_seed_accounts.sql

describe("resolveSecurityIds", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("returns every security an account has ever held, and only those", () => {
    const held = seedSecurity(db, "HELD");
    const other = seedSecurity(db, "OTHER");
    const sold = seedSecurity(db, "SOLD");

    seedHolding(db, IBKR_ACCOUNT_ID, held, "2025-06-30");
    seedHolding(db, IBKR_ACCOUNT_ID, sold, "2025-01-31"); // held in the past, not now
    seedHolding(db, 1, other, "2025-06-30"); // held by a different account

    const ids = resolveSecurityIds(db, { accountId: IBKR_ACCOUNT_ID });
    expect(ids.sort((a, b) => a - b)).toEqual([held, sold].sort((a, b) => a - b));
    expect(ids).not.toContain(other);
  });

  it("returns the explicit securityIds list as-is when given", () => {
    const a = seedSecurity(db, "AAA");
    const b = seedSecurity(db, "BBB");
    const ids = resolveSecurityIds(db, { securityIds: [a, b] });
    expect(ids.sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));
  });
});

describe("backfillPricesFromOhlcv", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("(a) inserts only missing dates in range", () => {
    const sec = seedSecurity(db, "AAPL");
    seedBar(db, sec, "2025-06-02", 200);
    seedBar(db, sec, "2025-06-03", 201);
    seedBar(db, sec, "2025-06-04", 202);
    // 6/03 already has a price row — should be left alone, not re-inserted
    seedPrice(db, sec, "2025-06-03", 999);

    const result = backfillPricesFromOhlcv(db, {
      securityIds: [sec],
      from: "2025-06-01",
      to: "2025-06-30",
      apply: true,
    });

    expect(result.totals.rowsInserted).toBe(2); // 6/02, 6/04
    expect(result.totals.rowsAlreadyPresent).toBe(1); // 6/03

    const rows = priceRows(db, sec);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.date === "2025-06-02")).toMatchObject({ close_price: 200, source: "tws" });
    expect(rows.find((r) => r.date === "2025-06-04")).toMatchObject({ close_price: 202, source: "tws" });
  });

  it("(b) never overwrites an existing row even when the bar close differs", () => {
    const sec = seedSecurity(db, "AAPL");
    seedBar(db, sec, "2025-06-03", 999); // bar disagrees with the existing price
    seedPrice(db, sec, "2025-06-03", 200, "manual"); // canonical/statement value

    backfillPricesFromOhlcv(db, {
      securityIds: [sec],
      from: "2025-06-01",
      to: "2025-06-30",
      apply: true,
    });

    const rows = priceRows(db, sec);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2025-06-03", close_price: 200, source: "manual" });
  });

  it("(c) respects the [from, to] range", () => {
    const sec = seedSecurity(db, "AAPL");
    seedBar(db, sec, "2025-05-30", 190); // before range
    seedBar(db, sec, "2025-06-15", 200); // in range
    seedBar(db, sec, "2025-07-05", 210); // after range

    const result = backfillPricesFromOhlcv(db, {
      securityIds: [sec],
      from: "2025-06-01",
      to: "2025-06-30",
      apply: true,
    });

    expect(result.totals.rowsInserted).toBe(1);
    const rows = priceRows(db, sec);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2025-06-15");
  });

  it("(d) --account selection picks all securities ever held by the account and only those", () => {
    const held = seedSecurity(db, "HELD");
    const other = seedSecurity(db, "OTHER");
    seedHolding(db, IBKR_ACCOUNT_ID, held, "2025-06-30");
    seedHolding(db, 1, other, "2025-06-30");
    seedBar(db, held, "2025-06-15", 200);
    seedBar(db, other, "2025-06-15", 300);

    const ids = resolveSecurityIds(db, { accountId: IBKR_ACCOUNT_ID });
    const result = backfillPricesFromOhlcv(db, {
      securityIds: ids,
      from: "2025-06-01",
      to: "2025-06-30",
      apply: true,
    });

    expect(result.securities.map((s) => s.securityId).sort((a, b) => a - b)).toEqual([held]);
    expect(priceRows(db, held)).toHaveLength(1);
    expect(priceRows(db, other)).toHaveLength(0); // never touched — not in this account's history
  });

  it("reports 'no bars' for a security with zero 1-day bars in range", () => {
    const sec = seedSecurity(db, "NOBAR");
    // No bars seeded at all.

    const result = backfillPricesFromOhlcv(db, {
      securityIds: [sec],
      from: "2025-06-01",
      to: "2025-06-30",
      apply: true,
    });

    expect(result.securities).toHaveLength(1);
    expect(result.securities[0]).toMatchObject({ securityId: sec, skippedNoBars: true, rowsInserted: 0 });
    expect(result.totals.securitiesSkipped).toBe(1);
    expect(result.totals.securitiesProcessed).toBe(0);
    expect(priceRows(db, sec)).toHaveLength(0);
  });

  it("(e) dry-run (apply: false) writes nothing", () => {
    const sec = seedSecurity(db, "AAPL");
    seedBar(db, sec, "2025-06-02", 200);
    seedBar(db, sec, "2025-06-03", 201);

    const result = backfillPricesFromOhlcv(db, {
      securityIds: [sec],
      from: "2025-06-01",
      to: "2025-06-30",
      apply: false,
    });

    expect(result.totals.rowsInserted).toBe(0); // nothing committed
    expect(result.securities[0].missingCount).toBe(2); // plan still reported
    expect(priceRows(db, sec)).toHaveLength(0);
  });

  it("(f) apply is idempotent — a second run inserts 0", () => {
    const sec = seedSecurity(db, "AAPL");
    seedBar(db, sec, "2025-06-02", 200);
    seedBar(db, sec, "2025-06-03", 201);

    const first = backfillPricesFromOhlcv(db, {
      securityIds: [sec],
      from: "2025-06-01",
      to: "2025-06-30",
      apply: true,
    });
    expect(first.totals.rowsInserted).toBe(2);

    const second = backfillPricesFromOhlcv(db, {
      securityIds: [sec],
      from: "2025-06-01",
      to: "2025-06-30",
      apply: true,
    });
    expect(second.totals.rowsInserted).toBe(0);
    expect(second.totals.rowsAlreadyPresent).toBe(2);
    expect(priceRows(db, sec)).toHaveLength(2);
  });

  it("ignores intraday bar sizes — only '1 day' bars are backfill sources", () => {
    const sec = seedSecurity(db, "INTRADAY");
    seedBar(db, sec, "2025-06-02", 200, "5 mins");

    const result = backfillPricesFromOhlcv(db, {
      securityIds: [sec],
      from: "2025-06-01",
      to: "2025-06-30",
      apply: true,
    });

    expect(result.securities[0].skippedNoBars).toBe(true);
    expect(priceRows(db, sec)).toHaveLength(0);
  });
});

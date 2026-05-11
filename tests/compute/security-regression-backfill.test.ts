import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { backfillSecurityRegressions } from "@/lib/compute/security-regression-backfill";
import { getCachedRegression } from "@/lib/queries/security-regressions";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      security_type TEXT DEFAULT 'stock'
    );

    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      cost_basis REAL,
      as_of_date TEXT NOT NULL,
      source_key TEXT UNIQUE,
      UNIQUE(account_id, security_id, as_of_date)
    );

    CREATE TABLE prices (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT DEFAULT 'test',
      UNIQUE(security_id, date)
    );

    CREATE TABLE benchmark_prices (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'test',
      UNIQUE(symbol, date)
    );

    CREATE TABLE security_regressions (
      security_id INTEGER NOT NULL,
      benchmark_symbol TEXT NOT NULL,
      computed_at_day TEXT NOT NULL,
      beta REAL,
      vol REAL,
      correlation REAL,
      r_squared REAL,
      data_points INTEGER,
      PRIMARY KEY (security_id, benchmark_symbol, computed_at_day)
    );
  `);

  db.prepare(`INSERT INTO accounts (id, name) VALUES (1, 'Test Account')`).run();

  return db;
}

function recentDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * Seed N daily security prices using a deterministic per-day log return.
 * Insert is INSERT OR IGNORE so multiple calls for the same security are safe
 * (e.g. when several benchmarks share one security in a backfill test).
 */
function seedSecurityPrices(
  db: Database.Database,
  securityId: number,
  days: number,
  growthRate = 0.012
): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)`
  );
  let price = 100;
  ins.run(securityId, recentDate(days - 1), price);
  for (let i = 1; i < days; i++) {
    const r = growthRate + 0.005 * Math.sin(i * 0.7);
    price = price * Math.exp(r);
    ins.run(securityId, recentDate(days - 1 - i), price);
  }
}

/**
 * Seed N daily benchmark prices. Independent of any security — one call per
 * benchmark symbol.
 */
function seedBenchmarkPrices(
  db: Database.Database,
  benchmarkSymbol: string,
  days: number,
  growthRate = 0.01
): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO benchmark_prices (symbol, date, close_price) VALUES (?, ?, ?)`
  );
  let price = 100;
  ins.run(benchmarkSymbol, recentDate(days - 1), price);
  for (let i = 1; i < days; i++) {
    const r = growthRate + 0.005 * Math.sin(i * 0.7);
    price = price * Math.exp(r);
    ins.run(benchmarkSymbol, recentDate(days - 1 - i), price);
  }
}

function seedHolding(
  db: Database.Database,
  securityId: number,
  sourceKey: string
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (1, ?, 100, ?, ?)`
  ).run(securityId, recentDate(0), sourceKey);
}

describe("backfillSecurityRegressions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("empty DB (no holdings) → returns zero counts without crashing", () => {
    const summary = backfillSecurityRegressions(db);
    expect(summary).toEqual({
      processed: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("only securities with holdings are processed (orphan security ignored)", () => {
    // Seed two securities — one held, one not.
    db.prepare(`INSERT INTO securities (id, symbol) VALUES (1, 'AAPL')`).run();
    db.prepare(`INSERT INTO securities (id, symbol) VALUES (2, 'MSFT')`).run();
    seedHolding(db, 1, "test:hold:1");
    // Note: no holding for security 2 → must NOT be processed.

    seedSecurityPrices(db, 1, 30);
    seedSecurityPrices(db, 2, 30); // orphan — prove it's still skipped
    seedBenchmarkPrices(db, "SPY", 30);
    seedBenchmarkPrices(db, "QQQ", 30);
    seedBenchmarkPrices(db, "VTI", 30);

    const summary = backfillSecurityRegressions(db);

    // 1 held security × 3 default benchmarks = 3 processed pairs.
    expect(summary.processed).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);

    // Cache populated for security 1, NOT for security 2.
    expect(getCachedRegression(db, 1, "SPY")).not.toBeNull();
    expect(getCachedRegression(db, 1, "QQQ")).not.toBeNull();
    expect(getCachedRegression(db, 1, "VTI")).not.toBeNull();
    expect(getCachedRegression(db, 2, "SPY")).toBeNull();
  });

  it("one security with sufficient prices → succeeded = 3 (one per benchmark)", () => {
    db.prepare(`INSERT INTO securities (id, symbol) VALUES (1, 'AAPL')`).run();
    seedHolding(db, 1, "test:hold:1");
    seedSecurityPrices(db, 1, 30);
    seedBenchmarkPrices(db, "SPY", 30);
    seedBenchmarkPrices(db, "QQQ", 30);
    seedBenchmarkPrices(db, "VTI", 30);

    const summary = backfillSecurityRegressions(db);

    expect(summary.processed).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);

    const spy = getCachedRegression(db, 1, "SPY");
    expect(spy).not.toBeNull();
    expect(spy!.dataPoints).toBeGreaterThanOrEqual(10);
  });

  it("one security with too-few prices → skipped = 3 (insufficient data per benchmark)", () => {
    db.prepare(`INSERT INTO securities (id, symbol) VALUES (1, 'AAPL')`).run();
    seedHolding(db, 1, "test:hold:1");
    // Only 5 days of data — below MIN_DATA_POINTS+1 (=11 prices) threshold.
    seedSecurityPrices(db, 1, 5);
    seedBenchmarkPrices(db, "SPY", 5);
    seedBenchmarkPrices(db, "QQQ", 5);
    seedBenchmarkPrices(db, "VTI", 5);

    const summary = backfillSecurityRegressions(db);

    expect(summary.processed).toBe(3);
    expect(summary.succeeded).toBe(0);
    expect(summary.skipped).toBe(3);
    expect(summary.failed).toBe(0);
  });

  it("missing benchmark in benchmark_prices → skipped, not failed (one bad benchmark doesn't kill the batch)", () => {
    db.prepare(`INSERT INTO securities (id, symbol) VALUES (1, 'AAPL')`).run();
    seedHolding(db, 1, "test:hold:1");
    seedSecurityPrices(db, 1, 30);
    // Seed only SPY benchmark prices — QQQ + VTI absent in benchmark_prices.
    seedBenchmarkPrices(db, "SPY", 30);

    const summary = backfillSecurityRegressions(db, {
      benchmarks: ["SPY", "QQQ", "VTI"],
    });

    expect(summary.processed).toBe(3);
    expect(summary.succeeded).toBe(1); // SPY succeeds
    expect(summary.skipped).toBe(2); // QQQ + VTI return null (no benchmark rows)
    expect(summary.failed).toBe(0);
  });

  it("custom benchmark list overrides default", () => {
    db.prepare(`INSERT INTO securities (id, symbol) VALUES (1, 'AAPL')`).run();
    seedHolding(db, 1, "test:hold:1");
    seedSecurityPrices(db, 1, 30);
    seedBenchmarkPrices(db, "IWM", 30);

    const summary = backfillSecurityRegressions(db, { benchmarks: ["IWM"] });

    expect(summary.processed).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(getCachedRegression(db, 1, "IWM")).not.toBeNull();
  });
});

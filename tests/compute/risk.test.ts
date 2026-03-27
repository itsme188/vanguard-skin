import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeRiskMetrics } from "@/lib/compute/risk";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Minimal schema for risk computation
  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      security_type TEXT DEFAULT 'stock',
      multiplier REAL DEFAULT 1
    );

    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      as_of_date TEXT NOT NULL,
      quantity REAL NOT NULL,
      cost_basis REAL,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (security_id) REFERENCES securities(id)
    );

    CREATE TABLE prices (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT DEFAULT 'test',
      UNIQUE(security_id, date),
      FOREIGN KEY (security_id) REFERENCES securities(id)
    );

    CREATE TABLE daily_valuations (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      valuation_date TEXT NOT NULL,
      cash_balance REAL NOT NULL DEFAULT 0,
      holdings_value REAL NOT NULL DEFAULT 0,
      total_value REAL NOT NULL DEFAULT 0,
      UNIQUE(account_id, valuation_date),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
  `);

  return db;
}

/** Generate a YYYY-MM-DD date string offset by `days` from 2025-01-02. */
function makeDate(days: number): string {
  const y = 2025;
  // Convert to day-of-year starting Jan 2 (day 2)
  let d = 2 + days;
  let m = 0;
  const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  while (d > monthDays[m]) {
    d -= monthDays[m];
    m++;
  }
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function seedDailyValuations(db: Database.Database, values: number[]) {
  db.exec("INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test Account')");

  const stmt = db.prepare(
    "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, 0, ?, ?)"
  );

  for (let i = 0; i < values.length; i++) {
    stmt.run(1, makeDate(i), values[i], values[i]);
  }
}

function seedHoldings(
  db: Database.Database,
  positions: { symbol: string; quantity: number; price: number; type?: string }[]
) {
  if (!db.prepare("SELECT id FROM accounts WHERE id = 1").get()) {
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test Account')");
  }

  const today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    db.prepare("INSERT INTO securities (id, symbol, name, security_type) VALUES (?, ?, ?, ?)").run(
      i + 1,
      p.symbol,
      p.symbol,
      p.type ?? "stock"
    );
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, ?, ?, ?)"
    ).run(i + 1, today, p.quantity);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(
      i + 1,
      today,
      p.price
    );
  }
}

describe("computeRiskMetrics", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns nulls with insufficient data", () => {
    seedDailyValuations(db, [100, 101]);
    const result = computeRiskMetrics(db);
    expect(result.dataPoints).toBe(2);
    expect(result.volatility).toBeNull();
    expect(result.sharpeRatio).toBeNull();
  });

  it("computes max drawdown correctly", () => {
    // Portfolio goes 100 → 120 → 90 → 110 (drawdown = 25% from 120 to 90)
    const values = Array.from({ length: 50 }, (_, i) => {
      if (i <= 10) return 100 + i * 2; // rise to 120
      if (i <= 25) return 120 - (i - 10) * 2; // drop to 90
      return 90 + (i - 25) * 0.8; // recover
    });
    seedDailyValuations(db, values);

    const result = computeRiskMetrics(db);
    expect(result.maxDrawdown).not.toBeNull();
    expect(result.maxDrawdown!.percent).toBeCloseTo(0.25, 2); // 25%
    expect(result.maxDrawdown!.peakValue).toBe(120);
    expect(result.maxDrawdown!.troughValue).toBe(90);
  });

  it("reports no drawdown when values only go up", () => {
    const values = Array.from({ length: 50 }, (_, i) => 100 + i);
    seedDailyValuations(db, values);

    const result = computeRiskMetrics(db);
    expect(result.maxDrawdown).toBeNull();
    expect(result.currentDrawdown).toBeNull();
  });

  it("computes current drawdown when below peak", () => {
    // Rise to 150, then drop to 120
    const values = Array.from({ length: 50 }, (_, i) => {
      if (i <= 30) return 100 + i * (50 / 30);
      return 150 - (i - 30) * 1.5;
    });
    seedDailyValuations(db, values);

    const result = computeRiskMetrics(db);
    expect(result.currentDrawdown).not.toBeNull();
    expect(result.currentDrawdown!.peakValue).toBe(150);
    expect(result.currentDrawdown!.percent).toBeGreaterThan(0);
  });

  it("computes volatility and Sharpe ratio", () => {
    // Generate somewhat volatile series
    const values = Array.from({ length: 100 }, (_, i) => {
      const trend = 100 + i * 0.1;
      const noise = Math.sin(i * 0.5) * 3;
      return trend + noise;
    });
    seedDailyValuations(db, values);

    const result = computeRiskMetrics(db);
    expect(result.volatility).not.toBeNull();
    expect(result.volatility!).toBeGreaterThan(0);
    expect(result.sharpeRatio).not.toBeNull();
  });

  it("computes Herfindahl and top-5 concentration", () => {
    // Create holdings: 50%, 25%, 15%, 5%, 3%, 2%
    seedHoldings(db, [
      { symbol: "AAPL", quantity: 50, price: 100 },  // 50%
      { symbol: "MSFT", quantity: 25, price: 100 },  // 25%
      { symbol: "GOOG", quantity: 15, price: 100 },  // 15%
      { symbol: "AMZN", quantity: 5, price: 100 },   // 5%
      { symbol: "META", quantity: 3, price: 100 },    // 3%
      { symbol: "NVDA", quantity: 2, price: 100 },    // 2%
    ]);
    // Need some daily valuations too for the metrics to compute
    seedDailyValuations(db, Array.from({ length: 50 }, () => 10000));

    const result = computeRiskMetrics(db);
    expect(result.herfindahl).not.toBeNull();
    // Herfindahl = 0.50^2 + 0.25^2 + 0.15^2 + 0.05^2 + 0.03^2 + 0.02^2
    expect(result.herfindahl!).toBeCloseTo(0.3388, 2);
    expect(result.top5Positions).toHaveLength(5);
    expect(result.top5Concentration).toBeCloseTo(0.98, 2);
    expect(result.top5Positions[0].symbol).toBe("AAPL");
    expect(result.positionCount).toBe(6);
  });

  it("handles empty portfolio gracefully", () => {
    const result = computeRiskMetrics(db);
    expect(result.dataPoints).toBe(0);
    expect(result.maxDrawdown).toBeNull();
    expect(result.volatility).toBeNull();
    expect(result.herfindahl).toBeNull();
    expect(result.top5Positions).toHaveLength(0);
  });

  it("respects date range filtering", () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 + i * 0.5);
    seedDailyValuations(db, values);

    const result = computeRiskMetrics(db, { startDate: "2025-02-01", endDate: "2025-03-01" });
    expect(result.dataPoints).toBeLessThan(100);
    expect(result.dataPoints).toBeGreaterThan(0);
  });

  it("respects accountId filtering", () => {
    seedDailyValuations(db, Array.from({ length: 50 }, (_, i) => 100 + i));

    // Add second account
    db.exec("INSERT INTO accounts (id, name) VALUES (2, 'Account 2')");
    const stmt = db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (2, ?, 0, ?, ?)"
    );
    for (let i = 0; i < 50; i++) {
      const date = new Date("2025-01-02");
      date.setDate(date.getDate() + i);
      const val = 50 + i * 2;
      stmt.run(date.toISOString().slice(0, 10), val, val);
    }

    const all = computeRiskMetrics(db);
    const acct1 = computeRiskMetrics(db, { accountId: 1 });
    const acct2 = computeRiskMetrics(db, { accountId: 2 });

    expect(all.dataPoints).toBe(50);
    expect(acct1.dataPoints).toBe(50);
    expect(acct2.dataPoints).toBe(50);
    // Combined values are higher
    expect(all.volatility).not.toEqual(acct1.volatility);
  });
});

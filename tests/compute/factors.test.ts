import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeFactorAnalysis } from "@/lib/compute/factors";

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
      security_type TEXT DEFAULT 'stock',
      multiplier REAL DEFAULT 1,
      sector TEXT,
      fund_category TEXT,
      market_cap_category TEXT,
      style TEXT,
      geography TEXT,
      classification_source TEXT
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

    CREATE TABLE benchmark_prices (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'test',
      UNIQUE(symbol, date)
    );
  `);

  return db;
}

function recentDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

describe("computeFactorAnalysis", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns nulls with no data", () => {
    const result = computeFactorAnalysis(db);
    expect(result.marketRegression).toBeNull();
    expect(result.sizeTilt).toBeNull();
    expect(result.styleTilt).toBeNull();
  });

  it("computes market regression with aligned portfolio and benchmark data", () => {
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // Generate 60 days of aligned data
    for (let i = 59; i >= 0; i--) {
      const date = recentDate(i);
      // Portfolio moves with market but with some tracking error
      const spyPrice = 500 + (59 - i) * 0.5 + Math.sin((59 - i) * 0.3) * 5;
      const portfolioVal = 100000 + (59 - i) * 100 + Math.sin((59 - i) * 0.3) * 800;

      db.prepare("INSERT OR IGNORE INTO benchmark_prices (symbol, date, close_price) VALUES ('SPY', ?, ?)").run(date, spyPrice);
      db.prepare("INSERT OR IGNORE INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (1, ?, 0, ?, ?)").run(date, portfolioVal, portfolioVal);
    }

    const result = computeFactorAnalysis(db);
    expect(result.marketRegression).not.toBeNull();
    const reg = result.marketRegression!;

    expect(reg.beta).toBeGreaterThan(0); // positive market exposure
    expect(reg.rSquared).toBeGreaterThan(0);
    expect(reg.rSquared).toBeLessThanOrEqual(1);
    expect(reg.dataPoints).toBeGreaterThanOrEqual(30);
    expect(reg.correlation).toBeGreaterThan(0);
    expect(typeof reg.alpha).toBe("number");
    expect(typeof reg.trackingError).toBe("number");
  });

  it("computes beta ~1 when portfolio tracks market exactly", () => {
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    for (let i = 59; i >= 0; i--) {
      const date = recentDate(i);
      const price = 500 + (59 - i) * 0.3 + Math.sin((59 - i) * 0.5) * 10;
      // Portfolio = 200 × SPY price (perfectly correlated)
      db.prepare("INSERT OR IGNORE INTO benchmark_prices (symbol, date, close_price) VALUES ('SPY', ?, ?)").run(date, price);
      db.prepare("INSERT OR IGNORE INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (1, ?, 0, ?, ?)").run(date, price * 200, price * 200);
    }

    const result = computeFactorAnalysis(db);
    expect(result.marketRegression).not.toBeNull();
    expect(result.marketRegression!.beta).toBeCloseTo(1.0, 1);
    expect(result.marketRegression!.rSquared).toBeGreaterThan(0.95);
  });

  it("computes size and style tilts from classified securities", () => {
    const today = recentDate(0);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // 3 classified securities
    db.prepare("INSERT INTO securities (id, symbol, name, market_cap_category, style, sector, geography) VALUES (?, ?, ?, ?, ?, ?, ?)").run(1, "AAPL", "Apple", "Large Cap", "Growth", "Technology", "US");
    db.prepare("INSERT INTO securities (id, symbol, name, market_cap_category, style, sector, geography) VALUES (?, ?, ?, ?, ?, ?, ?)").run(2, "VBR", "Small Cap Value", "Small Cap", "Value", "Diversified", "US");
    db.prepare("INSERT INTO securities (id, symbol, name, market_cap_category, style, sector, geography) VALUES (?, ?, ?, ?, ?, ?, ?)").run(3, "VEA", "Developed Markets", "Large Cap", "Blend", "Diversified", "International");

    // Holdings: AAPL 60%, VBR 25%, VEA 15%
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 60)").run(today);
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, 25)").run(today);
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 3, ?, 15)").run(today);

    // All priced at $100
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 100)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 100)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (3, ?, 100)").run(today);

    const result = computeFactorAnalysis(db);

    // Size tilt
    expect(result.sizeTilt).not.toBeNull();
    const largeCap = result.sizeTilt!.buckets.find(b => b.label === "Large Cap");
    const smallCap = result.sizeTilt!.buckets.find(b => b.label === "Small Cap");
    expect(largeCap).toBeDefined();
    expect(largeCap!.weight).toBeCloseTo(0.75, 2); // AAPL(60) + VEA(15) = 75%
    expect(smallCap!.weight).toBeCloseTo(0.25, 2); // VBR = 25%

    // Style tilt
    expect(result.styleTilt).not.toBeNull();
    const growth = result.styleTilt!.buckets.find(b => b.label === "Growth");
    expect(growth!.weight).toBeCloseTo(0.60, 2); // AAPL = 60%

    // Sector
    expect(result.sectorTilt).not.toBeNull();
    const tech = result.sectorTilt!.buckets.find(b => b.label === "Technology");
    expect(tech!.weight).toBeCloseTo(0.60, 2);

    // Geography
    expect(result.geographyTilt).not.toBeNull();
    const us = result.geographyTilt!.buckets.find(b => b.label === "US");
    expect(us!.weight).toBeCloseTo(0.85, 2); // AAPL + VBR = 85%
  });

  it("skips tilts when insufficient classification data", () => {
    const today = recentDate(0);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // Securities with NO classification
    db.prepare("INSERT INTO securities (id, symbol, name) VALUES (1, 'XXX', 'Unknown')").run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 100)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 100)").run(today);

    const result = computeFactorAnalysis(db);
    // With 0% classified, tilts should be null
    expect(result.sizeTilt).toBeNull();
    expect(result.styleTilt).toBeNull();
  });
});

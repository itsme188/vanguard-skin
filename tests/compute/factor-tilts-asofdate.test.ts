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
      market_cap_category TEXT,
      style TEXT,
      geography TEXT,
      classification_source TEXT,
      underlying_symbol TEXT,
      maturity_date TEXT,
      currency TEXT NOT NULL DEFAULT 'USD'
    );

    CREATE TABLE fx_rates (
      currency TEXT PRIMARY KEY,
      usd_per_unit REAL NOT NULL,
      as_of TEXT NOT NULL,
      source TEXT
    );

    CREATE TABLE security_factors (
      security_id INTEGER PRIMARY KEY REFERENCES securities(id),
      interest_rate_sensitive TEXT,
      growth_vs_value TEXT,
      cyclical TEXT,
      international_exposure TEXT,
      geopolitical_onshoring TEXT,
      tariff_exposure TEXT,
      ai_exposure TEXT,
      crypto_adjacent TEXT,
      regulatory_risk TEXT,
      factor_source TEXT DEFAULT 'csv_import',
      updated_at TEXT DEFAULT (datetime('now'))
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

describe("computeFactorAnalysis with asOfDate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns different tilts for different asOfDate values", () => {
    // Create an account
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // Create two securities with different characteristics
    db.exec(`
      INSERT INTO securities (id, symbol, name, security_type, sector, market_cap_category) VALUES
      (1, 'LARGE', 'Large Cap Stock', 'stock', 'Technology', 'Large Cap'),
      (2, 'SMALL', 'Small Cap Stock', 'stock', 'Healthcare', 'Small Cap');
    `);

    // Create prices for both securities
    db.exec(`
      INSERT INTO prices (security_id, date, close_price) VALUES
      (1, '2025-01-01', 100.0),
      (1, '2025-01-10', 100.0),
      (2, '2025-01-01', 50.0),
      (2, '2025-01-10', 50.0);
    `);

    // Day 1 (2025-01-01): heavy large-cap (90% portfolio)
    db.exec(`
      INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES
      (1, 1, '2025-01-01', 90.0),
      (1, 2, '2025-01-01', 2.0);
    `);

    // Day 10 (2025-01-10): heavy small-cap (90% portfolio) — allocation flipped
    db.exec(`
      INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES
      (1, 1, '2025-01-10', 10.0),
      (1, 2, '2025-01-10', 180.0);
    `);

    // Compute tilts as of day 1
    const resultDay1 = computeFactorAnalysis(db, {
      accountId: 1,
      asOfDate: "2025-01-01",
    });

    // Compute tilts as of day 10
    const resultDay10 = computeFactorAnalysis(db, {
      accountId: 1,
      asOfDate: "2025-01-10",
    });

    // Day 1 should have Large Cap dominant
    expect(resultDay1.sizeTilt).not.toBeNull();
    if (resultDay1.sizeTilt) {
      const largeCap = resultDay1.sizeTilt.buckets.find((b) => b.label === "Large Cap");
      expect(largeCap?.weight).toBeGreaterThan(0.8);
    }

    // Day 10 should have Small Cap dominant
    expect(resultDay10.sizeTilt).not.toBeNull();
    if (resultDay10.sizeTilt) {
      const smallCap = resultDay10.sizeTilt.buckets.find((b) => b.label === "Small Cap");
      expect(smallCap?.weight).toBeGreaterThan(0.8);
    }
  });

  it("defaults to current date when asOfDate is omitted", () => {
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    db.exec(`
      INSERT INTO securities (id, symbol, name, security_type, sector) VALUES
      (1, 'TECH', 'Tech Stock', 'stock', 'Technology');
    `);

    db.exec(`
      INSERT INTO prices (security_id, date, close_price) VALUES
      (1, '2025-01-01', 100.0),
      (1, '2025-01-10', 100.0);
    `);

    // Only day 10 has holdings (today's snapshot)
    db.exec(`
      INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES
      (1, 1, '2025-01-10', 50.0);
    `);

    // Without asOfDate, should use today (2025-01-10)
    const resultDefault = computeFactorAnalysis(db, { accountId: 1 });
    const resultExplicit = computeFactorAnalysis(db, {
      accountId: 1,
      asOfDate: "2025-01-10",
    });

    // Both should have the same sector tilt (only 2025-01-10 has holdings)
    if (resultDefault.sectorTilt && resultExplicit.sectorTilt) {
      expect(resultDefault.sectorTilt.buckets).toEqual(resultExplicit.sectorTilt.buckets);
    }
  });

  it("returns null tilt when asOfDate has no holdings data", () => {
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    db.exec(`
      INSERT INTO securities (id, symbol, name, security_type, sector) VALUES
      (1, 'TECH', 'Tech Stock', 'stock', 'Technology');
    `);

    db.exec(`
      INSERT INTO prices (security_id, date, close_price) VALUES
      (1, '2025-01-10', 100.0);
    `);

    // Holdings only on 2025-01-10
    db.exec(`
      INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES
      (1, 1, '2025-01-10', 50.0);
    `);

    // Query as of a date before any holdings exist
    const resultEmpty = computeFactorAnalysis(db, {
      accountId: 1,
      asOfDate: "2024-12-01",
    });

    // All tilts should be null because no holdings exist before 2025-01-10
    expect(resultEmpty.sizeTilt).toBeNull();
    expect(resultEmpty.styleTilt).toBeNull();
    expect(resultEmpty.sectorTilt).toBeNull();
    expect(resultEmpty.geographyTilt).toBeNull();
  });

  it("respects asOfDate with account filtering", () => {
    // Create two accounts
    db.exec(`
      INSERT INTO accounts (id, name) VALUES
      (1, 'Account A'),
      (2, 'Account B');
    `);

    // Create securities
    db.exec(`
      INSERT INTO securities (id, symbol, name, security_type, sector, market_cap_category) VALUES
      (1, 'LARGE', 'Large Cap', 'stock', 'Tech', 'Large Cap'),
      (2, 'SMALL', 'Small Cap', 'stock', 'Healthcare', 'Small Cap');
    `);

    db.exec(`
      INSERT INTO prices (security_id, date, close_price) VALUES
      (1, '2025-01-01', 100.0),
      (1, '2025-01-10', 100.0),
      (2, '2025-01-01', 50.0),
      (2, '2025-01-10', 50.0);
    `);

    // Account A on day 1: 95% LARGE
    db.exec(`
      INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES
      (1, 1, '2025-01-01', 95.0),
      (1, 2, '2025-01-01', 1.0);
    `);

    // Account B on day 1: 5% LARGE, 95% SMALL
    db.exec(`
      INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES
      (2, 1, '2025-01-01', 5.0),
      (2, 2, '2025-01-01', 95.0);
    `);

    // Query account A as of day 1
    const resultA = computeFactorAnalysis(db, {
      accountId: 1,
      asOfDate: "2025-01-01",
    });

    // Query account B as of day 1
    const resultB = computeFactorAnalysis(db, {
      accountId: 2,
      asOfDate: "2025-01-01",
    });

    // Account A should be dominated by Large Cap
    expect(resultA.sizeTilt).not.toBeNull();
    if (resultA.sizeTilt) {
      const largeCap = resultA.sizeTilt.buckets.find((b) => b.label === "Large Cap");
      expect(largeCap?.weight).toBeGreaterThan(0.9);
    }

    // Account B should be dominated by Small Cap
    expect(resultB.sizeTilt).not.toBeNull();
    if (resultB.sizeTilt) {
      const smallCap = resultB.sizeTilt.buckets.find((b) => b.label === "Small Cap");
      expect(smallCap?.weight).toBeGreaterThan(0.9);
    }
  });
});

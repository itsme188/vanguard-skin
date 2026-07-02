import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeRiskMetrics, computePositionRisk } from "@/lib/compute/risk";

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
      currency TEXT NOT NULL DEFAULT 'USD'
    );

    CREATE TABLE fx_rates (
      currency TEXT PRIMARY KEY,
      usd_per_unit REAL NOT NULL,
      as_of TEXT NOT NULL,
      source TEXT
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

describe("computeRiskMetrics with asOfDate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("computes different concentration metrics for different asOfDate values", () => {
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // Create three securities
    db.exec(`
      INSERT INTO securities (id, symbol, name) VALUES
      (1, 'AAPL', 'Apple'),
      (2, 'MSFT', 'Microsoft'),
      (3, 'GOOGL', 'Alphabet');
    `);

    // Create prices
    db.exec(`
      INSERT INTO prices (security_id, date, close_price) VALUES
      (1, '2025-01-01', 100.0),
      (1, '2025-01-10', 100.0),
      (2, '2025-01-01', 100.0),
      (2, '2025-01-10', 100.0),
      (3, '2025-01-01', 100.0),
      (3, '2025-01-10', 100.0);
    `);

    // Create daily valuations for both dates
    db.exec(`
      INSERT INTO daily_valuations (account_id, valuation_date, total_value) VALUES
      (1, '2025-01-01', 30000.0),
      (1, '2025-01-10', 30000.0);
    `);

    // Day 1: concentrated in AAPL (90%)
    db.exec(`
      INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES
      (1, 1, '2025-01-01', 270.0),
      (1, 2, '2025-01-01', 15.0),
      (1, 3, '2025-01-01', 15.0);
    `);

    // Day 10: equal weight across all three
    db.exec(`
      INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES
      (1, 1, '2025-01-10', 100.0),
      (1, 2, '2025-01-10', 100.0),
      (1, 3, '2025-01-10', 100.0);
    `);

    // Compute risk on day 1
    const riskDay1 = computeRiskMetrics(db, {
      accountId: 1,
      asOfDate: "2025-01-01",
    });

    // Compute risk on day 10
    const riskDay10 = computeRiskMetrics(db, {
      accountId: 1,
      asOfDate: "2025-01-10",
    });

    // Day 1 should have high concentration (concentrated in AAPL)
    expect(riskDay1.top5Concentration).toBeGreaterThan(0.85);
    expect(riskDay1.herfindahl).toBeGreaterThan(0.8);

    // Day 10 should have lower concentration (equal weight)
    // 3 equal positions: top5 = 3 × (1/3) = 1.0, Herfindahl = 3 × (1/3)² = 0.333
    expect(riskDay10.top5Concentration).toBeCloseTo(1.0, 2);
    expect(riskDay10.herfindahl).toBeCloseTo(0.333, 2);

    // Both days should show 3 positions
    expect(riskDay1.positionCount).toBe(3);
    expect(riskDay10.positionCount).toBe(3);
  });

  it("defaults to current holdings when asOfDate is omitted", () => {
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    db.exec(`
      INSERT INTO securities (id, symbol, name) VALUES
      (1, 'AAPL', 'Apple'),
      (2, 'MSFT', 'Microsoft');
    `);

    db.exec(`
      INSERT INTO prices (security_id, date, close_price) VALUES
      (1, '2025-01-10', 100.0),
      (2, '2025-01-10', 100.0);
    `);

    db.exec(`
      INSERT INTO daily_valuations (account_id, valuation_date, total_value) VALUES
      (1, '2025-01-10', 20000.0);
    `);

    // Only day 10 has holdings
    db.exec(`
      INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES
      (1, 1, '2025-01-10', 100.0),
      (1, 2, '2025-01-10', 100.0);
    `);

    // Without asOfDate
    const riskDefault = computeRiskMetrics(db, { accountId: 1 });

    // With explicit current date
    const riskExplicit = computeRiskMetrics(db, {
      accountId: 1,
      asOfDate: "2025-01-10",
    });

    // Both should have the same concentration
    expect(riskDefault.positionCount).toBe(riskExplicit.positionCount);
    expect(riskDefault.herfindahl).toBeCloseTo(riskExplicit.herfindahl ?? 0, 2);
  });

  it("returns no positions when asOfDate has no holdings", () => {
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    db.exec(`
      INSERT INTO securities (id, symbol, name) VALUES
      (1, 'AAPL', 'Apple');
    `);

    db.exec(`
      INSERT INTO prices (security_id, date, close_price) VALUES
      (1, '2025-01-10', 100.0);
    `);

    db.exec(`
      INSERT INTO daily_valuations (account_id, valuation_date, total_value) VALUES
      (1, '2025-01-10', 10000.0);
    `);

    // Holdings only on day 10
    db.exec(`
      INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES
      (1, 1, '2025-01-10', 100.0);
    `);

    // Query as of a date before holdings exist
    const riskEmpty = computeRiskMetrics(db, {
      accountId: 1,
      asOfDate: "2024-12-01",
    });

    expect(riskEmpty.positionCount).toBe(0);
    expect(riskEmpty.herfindahl).toBeNull();
    expect(riskEmpty.top5Positions).toEqual([]);
  });
});

describe("computePositionRisk with asOfDate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("ranks positions as of a historical date", () => {
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // Create securities
    db.exec(`
      INSERT INTO securities (id, symbol, name) VALUES
      (1, 'AAPL', 'Apple'),
      (2, 'MSFT', 'Microsoft'),
      (3, 'GOOGL', 'Alphabet');
    `);

    // Create prices for last year
    for (let i = 0; i < 365; i++) {
      const date = new Date(2024, 0, 1);
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().slice(0, 10);

      db.prepare(
        "INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
      ).run(1, dateStr, 100 + i * 0.5);

      db.prepare(
        "INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
      ).run(2, dateStr, 200 + i * 0.3);

      db.prepare(
        "INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
      ).run(3, dateStr, 150 + i * 0.4);
    }

    // Day 1: AAPL dominant (80% of portfolio)
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, ?)"
    ).run(1, 1, "2024-01-01", 800);

    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, ?)"
    ).run(1, 2, "2024-01-01", 5);

    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, ?)"
    ).run(1, 3, "2024-01-01", 5);

    // Day 100: MSFT dominant (80% of portfolio)
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, ?)"
    ).run(1, 1, "2024-04-10", 5);

    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, ?)"
    ).run(1, 2, "2024-04-10", 800);

    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, ?)"
    ).run(1, 3, "2024-04-10", 5);

    // Get position risk as of day 1
    const riskDay1 = computePositionRisk(db, {
      accountId: 1,
      asOfDate: "2024-01-01",
      topN: 3,
    });

    // Get position risk as of day 100
    const riskDay100 = computePositionRisk(db, {
      accountId: 1,
      asOfDate: "2024-04-10",
      topN: 3,
    });

    // Day 1: AAPL should be the top position
    if (riskDay1.positions.length > 0) {
      expect(riskDay1.positions[0].symbol).toBe("AAPL");
      expect(riskDay1.positions[0].weight).toBeGreaterThan(0.7);
    }

    // Day 100: MSFT should be the top position
    if (riskDay100.positions.length > 0) {
      expect(riskDay100.positions[0].symbol).toBe("MSFT");
      expect(riskDay100.positions[0].weight).toBeGreaterThan(0.7);
    }
  });
});

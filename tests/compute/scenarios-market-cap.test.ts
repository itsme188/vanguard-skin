// tests/compute/scenarios-market-cap.test.ts
//
// Pins the size-beta uplift in estimateBeta (lib/compute/scenarios.ts) against
// the market_cap_category vocabulary fragmentation
// [qa:analysis-market-cap--duplicate-size-buckets-and-tilts]: the Claude
// classification fallback still writes bare cap-size labels
// ("Large"/"Mid"/"Small") while every other source writes the canonical
// "X Cap" scheme (normalizeMarketCapCategory,
// lib/securities/normalize-market-cap.ts). Before this fix, estimateBeta
// exact-string-matched only the canonical "Small Cap"/"Mid Cap" labels, so a
// legacy bare "Small"/"Mid" row silently got NO size-beta uplift and scenario
// P&L understated the shock for that position.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeScenario, type ScenarioDefinition } from "@/lib/compute/scenarios";

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
      industry TEXT,
      geography TEXT,
      market_cap_category TEXT,
      style TEXT,
      duration_years REAL,
      credit_rating TEXT,
      underlying_symbol TEXT,
      strike_price REAL,
      expiration_date TEXT,
      option_type TEXT,
      fund_category TEXT,
      currency TEXT NOT NULL DEFAULT 'USD'
    );

    CREATE TABLE fx_rates (
      currency TEXT PRIMARY KEY,
      usd_per_unit REAL NOT NULL,
      as_of TEXT NOT NULL,
      source TEXT
    );

    CREATE TABLE security_quotes (
      security_id INTEGER PRIMARY KEY,
      as_of_date TEXT NOT NULL,
      iv_underlying REAL,
      hv_30d REAL,
      week52_high REAL,
      week52_low REAL,
      dividend_yield REAL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE security_factors (
      security_id INTEGER PRIMARY KEY,
      interest_rate_sensitive TEXT,
      growth_vs_value TEXT,
      cyclical TEXT,
      international_exposure TEXT,
      geopolitical_onshoring TEXT,
      tariff_exposure TEXT,
      ai_exposure TEXT,
      crypto_adjacent TEXT,
      regulatory_risk TEXT
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
  `);

  return db;
}

/**
 * Four stocks spanning the market_cap_category vocabulary: canonical
 * "Small Cap"/"Mid Cap", the bare legacy synonyms "Small"/"Mid", plus a
 * true-NULL and literal-string-"null" control (neither should ever get a
 * size-beta uplift). Same price/quantity ($1000 each) so every row's
 * pre-shock value is identical and changePercent is directly comparable.
 */
function seedMarketCapFixture(db: Database.Database) {
  const today = new Date().toISOString().slice(0, 10);
  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

  const rows: { id: number; symbol: string; marketCap: string | null }[] = [
    { id: 1, symbol: "SMLB", marketCap: "Small Cap" },
    { id: 2, symbol: "SMLA", marketCap: "Small" },
    { id: 3, symbol: "MIDB", marketCap: "Mid Cap" },
    { id: 4, symbol: "MIDA", marketCap: "Mid" },
    { id: 5, symbol: "NULV", marketCap: null },
    { id: 6, symbol: "NULS", marketCap: "null" },
  ];

  for (const row of rows) {
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, market_cap_category) VALUES (?, ?, ?, 'stock', ?)"
    ).run(row.id, row.symbol, `${row.symbol} Inc`, row.marketCap);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, ?, ?, 100)"
    ).run(row.id, today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, 10)").run(row.id, today);
  }
}

const CUSTOM_CORRECTION: ScenarioDefinition = {
  id: "custom-market-cap-correction",
  name: "Custom Correction",
  description: "test",
  category: "custom",
  marketMove: -0.1,
};

describe("estimateBeta size adjustment normalizes market_cap_category vocabulary", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedMarketCapFixture(db);
  });

  it("a legacy bare 'Small' row gets the SAME size-beta uplift as canonical 'Small Cap'", () => {
    const result = computeScenario(db, CUSTOM_CORRECTION);
    const canonical = result.positionImpacts.find((p) => p.symbol === "SMLB")!;
    const legacy = result.positionImpacts.find((p) => p.symbol === "SMLA")!;

    expect(canonical.changePercent).toBeCloseTo(-0.115, 6); // -0.10 * 1.15
    expect(legacy.changePercent).toBeCloseTo(-0.115, 6);
    expect(legacy.changePercent).toBeCloseTo(canonical.changePercent, 10);
  });

  it("a legacy bare 'Mid' row gets the SAME size-beta uplift as canonical 'Mid Cap'", () => {
    const result = computeScenario(db, CUSTOM_CORRECTION);
    const canonical = result.positionImpacts.find((p) => p.symbol === "MIDB")!;
    const legacy = result.positionImpacts.find((p) => p.symbol === "MIDA")!;

    expect(canonical.changePercent).toBeCloseTo(-0.105, 6); // -0.10 * 1.05
    expect(legacy.changePercent).toBeCloseTo(-0.105, 6);
    expect(legacy.changePercent).toBeCloseTo(canonical.changePercent, 10);
  });

  it("NULL and the literal string 'null' never get a size-beta uplift (beta stays 1.0)", () => {
    const result = computeScenario(db, CUSTOM_CORRECTION);
    const nullRow = result.positionImpacts.find((p) => p.symbol === "NULV")!;
    const literalNullRow = result.positionImpacts.find((p) => p.symbol === "NULS")!;

    expect(nullRow.changePercent).toBeCloseTo(-0.1, 6);
    expect(literalNullRow.changePercent).toBeCloseTo(-0.1, 6);
  });
});

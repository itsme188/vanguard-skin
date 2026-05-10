import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeScenario, computeAllScenarios, PRESET_SCENARIOS } from "@/lib/compute/scenarios";

/**
 * P2 (2026-05-10): legacy beta-heuristic preset scenarios were replaced
 * with 8 factor-anchored recipes in scenario-recipes.ts. These tests cover
 * the public surface (PRESET_SCENARIOS, computeScenario, computeAllScenarios)
 * + the legacy custom-scenario path that still flows through beta heuristics
 * when scenario.id is not a recipe id.
 *
 * Recipe-specific behavior is exhaustively tested in scenario-recipes.test.ts.
 */

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
      duration_years REAL,
      credit_rating TEXT
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

function seedPortfolio(db: Database.Database) {
  const today = new Date().toISOString().slice(0, 10);
  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

  // AAPL: Tech, AI High, Growth, Tariff Moderate
  db.prepare("INSERT INTO securities (id, symbol, name, security_type, sector, style, market_cap_category) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    1, "AAPL", "Apple", "stock", "Technology", "Growth", "Large Cap"
  );
  db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 400)").run(today);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 150)").run(today);
  db.prepare(`INSERT INTO security_factors (security_id, ai_exposure, growth_vs_value, tariff_exposure, cyclical) VALUES (1, 'High', 'Growth', 'Moderate', 'Moderate')`).run();

  // DUK: Utilities, no AI, Value, Defensive
  db.prepare("INSERT INTO securities (id, symbol, name, security_type, sector, style, market_cap_category) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    2, "DUK", "Duke Energy", "stock", "Utilities", "Value", "Large Cap"
  );
  db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, 300)").run(today);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 100)").run(today);
  db.prepare(`INSERT INTO security_factors (security_id, ai_exposure, growth_vs_value, cyclical, interest_rate_sensitive) VALUES (2, 'No', 'Value', 'Defensive', 'Moderate')`).run();

  // Bond ($10K, 5y duration)
  db.prepare("INSERT INTO securities (id, symbol, name, security_type, duration_years) VALUES (?, ?, ?, ?, ?)").run(
    3, "BND", "Total Bond", "bond", 5.0
  );
  db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 3, ?, 100)").run(today);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (3, ?, 10000)").run(today);
  db.prepare(`INSERT INTO security_factors (security_id, interest_rate_sensitive) VALUES (3, 'High')`).run();
}

describe("computeScenario via recipe dispatch", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns zero impact with no holdings", () => {
    const scenario = PRESET_SCENARIOS[0];
    const result = computeScenario(db, scenario);
    expect(result.currentPortfolioValue).toBe(0);
    expect(result.estimatedChange).toBe(0);
    expect(result.positionImpacts).toHaveLength(0);
  });

  it("ai_capex_pause hits AAPL (High AI), leaves DUK (No AI) flat", () => {
    seedPortfolio(db);
    const scenario = PRESET_SCENARIOS.find((s) => s.id === "ai_capex_pause")!;
    const result = computeScenario(db, scenario);
    const aapl = result.positionImpacts.find((p) => p.symbol === "AAPL")!;
    const duk = result.positionImpacts.find((p) => p.symbol === "DUK")!;
    expect(aapl.changePercent).toBeLessThan(0);
    expect(duk.changePercent).toBeCloseTo(0, 4);
  });

  it("rate_shock_up_25bp hits the bond by duration", () => {
    seedPortfolio(db);
    const scenario = PRESET_SCENARIOS.find((s) => s.id === "rate_shock_up_25bp")!;
    const result = computeScenario(db, scenario);
    const bnd = result.positionImpacts.find((p) => p.symbol === "BND")!;
    // 5y duration × 25bp = 125bp = -1.25%
    expect(bnd.changePercent).toBeCloseTo(-0.0125, 4);
  });

  it("identifies biggest losers ordered by estimatedChange ascending", () => {
    seedPortfolio(db);
    const scenario = PRESET_SCENARIOS.find((s) => s.id === "ai_capex_pause")!;
    const result = computeScenario(db, scenario);
    if (result.biggestLosers.length >= 2) {
      expect(result.biggestLosers[0].estimatedChange).toBeLessThanOrEqual(
        result.biggestLosers[1].estimatedChange
      );
    }
  });
});

describe("computeAllScenarios", () => {
  it("returns results for all 8 recipes", () => {
    const db = createTestDb();
    seedPortfolio(db);
    const results = computeAllScenarios(db);
    expect(results).toHaveLength(8);
    expect(results).toHaveLength(PRESET_SCENARIOS.length);
    for (const result of results) {
      expect(result.scenario).toBeDefined();
      expect(result.currentPortfolioValue).toBeGreaterThan(0);
    }
  });
});

describe("legacy custom-scenario path (non-recipe ids flow through beta heuristic)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedPortfolio(db);
  });

  it("applies marketMove × beta for custom scenarios", () => {
    const customCorrection = {
      id: "custom-correction",
      name: "Custom Correction",
      description: "test",
      category: "custom" as const,
      marketMove: -0.10,
    };
    const result = computeScenario(db, customCorrection);
    expect(result.estimatedChangePercent).toBeLessThan(0);
    expect(result.positionImpacts).toHaveLength(3);
  });

  it("custom sector overrides take precedence over market move", () => {
    const customSector = {
      id: "custom-sector",
      name: "Custom Sector",
      description: "test",
      category: "sector" as const,
      marketMove: -0.03,
      sectorMoves: { Technology: -0.25 },
    };
    const result = computeScenario(db, customSector);
    const aapl = result.positionImpacts.find((p) => p.symbol === "AAPL")!;
    // AAPL gets the -25% sector hit × its estimated beta (heuristic path)
    expect(aapl.changePercent).toBeLessThan(-0.2);
  });

  it("custom rate scenarios use duration for bonds", () => {
    const customRate = {
      id: "custom-rate",
      name: "Custom Rate",
      description: "test",
      category: "rate" as const,
      marketMove: -0.05,
      rateMove: 100,
    };
    const result = computeScenario(db, customRate);
    const bnd = result.positionImpacts.find((p) => p.symbol === "BND")!;
    // 5y duration × 1% rate move = -5%
    expect(bnd.changePercent).toBeCloseTo(-0.05, 2);
  });
});

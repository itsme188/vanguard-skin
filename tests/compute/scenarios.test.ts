import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeScenario, computeAllScenarios, PRESET_SCENARIOS } from "@/lib/compute/scenarios";

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

  // Tech growth stock ($60K)
  db.prepare("INSERT INTO securities (id, symbol, name, security_type, sector, style, market_cap_category) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    1, "AAPL", "Apple", "stock", "Technology", "Growth", "Large Cap"
  );
  db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 400)").run(today);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 150)").run(today);

  // Utility value stock ($30K)
  db.prepare("INSERT INTO securities (id, symbol, name, security_type, sector, style, market_cap_category) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    2, "DUK", "Duke Energy", "stock", "Utilities", "Value", "Large Cap"
  );
  db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, 300)").run(today);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 100)").run(today);

  // Bond ($10K)
  db.prepare("INSERT INTO securities (id, symbol, name, security_type) VALUES (?, ?, ?, ?)").run(
    3, "BND", "Total Bond", "bond"
  );
  db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 3, ?, 100)").run(today);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (3, ?, 100)").run(today); // bond: 100 * 100 / 100 = $100... need to adjust
  // Bond value = qty * price / 100 = 100 * 100 / 100 = $100. Let's make it $10K
  db.prepare("UPDATE prices SET close_price = 10000 WHERE security_id = 3").run();
  // 100 qty * 10000 / 100 = $10,000
}

describe("computeScenario", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns zero impact with no holdings", () => {
    const scenario = PRESET_SCENARIOS[0]; // correction -10%
    const result = computeScenario(db, scenario);
    expect(result.currentPortfolioValue).toBe(0);
    expect(result.estimatedChange).toBe(0);
    expect(result.positionImpacts).toHaveLength(0);
  });

  it("computes market correction impact", () => {
    seedPortfolio(db);
    const scenario = PRESET_SCENARIOS.find(s => s.id === "correction")!;
    const result = computeScenario(db, scenario);

    // Portfolio: AAPL $60K + DUK $30K + BND $10K = $100K
    expect(result.currentPortfolioValue).toBeCloseTo(100000, -2);
    // All positions should lose value in a correction
    expect(result.estimatedChange).toBeLessThan(0);
    expect(result.estimatedChangePercent).toBeLessThan(0);
    expect(result.positionImpacts).toHaveLength(3);
  });

  it("applies higher beta to tech/growth stocks", () => {
    seedPortfolio(db);
    const scenario = PRESET_SCENARIOS.find(s => s.id === "correction")!;
    const result = computeScenario(db, scenario);

    const aapl = result.positionImpacts.find(p => p.symbol === "AAPL")!;
    const duk = result.positionImpacts.find(p => p.symbol === "DUK")!;

    // AAPL (tech, growth) should have higher beta than DUK (utility, value)
    expect(aapl.beta).toBeGreaterThan(duk.beta);
    // AAPL should lose more % than DUK
    expect(Math.abs(aapl.changePercent)).toBeGreaterThan(Math.abs(duk.changePercent));
  });

  it("treats bonds differently in rate scenarios", () => {
    seedPortfolio(db);
    const scenario = PRESET_SCENARIOS.find(s => s.id === "rate100")!;
    const result = computeScenario(db, scenario);

    const bnd = result.positionImpacts.find(p => p.symbol === "BND")!;
    // Bonds should lose value in rate rise
    expect(bnd.estimatedChange).toBeLessThan(0);
    expect(bnd.changePercent).toBeLessThan(0);
  });

  it("computes bull rally as positive", () => {
    seedPortfolio(db);
    const scenario = PRESET_SCENARIOS.find(s => s.id === "rally")!;
    const result = computeScenario(db, scenario);

    expect(result.estimatedChange).toBeGreaterThan(0);
    expect(result.estimatedChangePercent).toBeGreaterThan(0);
  });

  it("identifies biggest losers and winners", () => {
    seedPortfolio(db);
    const scenario = PRESET_SCENARIOS.find(s => s.id === "correction")!;
    const result = computeScenario(db, scenario);

    // In a correction, all positions lose, so biggest losers should exist
    expect(result.biggestLosers.length).toBeGreaterThan(0);
    // Losers sorted by most negative first
    if (result.biggestLosers.length >= 2) {
      expect(result.biggestLosers[0].estimatedChange).toBeLessThanOrEqual(
        result.biggestLosers[1].estimatedChange
      );
    }
  });
});

describe("computeAllScenarios", () => {
  it("returns results for all preset scenarios", () => {
    const db = createTestDb();
    seedPortfolio(db);
    const results = computeAllScenarios(db);
    expect(results).toHaveLength(PRESET_SCENARIOS.length);
    for (const result of results) {
      expect(result.scenario).toBeDefined();
      expect(result.currentPortfolioValue).toBeGreaterThan(0);
    }
  });
});

describe("sector rotation scenarios", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedPortfolio(db);
  });

  it("applies sector-specific moves to matching positions", () => {
    const scenario = PRESET_SCENARIOS.find((s) => s.id === "tech_selloff")!;
    expect(scenario).toBeDefined();
    const result = computeScenario(db, scenario);

    const aapl = result.positionImpacts.find((p) => p.symbol === "AAPL")!;
    const duk = result.positionImpacts.find((p) => p.symbol === "DUK")!;

    // AAPL is Technology — should get the -25% sector move (× beta)
    expect(aapl.changePercent).toBeLessThan(-0.2);
    // DUK is Utilities — not in sectorMoves, gets marketMove (-3%) × beta
    expect(duk.changePercent).toBeCloseTo(-0.03 * duk.beta, 2);
  });

  it("defensive rotation benefits utilities, hurts tech", () => {
    const scenario = PRESET_SCENARIOS.find(
      (s) => s.id === "defensive_rotation"
    )!;
    const result = computeScenario(db, scenario);

    const aapl = result.positionImpacts.find((p) => p.symbol === "AAPL")!;
    const duk = result.positionImpacts.find((p) => p.symbol === "DUK")!;

    // Tech should lose value
    expect(aapl.estimatedChange).toBeLessThan(0);
    // Utilities should gain value
    expect(duk.estimatedChange).toBeGreaterThan(0);
  });

  it("energy spike benefits energy sector", () => {
    const scenario = PRESET_SCENARIOS.find((s) => s.id === "energy_spike")!;
    const result = computeScenario(db, scenario);

    // No energy positions in test portfolio, so all get marketMove
    // DUK (Utilities) gets -8% sector override, AAPL (Tech) gets default -5%
    const duk = result.positionImpacts.find((p) => p.symbol === "DUK")!;
    expect(duk.changePercent).toBeLessThan(-0.05);
  });
});

describe("duration-aware rate impact", () => {
  it("uses actual duration_years when available for bonds", () => {
    const db = createTestDb();
    const today = new Date().toISOString().slice(0, 10);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // Short-duration bond (2 years)
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, duration_years) VALUES (?, ?, ?, ?, ?)"
    ).run(1, "SHY", "Short Treasury", "bond", 2.0);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 100)"
    ).run(today);
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 10000)"
    ).run(today);

    // Long-duration bond (15 years)
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, duration_years) VALUES (?, ?, ?, ?, ?)"
    ).run(2, "TLT", "Long Treasury", "bond", 15.0);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, 100)"
    ).run(today);
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 10000)"
    ).run(today);

    const scenario = PRESET_SCENARIOS.find((s) => s.id === "rate100")!;
    const result = computeScenario(db, scenario);

    const shy = result.positionImpacts.find((p) => p.symbol === "SHY")!;
    const tlt = result.positionImpacts.find((p) => p.symbol === "TLT")!;

    // Long-duration bond should lose much more than short-duration
    expect(Math.abs(tlt.changePercent)).toBeGreaterThan(
      Math.abs(shy.changePercent)
    );
    // SHY: -2 * 1/100 = -0.02 (-2%)
    expect(shy.changePercent).toBeCloseTo(-0.02, 2);
    // TLT: -15 * 1/100 = -0.15 (-15%)
    expect(tlt.changePercent).toBeCloseTo(-0.15, 2);
  });
});

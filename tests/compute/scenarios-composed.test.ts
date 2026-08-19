import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeScenario, type ScenarioDefinition } from "@/lib/compute/scenarios";

/**
 * QA fix (2026-08-18): the legacy custom-scenario path in scenarios.ts
 * (findRecipe misses → the beta-heuristic branch) previously:
 *   (1) let unclamped linear duration (-duration * rateChange / 100) produce
 *       bond losses >100% and negative estimatedNewValue,
 *   (2) switched the WHOLE model on scenario.category (rate path vs. beta
 *       path) instead of adding a rate term — non-monotonic: a rate hike on
 *       top of a market-crash custom scenario could SHRINK the modelled loss,
 *   (3) silently dropped scenario.rateMove whenever sectorMoves was present
 *       (route sets category:'sector', and the sector branch never looked at
 *       rateMove) even though the description still mentioned the rate move.
 *
 * Fixed model: changePercent = marketLeg + rateLeg, computed independently,
 * then clamped at -100% for longs AND shorts alike — the underlying can't
 * fall below zero, and a short's direction is already carried by its
 * negative market_value. See the composition block in scenarios.ts.
 *
 * Same in-memory SQLite + DI setup as tests/compute/scenarios.test.ts.
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

const today = () => new Date().toISOString().slice(0, 10);

function seedBond(
  db: Database.Database,
  opts: { id: number; symbol: string; duration: number; quantity?: number; price?: number }
) {
  db.prepare(
    "INSERT INTO securities (id, symbol, name, security_type, duration_years) VALUES (?, ?, ?, 'bond', ?)"
  ).run(opts.id, opts.symbol, opts.symbol, opts.duration);
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, ?, ?, ?)"
  ).run(opts.id, today(), opts.quantity ?? 100);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(
    opts.id,
    today(),
    opts.price ?? 10000
  );
}

describe("additive shock composition — bond convexity clamp (QA-1)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
  });

  it("a +300bp shock on a 20y-duration bond never exceeds -100% and estimatedNewValue stays positive", () => {
    seedBond(db, { id: 1, symbol: "LTB", duration: 20 });
    const scenario: ScenarioDefinition = {
      id: "custom-duration-300",
      name: "Custom",
      description: "test",
      category: "custom",
      marketMove: 0,
      rateMove: 300,
    };
    const result = computeScenario(db, scenario);
    const bond = result.positionImpacts.find((p) => p.symbol === "LTB")!;

    // exp(-20 * 0.03) - 1 ≈ -0.45119 (convexity-aware, not the old linear
    // -duration*rateChange/100 = -0.60 which would already exceed -100%
    // once duration or rateMove get large).
    expect(bond.changePercent).toBeCloseTo(Math.exp(-20 * 0.03) - 1, 5);
    expect(bond.changePercent).toBeGreaterThan(-1);
    expect(bond.estimatedNewValue).toBeGreaterThan(0);
  });

  it("a pathological +2000bp shock on the same bond still never reaches -100%", () => {
    seedBond(db, { id: 1, symbol: "LTB", duration: 20 });
    const scenario: ScenarioDefinition = {
      id: "custom-duration-2000",
      name: "Custom",
      description: "test",
      category: "custom",
      marketMove: 0,
      rateMove: 2000,
    };
    const result = computeScenario(db, scenario);
    const bond = result.positionImpacts.find((p) => p.symbol === "LTB")!;

    expect(bond.changePercent).toBeCloseTo(Math.exp(-20 * 0.2) - 1, 5);
    expect(bond.changePercent).toBeGreaterThan(-1);
    expect(bond.estimatedNewValue).toBeGreaterThan(0);
  });
});

describe("additive shock composition — monotonicity (QA-2)", () => {
  it("bigger rate hikes never shrink the modelled loss for a fixed market crash", () => {
    const db = createTestDb();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
    seedBond(db, { id: 1, symbol: "BND", duration: 7 });
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, sector) VALUES (2, 'AAPL', 'Apple', 'stock', 'Technology')"
    ).run();
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, 100)"
    ).run(today());
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 150)").run(today());

    const totals = [0, 100, 200, 300].map((rateMove) => {
      const scenario: ScenarioDefinition = {
        id: `custom-mono-${rateMove}`,
        name: "Custom",
        description: "test",
        category: "custom",
        marketMove: -0.10,
        rateMove,
      };
      return computeScenario(db, scenario).estimatedChangePercent;
    });

    // Non-increasing: each additional 100bp of hike makes the total loss the
    // same or worse, never better — the old category-switch model could flip
    // this because a "rate" category discarded the market-crash beta term.
    for (let i = 1; i < totals.length; i++) {
      expect(totals[i]).toBeLessThanOrEqual(totals[i - 1] + 1e-9);
    }
    // And it must actually move (not just be flat/constant).
    expect(totals[3]).toBeLessThan(totals[0]);
  });
});

describe("additive shock composition — sector override + rateMove compose (QA-3)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, sector) VALUES (1, 'AAPL', 'Apple', 'stock', 'Technology')"
    ).run();
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 100)"
    ).run(today());
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 150)").run(today());
    seedBond(db, { id: 2, symbol: "BND", duration: 5 });
  });

  it("applies the sector override to equities AND the rate leg to bonds in the same run", () => {
    const scenario: ScenarioDefinition = {
      id: "custom-sector-rate",
      name: "Custom",
      description: "test",
      category: "sector",
      marketMove: -0.03,
      rateMove: 200,
      sectorMoves: { Technology: -0.20 },
    };
    const result = computeScenario(db, scenario);
    const aapl = result.positionImpacts.find((p) => p.symbol === "AAPL")!;
    const bond = result.positionImpacts.find((p) => p.symbol === "BND")!;

    // AAPL: Technology beta 1.0 * 1.15 (highBetaSectors) = 1.15; sector move
    // -0.20 applies (rate leg is 0 for equities).
    expect(aapl.changePercent).toBeCloseTo(-0.20 * 1.15, 5);

    // Bond: market leg uses the "Fixed Income" fallback bucket (unmatched by
    // sectorMoves) -> marketMove(-0.03) * bondBeta(0.1) = -0.003. Rate leg
    // is the exponential duration term -- previously this was completely
    // discarded because sectorMoves was present (category:'sector').
    const expectedMarketLeg = -0.03 * 0.1;
    const expectedRateLeg = Math.exp(-5 * 0.02) - 1;
    expect(bond.changePercent).toBeCloseTo(expectedMarketLeg + expectedRateLeg, 5);
    // Proof the rate leg actually fired: total is far more negative than the
    // market leg alone would produce.
    expect(bond.changePercent).toBeLessThan(-0.05);
  });
});

describe("additive shock composition — regression guards", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, sector) VALUES (1, 'AAPL', 'Apple', 'stock', 'Technology')"
    ).run();
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 100)"
    ).run(today());
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 150)").run(today());
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, sector, style, market_cap_category) VALUES (2, 'DUK', 'Duke Energy', 'stock', 'Utilities', 'Value', 'Large Cap')"
    ).run();
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, 100)"
    ).run(today());
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 100)").run(today());
  });

  it("sector-only scenario (no rateMove) leaves equity impacts unchanged vs. the old behavior", () => {
    const scenario: ScenarioDefinition = {
      id: "custom-sector-only",
      name: "Custom",
      description: "test",
      category: "sector",
      marketMove: -0.03,
      sectorMoves: { Technology: -0.20 },
    };
    const result = computeScenario(db, scenario);
    const aapl = result.positionImpacts.find((p) => p.symbol === "AAPL")!;
    expect(aapl.changePercent).toBeCloseTo(-0.20 * 1.15, 5);
  });

  it("market-only custom scenario (no rateMove) is unchanged: marketMove * beta", () => {
    const scenario: ScenarioDefinition = {
      id: "custom-market-only",
      name: "Custom",
      description: "test",
      category: "custom",
      marketMove: -0.10,
    };
    const result = computeScenario(db, scenario);
    const duk = result.positionImpacts.find((p) => p.symbol === "DUK")!;
    // Utilities (lowBeta ×0.85) * Value (×0.9) = 0.765
    expect(duk.changePercent).toBeCloseTo(-0.10 * 0.765, 5);
  });
});

describe("additive shock composition — clamp applies to longs AND shorts (QA-1 detail)", () => {
  it("clamps changePercent at -100% for both a long and a short (estimatedNewValue never flips sign / exceeds notional)", () => {
    const db = createTestDb();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
    // Long option: beta 2.0, marketMove -0.6 -> raw changePercent -1.2 (pre-clamp).
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type) VALUES (1, 'LOPT', 'Long Option', 'option')"
    ).run();
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 10)"
    ).run(today());
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 100)").run(today());

    // Short option, same economics but negative quantity -> negative market_value.
    // The underlying still can't fall below zero, so this must clamp too: a
    // short can gain at most its full notional proceeds, not more.
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type) VALUES (2, 'SOPT', 'Short Option', 'option')"
    ).run();
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, -10)"
    ).run(today());
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 100)").run(today());

    const scenario: ScenarioDefinition = {
      id: "custom-clamp",
      name: "Custom",
      description: "test",
      category: "custom",
      marketMove: -0.6,
    };
    const result = computeScenario(db, scenario);
    const long = result.positionImpacts.find((p) => p.symbol === "LOPT")!;
    const short = result.positionImpacts.find((p) => p.symbol === "SOPT")!;

    expect(long.currentValue).toBeGreaterThan(0);
    expect(long.changePercent).toBe(-1);
    expect(long.estimatedNewValue).toBeCloseTo(0, 5);

    expect(short.currentValue).toBeLessThan(0);
    // Clamped to -100%, not the unclamped raw -1.2 (-0.6 * beta 2.0).
    expect(short.changePercent).toBe(-1);
    // A short gains when the market falls, but not more than it could ever
    // owe back (its full notional): estimatedChange must equal exactly
    // |market_value|, and estimatedNewValue must land at 0, never flip
    // positive (which would imply a >100%-of-notional gain).
    expect(short.estimatedChange).toBeCloseTo(Math.abs(short.currentValue), 5);
    expect(short.estimatedNewValue).toBeCloseTo(0, 5);
  });
});

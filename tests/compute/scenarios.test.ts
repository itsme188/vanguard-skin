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

  it("sector moves look through ETFs by cached sector weights", () => {
    // ETF with 50/50 Technology/Utilities weights: a -25% Technology move
    // (marketMove -3% elsewhere) should hit half the position at -25% and
    // half at -3% — not skip the ETF entirely because its own sector is NULL.
    db.exec(`
      CREATE TABLE etf_sector_weights (
        etf_symbol TEXT NOT NULL,
        sector TEXT NOT NULL,
        weight_pct REAL NOT NULL,
        as_of_date TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (etf_symbol, sector)
      );
    `);
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type) VALUES (10, 'MIXETF', 'Mixed ETF', 'etf')"
    ).run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 10, ?, 100)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (10, ?, 100)").run(today);
    db.prepare("INSERT INTO etf_sector_weights VALUES ('MIXETF', 'Technology', 50, ?, 'manual')").run(today);
    db.prepare("INSERT INTO etf_sector_weights VALUES ('MIXETF', 'Utilities', 50, ?, 'manual')").run(today);

    const result = computeScenario(db, {
      id: "custom-sector",
      name: "Custom Sector",
      description: "test",
      category: "sector" as const,
      marketMove: -0.03,
      sectorMoves: { Technology: -0.25 },
    });
    const etf = result.positionImpacts.find((p) => p.symbol === "MIXETF")!;
    // beta for a sectorless ETF is 1.0 → 0.5×(-0.25) + 0.5×(-0.03) = -0.14
    expect(etf.changePercent).toBeCloseTo(-0.14, 3);
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

describe("legacy custom-scenario path uses account_security keyBy (QA regression)", () => {
  // Bug: the legacy custom-scenario path built its latest_holdings CTE with
  // keyBy: "account" — the latest as_of_date across ALL securities in the
  // account. Any position whose OWN latest row predates that account-wide
  // date was silently dropped, understating currentPortfolioValue (and every
  // % derived from it) vs. the recipe/preset path, which correctly uses the
  // default account_security keyBy (latest row per account+security pair).
  it("includes a position whose latest holdings row is older than another position's latest row", () => {
    const db = createTestDb();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // Security A: latest (and only) holdings row is FRESH.
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type) VALUES (1, 'AAA', 'Security A', 'stock')"
    ).run();
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, '2026-08-01', 100)"
    ).run();
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price) VALUES (1, '2026-08-01', 50)"
    ).run();

    // Security B: latest (and only) holdings row is OLDER — no row on
    // 2026-08-01, the account's overall newest date, for this security.
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type) VALUES (2, 'BBB', 'Security B', 'stock')"
    ).run();
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, '2026-07-15', 200)"
    ).run();
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price) VALUES (2, '2026-07-15', 25)"
    ).run();

    const customScenario = {
      id: "custom",
      name: "Custom",
      description: "test",
      category: "custom" as const,
      marketMove: -0.10,
    };
    const result = computeScenario(db, customScenario);

    // A = 100 × $50 = $5,000; B = 200 × $25 = $5,000. Total = $10,000.
    // Pre-fix, keyBy: "account" kept only rows dated 2026-08-01 (the
    // account's overall newest date) and silently dropped B's $5,000.
    expect(result.positionImpacts.map((p) => p.symbol).sort()).toEqual(["AAA", "BBB"]);
    expect(result.currentPortfolioValue).toBeCloseTo(10_000, 2);

    // Cross-check against the preset/recipe path (which already used the
    // default account_security keyBy) on the same DB — the two bases must
    // now agree, since both paths use the same predicate options.
    const recipeResult = computeScenario(db, PRESET_SCENARIOS[0]);
    expect(recipeResult.currentPortfolioValue).toBeCloseTo(result.currentPortfolioValue, 2);
  });
});

describe("FX conversion (Task 9a — scenario market value)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("KRW holding's current value and scenario dollar impact reflect USD conversion, not won notional", () => {
    const today = new Date().toISOString().slice(0, 10);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // USD control: 10 sh @ $208 = $2,080. Unaffected by the FX join (default
    // currency 'USD' has no fx_rates row; COALESCE(fx.usd_per_unit,1) → 1).
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, currency) VALUES (1, 'AAPL', 'Apple', 'stock', 'USD')"
    ).run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 10)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 208)").run(today);

    // KRW holding: 10 sh @ ₩1,731,000 = ₩17,310,000 notional. fx 0.000734 → ≈$12,705.54.
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, currency) VALUES (2, '402340', 'KRW Co', 'stock', 'KRW')"
    ).run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, 10)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 1731000)").run(today);
    db.prepare(
      "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('KRW', 0.000734, ?, 'test')"
    ).run(today);

    // Legacy custom (non-recipe) scenario — flows through scenarios.ts's own
    // inline market_value query, not scenario-recipes.ts.
    const customCorrection = {
      id: "custom-fx-test",
      name: "Custom",
      description: "test",
      category: "custom" as const,
      marketMove: -0.10,
    };
    const result = computeScenario(db, customCorrection);

    const expectedKrwUsd = 10 * 1_731_000 * 0.000734; // ≈ $12,705.54
    const krw = result.positionImpacts.find((p) => p.symbol === "402340")!;
    const aapl = result.positionImpacts.find((p) => p.symbol === "AAPL")!;

    // Plain stock, no sector/style/market-cap → beta 1.0 → changePercent = marketMove.
    expect(krw.currentValue).toBeCloseTo(expectedKrwUsd, 2);
    expect(krw.currentValue).toBeLessThan(20_000); // NOT the ₩17.31M phantom
    expect(krw.estimatedChange).toBeCloseTo(expectedKrwUsd * -0.10, 2);
    expect(krw.estimatedNewValue).toBeCloseTo(expectedKrwUsd * 0.9, 2);

    // USD control byte-unchanged.
    expect(aapl.currentValue).toBeCloseTo(2_080, 2);
    expect(aapl.estimatedChange).toBeCloseTo(-208, 2);

    expect(result.currentPortfolioValue).toBeCloseTo(2_080 + expectedKrwUsd, 2);
  });
});

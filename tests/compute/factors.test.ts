import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  computeFactorAnalysis,
  computeMacroFactorTilts,
  computeSecurityFactorShare,
  normalizeAccountIds,
} from "@/lib/compute/factors";

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
      classification_source TEXT,
      underlying_symbol TEXT,
      maturity_date TEXT
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

describe("computeMacroFactorTilts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns an entry per factor column with 0 exposure when no factors are classified", () => {
    const tilts = computeMacroFactorTilts(db);
    expect(tilts).toHaveLength(9);
    for (const t of tilts) {
      expect(t.exposurePct).toBe(0);
      expect(t.topContributors).toHaveLength(0);
    }
    // Ensure all 9 expected factors are present (one row per FACTOR_COLUMNS entry).
    const factors = tilts.map((t) => t.factor).sort();
    expect(factors).toContain("interest_rate_sensitive");
    expect(factors).toContain("ai_exposure");
    expect(factors).toContain("crypto_adjacent");
  });

  it("aggregates weighted exposure using standard-scale multipliers", () => {
    const today = recentDate(0);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // 4 holdings, equal weight (25% each):
    //   AAPL ai=Very High (1.0 * 25 = 25 pp)
    //   NVDA ai=High      (0.75 * 25 = 18.75 pp)
    //   T    ai=Moderate  (0.5 * 25 = 12.5 pp)
    //   BND  ai=Low       (0.25 * 25 = 6.25 pp)
    //   Total exposurePct = 62.5
    for (const [id, sym, ai] of [
      [1, "AAPL", "Very High"],
      [2, "NVDA", "High"],
      [3, "T", "Moderate"],
      [4, "BND", "Low"],
    ] as const) {
      db.prepare("INSERT INTO securities (id, symbol, name) VALUES (?, ?, ?)").run(id, sym, sym);
      db.prepare("INSERT INTO security_factors (security_id, ai_exposure) VALUES (?, ?)").run(id, ai);
      db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, ?, ?, 25)").run(id, today);
      db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, 100)").run(id, today);
    }

    const tilts = computeMacroFactorTilts(db);
    const ai = tilts.find((t) => t.factor === "ai_exposure")!;

    // Weighted sum: 25 + 18.75 + 12.5 + 6.25 = 62.5
    expect(ai.exposurePct).toBeCloseTo(62.5, 1);

    // Top 4 contributors sorted by weighted exposure desc — AAPL first.
    expect(ai.topContributors.slice(0, 2).map((c) => c.symbol)).toEqual(["AAPL", "NVDA"]);
    expect(ai.topContributors[0].weight).toBeCloseTo(25, 1);

    // No factors classified for any other column → those tilts remain at 0.
    const rates = tilts.find((t) => t.factor === "interest_rate_sensitive")!;
    expect(rates.exposurePct).toBe(0);
  });

  it("treats non-standard categorical values (Growth/Value, Yes, International) as full exposure", () => {
    const today = recentDate(0);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // 60% Growth, 40% Value — both fully classified → exposurePct = 100
    db.prepare("INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple')").run();
    db.prepare("INSERT INTO security_factors (security_id, growth_vs_value, crypto_adjacent, international_exposure) VALUES (1, 'Growth', 'Yes', 'International')").run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 60)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 100)").run(today);

    db.prepare("INSERT INTO securities (id, symbol, name) VALUES (2, 'BRK', 'Berkshire')").run();
    db.prepare("INSERT INTO security_factors (security_id, growth_vs_value) VALUES (2, 'Value')").run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, 40)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 100)").run(today);

    const tilts = computeMacroFactorTilts(db);
    const growth = tilts.find((t) => t.factor === "growth_vs_value")!;
    const crypto = tilts.find((t) => t.factor === "crypto_adjacent")!;
    const intl = tilts.find((t) => t.factor === "international_exposure")!;

    // Both Growth + Value fully classified — exposure aggregates over the full portfolio.
    expect(growth.exposurePct).toBeCloseTo(100, 1);
    // Only AAPL is crypto-adjacent=Yes → 60% exposurePct.
    expect(crypto.exposurePct).toBeCloseTo(60, 1);
    expect(crypto.topContributors).toHaveLength(1);
    // International on AAPL only.
    expect(intl.exposurePct).toBeCloseTo(60, 1);
  });

  it("ignores 'No' and 'Unknown' values (0 multiplier)", () => {
    const today = recentDate(0);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    db.prepare("INSERT INTO securities (id, symbol, name) VALUES (1, 'CASH', 'Cash')").run();
    db.prepare("INSERT INTO security_factors (security_id, crypto_adjacent, ai_exposure) VALUES (1, 'No', 'Unknown')").run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 100)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 100)").run(today);

    const tilts = computeMacroFactorTilts(db);
    const crypto = tilts.find((t) => t.factor === "crypto_adjacent")!;
    const ai = tilts.find((t) => t.factor === "ai_exposure")!;
    expect(crypto.exposurePct).toBe(0);
    expect(ai.exposurePct).toBe(0);
    expect(crypto.topContributors).toHaveLength(0);
  });
});

describe("computeSecurityFactorShare", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns 50% share when two equal-weight names share one factor at the same level", () => {
    const today = recentDate(0);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    for (const [id, sym] of [
      [1, "AAPL"],
      [2, "MSFT"],
    ] as const) {
      db.prepare("INSERT INTO securities (id, symbol, name) VALUES (?, ?, ?)").run(id, sym, sym);
      db.prepare("INSERT INTO security_factors (security_id, ai_exposure) VALUES (?, 'High')").run(id);
      db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, ?, ?, 50)").run(id, today);
      db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, 100)").run(id, today);
    }

    const entries = computeSecurityFactorShare(db, 1);
    expect(entries).toHaveLength(1);
    const ai = entries[0];
    expect(ai.factor).toBe("ai_exposure");
    expect(ai.value).toBe("High");
    // contribution = weight_pct(50) * 0.75 = 37.5; bucket total = 75; share = 50%.
    expect(ai.securityContribution).toBeCloseTo(37.5, 1);
    expect(ai.bucketTotalExposure).toBeCloseTo(75, 1);
    expect(ai.sharePct).toBeCloseTo(50, 1);
    expect(ai.deltaPp).toBeCloseTo(37.5, 1);
  });

  it("weights share by both position size and exposure level", () => {
    const today = recentDate(0);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // AAPL ai=Very High, 80% weight → contribution 80
    db.prepare("INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple')").run();
    db.prepare("INSERT INTO security_factors (security_id, ai_exposure) VALUES (1, 'Very High')").run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 80)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 100)").run(today);

    // NVDA ai=High, 20% weight → contribution 0.75*20 = 15
    db.prepare("INSERT INTO securities (id, symbol, name) VALUES (2, 'NVDA', 'Nvidia')").run();
    db.prepare("INSERT INTO security_factors (security_id, ai_exposure) VALUES (2, 'High')").run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, 20)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 100)").run(today);

    const ai = computeSecurityFactorShare(db, 1).find((e) => e.factor === "ai_exposure")!;
    // bucket total = 80 + 15 = 95; AAPL share = 80/95 = 84.2%.
    expect(ai.bucketTotalExposure).toBeCloseTo(95, 1);
    expect(ai.sharePct).toBeCloseTo(84.21, 1);
  });

  it("returns only active (non-Unknown / non-No) factors, sorted by share desc", () => {
    const today = recentDate(0);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    db.prepare("INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple')").run();
    db.prepare(
      "INSERT INTO security_factors (security_id, ai_exposure, crypto_adjacent, interest_rate_sensitive, tariff_exposure) VALUES (1, 'High', 'No', 'Unknown', 'Low')"
    ).run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 100)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 100)").run(today);

    const entries = computeSecurityFactorShare(db, 1);
    const factors = entries.map((e) => e.factor);
    // ai_exposure (High) + tariff_exposure (Low) are active; crypto=No, rates=Unknown excluded.
    expect(factors).toContain("ai_exposure");
    expect(factors).toContain("tariff_exposure");
    expect(factors).not.toContain("crypto_adjacent");
    expect(factors).not.toContain("interest_rate_sensitive");
    // Sole holder → 100% share of each active factor; no NaN/Infinity.
    for (const e of entries) {
      expect(e.sharePct).toBeCloseTo(100, 1);
      expect(Number.isFinite(e.sharePct)).toBe(true);
    }
    // Sorted by sharePct desc (tie here, so just assert it's the active set of 2).
    expect(entries).toHaveLength(2);
  });

  it("returns [] for a security that is not held", () => {
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
    db.prepare("INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple')").run();
    db.prepare("INSERT INTO security_factors (security_id, ai_exposure) VALUES (1, 'High')").run();
    // No holdings row.
    expect(computeSecurityFactorShare(db, 1)).toEqual([]);
  });

  it("returns [] for an unknown security id", () => {
    expect(computeSecurityFactorShare(db, 999)).toEqual([]);
  });

  it("uses par-adjusted (÷100) market value for bonds", () => {
    const today = recentDate(0);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // Stock: 100 sh × $100 = $10,000 market value, ai=High.
    db.prepare("INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple')").run();
    db.prepare("INSERT INTO security_factors (security_id, ai_exposure) VALUES (1, 'High')").run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 100)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 100)").run(today);

    // Bond: 10000 face × price 98.5 ÷ 100 = $9,850 market value, ai=High.
    db.prepare("INSERT INTO securities (id, symbol, name, security_type) VALUES (2, 'TBOND', 'Treasury', 'Bond')").run();
    db.prepare("INSERT INTO security_factors (security_id, ai_exposure) VALUES (2, 'High')").run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, 10000)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 98.5)").run(today);

    const stockShare = computeSecurityFactorShare(db, 1).find((e) => e.factor === "ai_exposure")!;
    const bondShare = computeSecurityFactorShare(db, 2).find((e) => e.factor === "ai_exposure")!;
    // Total mkt value = 10000 + 9850 = 19850. Stock weight 50.38%, bond 49.62%.
    // Same exposure level (High) so share ratio == weight ratio.
    expect(stockShare.sharePct).toBeCloseTo((10000 / 19850) * 100, 1);
    expect(bondShare.sharePct).toBeCloseTo((9850 / 19850) * 100, 1);
  });

  it("bucketTotalExposure ties out with computeMacroFactorTilts exposurePct", () => {
    const today = recentDate(0);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    for (const [id, sym, ai] of [
      [1, "AAPL", "Very High"],
      [2, "NVDA", "High"],
      [3, "T", "Moderate"],
    ] as const) {
      db.prepare("INSERT INTO securities (id, symbol, name) VALUES (?, ?, ?)").run(id, sym, sym);
      db.prepare("INSERT INTO security_factors (security_id, ai_exposure) VALUES (?, ?)").run(id, ai);
      db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, ?, ?, 30)").run(id, today);
      db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, 100)").run(id, today);
    }

    const tiltAi = computeMacroFactorTilts(db).find((t) => t.factor === "ai_exposure")!;
    const shareAi = computeSecurityFactorShare(db, 1).find((e) => e.factor === "ai_exposure")!;
    expect(shareAi.bucketTotalExposure).toBeCloseTo(tiltAi.exposurePct, 4);
  });
});

describe("normalizeAccountIds", () => {
  it("prefers accountIds when both are set", () => {
    expect(normalizeAccountIds({ accountId: 1, accountIds: [2, 3] })).toEqual([2, 3]);
  });
  it("wraps a lone accountId into a single-element array", () => {
    expect(normalizeAccountIds({ accountId: 5 })).toEqual([5]);
  });
  it("returns undefined when neither is set (= whole portfolio)", () => {
    expect(normalizeAccountIds({})).toBeUndefined();
    expect(normalizeAccountIds(undefined)).toBeUndefined();
  });
  it("treats an empty accountIds array as 'fall through to accountId'", () => {
    expect(normalizeAccountIds({ accountId: 7, accountIds: [] })).toEqual([7]);
    expect(normalizeAccountIds({ accountIds: [] })).toBeUndefined();
  });
});

describe("computeFactorAnalysis multi-account scope", () => {
  let db: Database.Database;
  const today = new Date().toISOString().slice(0, 10);

  beforeEach(() => {
    db = createTestDb();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'IBKR'), (2, 'Roth')");
    // acct 1: AAPL ai=High. acct 2: NVDA ai=High (account-2-only name).
    db.exec("INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple'), (2, 'NVDA', 'Nvidia')");
    db.exec("INSERT INTO security_factors (security_id, ai_exposure) VALUES (1, 'High'), (2, 'High')");
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 100)").run(today);
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (2, 2, ?, 100)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 100)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 100)").run(today);
  });

  it("tilts reflect every account in the set, not just the first", () => {
    const acct1 = computeFactorAnalysis(db, { accountId: 1 });
    const both = computeFactorAnalysis(db, { accountIds: [1, 2] });

    const acct1Ai = acct1.tilts.find((t) => t.factor === "ai_exposure")!;
    const bothAi = both.tilts.find((t) => t.factor === "ai_exposure")!;

    expect(acct1Ai.topContributors.map((c) => c.symbol)).toEqual(["AAPL"]);
    expect(bothAi.topContributors.map((c) => c.symbol).sort()).toEqual(["AAPL", "NVDA"]);
  });

  it("accountIds undefined equals the all-accounts result", () => {
    expect(computeFactorAnalysis(db, { accountIds: undefined })).toEqual(
      computeFactorAnalysis(db)
    );
  });

  it("back-compat: accountIds:[1] deep-equals accountId:1", () => {
    expect(computeFactorAnalysis(db, { accountIds: [1] })).toEqual(
      computeFactorAnalysis(db, { accountId: 1 })
    );
  });
});

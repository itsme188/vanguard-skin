import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeFactorAnalysis } from "@/lib/compute/factors";

/**
 * Market regression must run on the flow-adjusted growth index (risk.ts
 * convention) — a deposit/withdrawal is not a market move. Pre-fix, the
 * regression consumed raw total_value log returns, so a mid-window $100k
 * withdrawal read as a -20.9% "day" (live IBKR repro) and drove beta toward 0
 * with a massively inflated alpha.
 */
function createTestDb(withTransactions: boolean): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE securities (
      id INTEGER PRIMARY KEY, symbol TEXT NOT NULL UNIQUE, name TEXT,
      security_type TEXT DEFAULT 'stock', multiplier REAL DEFAULT 1,
      sector TEXT, fund_category TEXT, market_cap_category TEXT, style TEXT,
      geography TEXT, classification_source TEXT, underlying_symbol TEXT,
      maturity_date TEXT, currency TEXT NOT NULL DEFAULT 'USD'
    );
    CREATE TABLE fx_rates (currency TEXT PRIMARY KEY, usd_per_unit REAL NOT NULL, as_of TEXT NOT NULL, source TEXT);
    CREATE TABLE security_factors (
      security_id INTEGER PRIMARY KEY REFERENCES securities(id),
      interest_rate_sensitive TEXT, growth_vs_value TEXT, cyclical TEXT,
      international_exposure TEXT, geopolitical_onshoring TEXT, tariff_exposure TEXT,
      ai_exposure TEXT, crypto_adjacent TEXT, regulatory_risk TEXT,
      factor_source TEXT DEFAULT 'csv_import', updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, security_id INTEGER NOT NULL,
      as_of_date TEXT NOT NULL, quantity REAL NOT NULL, cost_basis REAL
    );
    CREATE TABLE prices (
      id INTEGER PRIMARY KEY, security_id INTEGER NOT NULL, date TEXT NOT NULL,
      close_price REAL NOT NULL, source TEXT DEFAULT 'test', UNIQUE(security_id, date)
    );
    CREATE TABLE daily_valuations (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, valuation_date TEXT NOT NULL,
      cash_balance REAL NOT NULL DEFAULT 0, holdings_value REAL NOT NULL DEFAULT 0,
      total_value REAL NOT NULL DEFAULT 0, UNIQUE(account_id, valuation_date)
    );
    CREATE TABLE benchmark_prices (
      id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, date TEXT NOT NULL,
      close_price REAL NOT NULL, source TEXT NOT NULL DEFAULT 'test', UNIQUE(symbol, date)
    );
  `);
  if (withTransactions) {
    db.exec(`
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, security_id INTEGER,
        trade_date TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'DEPOSIT',
        quantity REAL, amount REAL, price_per_share REAL,
        is_external_flow INTEGER DEFAULT 0, source_key TEXT UNIQUE
      );
    `);
  }
  return db;
}

function recentDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * Portfolio = shares × SPY exactly (fully invested, beta 1 by construction).
 * A +$50k external deposit landing on day `depositDaysAgo` is immediately
 * invested — shares increase by 50k / that day's SPY price — so the true
 * market exposure stays beta 1 throughout and only the flow itself distorts
 * a raw-return regression.
 */
function seedTrackingPortfolioWithDeposit(
  db: Database.Database,
  depositDaysAgo: number | null,
): void {
  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
  let shares = 200;
  for (let i = 59; i >= 0; i--) {
    const date = recentDate(i);
    const spy = 500 + (59 - i) * 0.3 + Math.sin((59 - i) * 0.5) * 10;
    if (depositDaysAgo != null && i === depositDaysAgo) shares += 50_000 / spy;
    const total = spy * shares;
    db.prepare(
      "INSERT OR IGNORE INTO benchmark_prices (symbol, date, close_price) VALUES ('SPY', ?, ?)",
    ).run(date, spy);
    db.prepare(
      "INSERT OR IGNORE INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (1, ?, 0, ?, ?)",
    ).run(date, total, total);
  }
}

describe("computeMarketRegression flow adjustment", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb(true);
  });

  it("a mid-window deposit does not pollute beta/alpha (portfolio tracks SPY exactly)", () => {
    seedTrackingPortfolioWithDeposit(db, 30);
    db.prepare(
      "INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key) VALUES (1, ?, 'DEPOSIT', 50000, 1, 'test:flow:deposit')",
    ).run(recentDate(30));

    const reg = computeFactorAnalysis(db).marketRegression!;
    expect(reg).not.toBeNull();
    // Pre-fix: the +$50k day injects log(~1.5) into the return series →
    // alpha annualizes to ~+170% and correlation collapses.
    expect(reg.beta).toBeGreaterThan(0.9);
    expect(reg.beta).toBeLessThan(1.1);
    expect(Math.abs(reg.alpha)).toBeLessThan(0.15);
    expect(reg.correlation).toBeGreaterThan(0.95);
  });

  it("a mid-window withdrawal does not read as a crash (IBKR -$100k repro shape)", () => {
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
    // Fully invested throughout: the -$40k withdrawal on day 25 sells shares
    // at that day's price, so true beta stays 1 and only the flow itself
    // would distort a raw-return regression.
    let shares = 400;
    for (let i = 59; i >= 0; i--) {
      const date = recentDate(i);
      const spy = 500 + (59 - i) * 0.3 + Math.sin((59 - i) * 0.5) * 10;
      if (i === 25) shares -= 40_000 / spy;
      const total = spy * shares;
      db.prepare(
        "INSERT OR IGNORE INTO benchmark_prices (symbol, date, close_price) VALUES ('SPY', ?, ?)",
      ).run(date, spy);
      db.prepare(
        "INSERT OR IGNORE INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (1, ?, 0, ?, ?)",
      ).run(date, total, total);
    }
    db.prepare(
      "INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key) VALUES (1, ?, 'WITHDRAWAL', -40000, 1, 'test:flow:withdrawal')",
    ).run(recentDate(25));

    const reg = computeFactorAnalysis(db).marketRegression!;
    expect(reg.beta).toBeGreaterThan(0.9);
    expect(reg.beta).toBeLessThan(1.1);
    expect(Math.abs(reg.alpha)).toBeLessThan(0.15);
    expect(reg.correlation).toBeGreaterThan(0.95);
  });

  it("still computes when the transactions table is absent (minimal test DBs)", () => {
    const bare = createTestDb(false);
    db.close();
    db = bare;
    seedTrackingPortfolioWithDeposit(bare, null);

    const reg = computeFactorAnalysis(bare).marketRegression!;
    expect(reg).not.toBeNull();
    expect(reg.beta).toBeGreaterThan(0.9);
    expect(reg.beta).toBeLessThan(1.1);
  });
});

/**
 * Seam-aware market regression: a monthly_snapshots anchor-source transition
 * (e.g. canonical statement era → Plaid daily era) makes the daily_valuations
 * series jump by a fixed measurement-basis offset on the seam date — not a
 * market move, and not an external flow either (no transactions row explains
 * it). buildFlowAdjustedIndex (Task 2) bridges that one day when given the
 * seam dates (Task 1); this section verifies computeMarketRegression (via
 * computeFactorAnalysis) actually threads those seam dates through so the
 * bridged day's return pair never reaches the beta regression.
 */
function addMonthlySnapshotsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE monthly_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      month_end_date TEXT NOT NULL,
      total_value REAL NOT NULL,
      source TEXT
    );
  `);
}

/**
 * 41-day aligned series: portfolio tracks benchmark exactly 1:1 (value =
 * spy * 10) except a permanent level shift of +4% applied from `stepDate`
 * onward (no flow row backs it) — i.e. one anomalous +4% excess-return day
 * on stepDate itself, then back to tracking exactly (now at the new level).
 */
function seedStepPortfolio(db: Database.Database, stepDaysAgo: number): string {
  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
  let stepDate = "";
  for (let i = 40; i >= 0; i--) {
    const date = recentDate(i);
    const spy = 500 + (40 - i) * 0.3 + Math.sin((40 - i) * 0.5) * 10;
    if (i === stepDaysAgo) stepDate = date;
    const multiplier = i <= stepDaysAgo ? 10 * 1.04 : 10;
    const total = spy * multiplier;
    db.prepare(
      "INSERT OR IGNORE INTO benchmark_prices (symbol, date, close_price) VALUES ('SPY', ?, ?)",
    ).run(date, spy);
    db.prepare(
      "INSERT OR IGNORE INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (1, ?, 0, ?, ?)",
    ).run(date, total, total);
  }
  return stepDate;
}

function makeRegressionDbWithSeam(): Database.Database {
  const db = createTestDb(false);
  addMonthlySnapshotsTable(db);
  const stepDate = seedStepPortfolio(db, 20);
  const firstDate = recentDate(40);
  db.prepare(
    "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (1, ?, 0, 'canonical')",
  ).run(firstDate);
  db.prepare(
    "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (1, ?, 0, 'plaid')",
  ).run(stepDate);
  return db;
}

function makeRegressionDbNoSeam(): Database.Database {
  const db = createTestDb(false);
  addMonthlySnapshotsTable(db);
  const stepDate = seedStepPortfolio(db, 20);
  const firstDate = recentDate(40);
  db.prepare(
    "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (1, ?, 0, 'canonical')",
  ).run(firstDate);
  db.prepare(
    "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (1, ?, 0, 'canonical')",
  ).run(stepDate);
  return db;
}

describe("market regression seam awareness", () => {
  it("drops the seam day's pair; beta recovers the true relationship", () => {
    // Construct portfolio returns as EXACTLY 1.0 x benchmark for 40 aligned
    // days, EXCEPT one +4% portfolio-only step day with no flow row. Anchors:
    // 'canonical' era before the step, 'plaid' from the step date (seam DB);
    // control DB has identical values but both anchors 'canonical'.
    const db = makeRegressionDbWithSeam();
    const control = makeRegressionDbNoSeam();
    const seamAware = computeFactorAnalysis(db).marketRegression!;
    const contaminated = computeFactorAnalysis(control).marketRegression!;
    // The fake-return pair is excluded, so beta comes back ~1.0 exactly;
    // the contaminated control deviates from 1.0.
    expect(seamAware.beta).toBeCloseTo(1.0, 2);
    expect(Math.abs(contaminated.beta - 1.0)).toBeGreaterThan(0.05);
  });
});

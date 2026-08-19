import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeRiskMetrics } from "@/lib/compute/risk";
import { computeFactorAnalysis } from "@/lib/compute/factors";

/**
 * QA finding analysis-diagnostics--7d-trend-badges-structural-zero:
 * /api/compute/factors and /api/compute/risk compute a "now" and a
 * "week-ago" (asOfDate) snapshot to drive the W-o-W badges on
 * /dashboard/analysis?view=diagnostics. Root cause: computeMarketRegression
 * (factors.ts) and the drawdown/volatility/Sharpe leg of computeRiskMetrics
 * (risk.ts) both pull the FULL daily_valuations history regardless of
 * asOfDate — so the "week-ago" snapshot is byte-identical to "now" and every
 * delta is a structural 0. This file proves the metric WINDOW gets truncated
 * at asOfDate: seed a calm era followed by a violently different recent era,
 * and assert asOfDate="end of calm era" sees only the calm era while the
 * unbounded ("now") call sees the whole thing.
 */

function dateAt(offset: number): string {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function createRiskTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE securities (
      id INTEGER PRIMARY KEY, symbol TEXT NOT NULL UNIQUE, name TEXT,
      security_type TEXT DEFAULT 'stock', multiplier REAL DEFAULT 1,
      currency TEXT NOT NULL DEFAULT 'USD'
    );
    CREATE TABLE fx_rates (currency TEXT PRIMARY KEY, usd_per_unit REAL NOT NULL, as_of TEXT NOT NULL, source TEXT);
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
  `);
  return db;
}

function createFactorsTestDb(): Database.Database {
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
  return db;
}

describe("computeRiskMetrics — asOfDate truncates the drawdown/volatility window", () => {
  let db: Database.Database;
  const CALM_DAYS = 34; // offsets 0..33 — enough for volatility (needs 30 points, 20 returns)
  const SHOCK_DAYS = 7; // offsets 34..40 — violent swings, must NOT leak into the truncated "past" snapshot

  beforeEach(() => {
    db = createRiskTestDb();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    let value = 1_000_000;
    for (let i = 0; i < CALM_DAYS + SHOCK_DAYS; i++) {
      if (i < CALM_DAYS) {
        // Tiny, bounded oscillation — near-zero volatility, near-zero drawdown.
        value = 1_000_000 * (1 + (i % 2 === 0 ? 0.0005 : -0.0005));
      } else {
        // Violent swings — large volatility, large drawdown.
        value = value * (i % 2 === 0 ? 0.7 : 1.5);
      }
      db.prepare(
        "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (1, ?, 0, ?, ?)"
      ).run(dateAt(i), value, value);
    }
  });

  it("computes a materially different volatility for the truncated (week-ago) window than the full window", () => {
    const asOfDate = dateAt(CALM_DAYS - 1); // last calm day — cutoff BEFORE the shock era begins

    const now = computeRiskMetrics(db, { accountId: 1 });
    const past = computeRiskMetrics(db, { accountId: 1, asOfDate });

    expect(now.volatility).not.toBeNull();
    expect(past.volatility).not.toBeNull();
    // Pre-fix: past === now (asOfDate is ignored by the valuations query), so
    // this assertion fails until the window is actually truncated.
    expect(now.volatility!).toBeGreaterThan((past.volatility ?? 0) * 5);
  });

  it("computes a materially different max drawdown for the truncated (week-ago) window than the full window", () => {
    const asOfDate = dateAt(CALM_DAYS - 1);

    const now = computeRiskMetrics(db, { accountId: 1 });
    const past = computeRiskMetrics(db, { accountId: 1, asOfDate });

    expect(now.maxDrawdown).not.toBeNull();
    expect(now.maxDrawdown!.percent).toBeGreaterThan(0.2);
    // The calm-only truncated window should show a near-zero (or null) drawdown.
    const pastDd = past.maxDrawdown?.percent ?? 0;
    expect(pastDd).toBeLessThan(0.01);
  });

  it("does not change the un-truncated ('now') snapshot when asOfDate is omitted", () => {
    const now = computeRiskMetrics(db, { accountId: 1 });
    expect(now.dataPoints).toBe(CALM_DAYS + SHOCK_DAYS);
  });
});

describe("computeFactorAnalysis — asOfDate truncates the market-regression window", () => {
  let db: Database.Database;
  const CALM_DAYS = 34; // return pairs where portfolio tracks SPY exactly (beta = 1)
  const SHOCK_DAYS = 6; // return pairs where portfolio moves OPPOSITE SPY (beta = -1 locally)

  beforeEach(() => {
    db = createFactorsTestDb();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    let spy = 500;
    let portfolio = 500 * 2000; // 2000 "shares" tracking SPY 1:1
    for (let i = 0; i <= CALM_DAYS + SHOCK_DAYS; i++) {
      if (i > 0) {
        const rb = i % 2 === 0 ? 0.01 : -0.01;
        const newSpy = spy * (1 + rb);
        const isShock = i > CALM_DAYS;
        // Calm era: portfolio grows exactly like SPY (beta 1 by construction).
        // Shock era: portfolio grows exactly OPPOSITE SPY (beta -1 locally).
        portfolio = isShock ? portfolio * (spy / newSpy) : portfolio * (newSpy / spy);
        spy = newSpy;
      }
      const date = dateAt(i);
      db.prepare(
        "INSERT INTO benchmark_prices (symbol, date, close_price) VALUES ('SPY', ?, ?)"
      ).run(date, spy);
      db.prepare(
        "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (1, ?, 0, ?, ?)"
      ).run(date, portfolio, portfolio);
    }
  });

  it("computes a materially different beta for the truncated (week-ago) window than the full window", () => {
    const asOfDate = dateAt(CALM_DAYS); // cutoff at the END of the calm era, before any shock pair

    const now = computeFactorAnalysis(db, { accountId: 1, benchmarkSymbol: "SPY" });
    const past = computeFactorAnalysis(db, { accountId: 1, benchmarkSymbol: "SPY", asOfDate });

    expect(now.marketRegression).not.toBeNull();
    expect(past.marketRegression).not.toBeNull();
    // Truncated window is pure 1:1 tracking → beta ~1.0 exactly.
    expect(past.marketRegression!.beta).toBeCloseTo(1.0, 1);
    // Pre-fix: now === past (asOfDate is never read by computeMarketRegression),
    // so this fails until the window is truncated. Post-fix, the full window's
    // beta is dragged well below 1 by the inverse-tracking shock days.
    expect(
      Math.abs(now.marketRegression!.beta - past.marketRegression!.beta)
    ).toBeGreaterThan(0.1);
  });
});

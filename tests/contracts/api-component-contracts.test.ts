/**
 * API↔Component contract tests.
 *
 * These tests verify that compute/query functions return data shapes
 * matching what client components actually destructure. The OptionsGreeksCard
 * crash (2026-04-10) was caused by a component expecting a `portfolio` wrapper
 * that the API never returned — TypeScript couldn't catch it because API
 * responses pass through json.data (typed as any).
 *
 * Each test calls the real compute function with an in-memory DB and verifies
 * the response has the exact fields the component accesses.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";
import { computeFactorAnalysis } from "@/lib/compute/factors";
import { computeRiskMetrics, computePositionRisk } from "@/lib/compute/risk";
import { computeAllScenarios } from "@/lib/compute/scenarios";
import { detectStrategies } from "@/lib/compute/options-strategy";

let db: Database.Database;

function seedAccount(db: Database.Database, name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedSecurity(db: Database.Database, symbol: string, type = "Stock"): number {
  const r = db.prepare(
    "INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)"
  ).run(symbol, `${symbol} Corp`, type);
  return r.lastInsertRowid as number;
}

function seedHolding(db: Database.Database, accountId: number, securityId: number, qty: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, '2026-04-01')"
  ).run(accountId, securityId, qty, qty * 100);
}

function seedPrice(db: Database.Database, securityId: number, price: number) {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-04-01', 'test')"
  ).run(securityId, price);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// ─── OptionsGreeksCard contract ──────────────────────────────────────

describe("OptionsGreeksCard contract", () => {
  it("returns flat portfolio totals, not nested under 'portfolio'", () => {
    const result = computePortfolioGreeks(db);

    // Component destructures: data.totalDelta, data.totalGamma, etc.
    // NOT data.portfolio.totalDelta (the old crash)
    expect(result).toHaveProperty("totalDelta");
    expect(result).toHaveProperty("totalGamma");
    expect(result).toHaveProperty("totalTheta");
    expect(result).toHaveProperty("totalVega");
    expect(result).toHaveProperty("positions");
    expect(result).not.toHaveProperty("portfolio");
  });

  it("position fields match component expectations", () => {
    const acctId = seedAccount(db, "Test");
    const secId = db.prepare(
      `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES ('TEST  260401C00100000', 'Test Option', 'Option', 'TEST', 'CALL', 100, '2026-04-01', 100)`
    ).run().lastInsertRowid as number;
    seedHolding(db, acctId, secId, 5);
    const underlyingId = seedSecurity(db, "TEST");
    seedPrice(db, underlyingId, 105);

    const result = computePortfolioGreeks(db);
    if (result.positions.length > 0) {
      const p = result.positions[0];
      // Component uses p.optionType (not p.type)
      expect(p).toHaveProperty("optionType");
      expect(["CALL", "PUT"]).toContain(p.optionType);
      // Component uses p.greeks?.delta (nested, not flat)
      expect(p).toHaveProperty("greeks");
      // Component uses p.daysToExpiry (may be number, guard for NaN)
      expect(p).toHaveProperty("daysToExpiry");
    }
  });
});

// ─── FactorAnalysisCard contract ─────────────────────────────────────

describe("FactorAnalysisCard contract", () => {
  it("returns the shape the component imports", () => {
    const result = computeFactorAnalysis(db);
    // Component imports FactorAnalysisResult type directly — good
    // But let's verify the shape anyway
    expect(result).toHaveProperty("marketRegression");
    expect(result).toHaveProperty("sizeTilt");
    expect(result).toHaveProperty("styleTilt");
    expect(result).toHaveProperty("sectorTilt");
    expect(result).toHaveProperty("geographyTilt");
  });
});

// ─── RiskMetrics contract ────────────────────────────────────────────

describe("RiskMetrics contract", () => {
  it("returns dataPoints for the threshold check", () => {
    const result = computeRiskMetrics(db);
    // Component checks: if (metrics.dataPoints < 5) return "Insufficient data"
    expect(result).toHaveProperty("dataPoints");
    expect(typeof result.dataPoints).toBe("number");
    // Component uses metrics.top5Positions with .weight field
    expect(result).toHaveProperty("top5Positions");
    expect(result).toHaveProperty("top5Concentration");
    expect(result).toHaveProperty("herfindahl");
  });
});

// ─── ScenarioModeling contract ───────────────────────────────────────

describe("ScenarioModeling contract", () => {
  it("returns array of scenario results", () => {
    const acctId = seedAccount(db, "Test");
    const secId = seedSecurity(db, "SPY");
    seedHolding(db, acctId, secId, 100);
    seedPrice(db, secId, 500);

    const result = computeAllScenarios(db);
    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      const s = result[0];
      // Component accesses these fields
      expect(s).toHaveProperty("scenario");
      expect(s).toHaveProperty("currentPortfolioValue");
      expect(s).toHaveProperty("estimatedPortfolioValue");
      expect(s).toHaveProperty("estimatedChange");
      expect(s).toHaveProperty("estimatedChangePercent");
      expect(s).toHaveProperty("positionImpacts");
    }
  });
});

// ─── PositionRisk contract ───────────────────────────────────────────

describe("PositionRisk contract", () => {
  it("returns positions array and portfolioVol", () => {
    const result = computePositionRisk(db);
    expect(result).toHaveProperty("positions");
    expect(result).toHaveProperty("correlations");
    expect(result).toHaveProperty("portfolioVol");
  });
});

// ─── OptionsStrategies contract ──────────────────────────────────────

describe("OptionsStrategies contract", () => {
  it("returns array of detected strategies", () => {
    const result = detectStrategies([]);
    expect(Array.isArray(result)).toBe(true);
  });
});

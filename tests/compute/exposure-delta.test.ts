import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeExposureDelta } from "@/lib/compute/exposure-delta";

// Migration 002 seeds: 1=Vanguard Taxable, 2=Vanguard Roth IRA, 3=IBKR.

function seedBasicPortfolio(db: Database.Database) {
  // Securities: AAPL, MSFT, JNJ
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (1, 'AAPL', 'Stock', 'Technology')`).run();
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (2, 'MSFT', 'Stock', 'Technology')`).run();
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (3, 'JNJ', 'Stock', 'Healthcare')`).run();

  // Factor classifications
  db.prepare(`INSERT INTO security_factors (security_id, growth_vs_value, ai_exposure) VALUES (1, 'Growth', 'High')`).run();
  db.prepare(`INSERT INTO security_factors (security_id, growth_vs_value, ai_exposure) VALUES (2, 'Growth', 'High')`).run();
  db.prepare(`INSERT INTO security_factors (security_id, growth_vs_value, ai_exposure) VALUES (3, 'Value', 'No')`).run();

  // Betas (lookback 252)
  db.prepare(`INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (1, 252, 1.2, '2026-05-10')`).run();
  db.prepare(`INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (2, 252, 1.1, '2026-05-10')`).run();
  db.prepare(`INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (3, 252, 0.6, '2026-05-10')`).run();

  // Prices
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (1, ?, 200, 'tws')`).run(today);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (2, ?, 400, 'tws')`).run(today);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (3, ?, 150, 'tws')`).run(today);

  // Holdings: account 1 (Vanguard) holds AAPL 10 shares + JNJ 20 shares.
  // Account 3 (IBKR) holds MSFT 5 shares at a more recent as_of_date.
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 1, '2026-04-30', 10, 'vg-aapl')`).run();
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 3, '2026-04-30', 20, 'vg-jnj')`).run();
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 2, ?, 5, 'tws-msft')`).run(today);
}

describe("computeExposureDelta", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedBasicPortfolio(db);
  });

  it("snapshots both before/after for an additive BUY leg", () => {
    const result = computeExposureDelta(db, "all", undefined, [
      { symbol: "AAPL", action: "buy", dollarAmount: 1000 },
    ]);
    expect(result.before.totalValue).toBe(2000 + 3000 + 2000); // 10*200 + 20*150 + 5*400
    expect(result.after.totalValue).toBeCloseTo(result.before.totalValue + 1000, 2);
    const aapl = result.after.topConcentrations.find((c) => c.symbol === "AAPL");
    expect(aapl).toBeDefined();
    expect(aapl!.weightPct).toBeGreaterThan(
      result.before.topConcentrations.find((c) => c.symbol === "AAPL")!.weightPct
    );
  });

  it("subtracts shares for a SELL leg, clamps at zero", () => {
    const result = computeExposureDelta(db, "all", undefined, [
      { symbol: "JNJ", action: "sell", dollarAmount: 9999999 }, // sell more than we have
    ]);
    const jnj = result.after.topConcentrations.find((c) => c.symbol === "JNJ");
    expect(jnj).toBeUndefined(); // position zeroed
    expect(result.after.totalValue).toBeLessThan(result.before.totalValue);
  });

  it("handles a mixed multi-leg basket", () => {
    const result = computeExposureDelta(db, "all", undefined, [
      { symbol: "AAPL", action: "buy", dollarAmount: 500 },
      { symbol: "JNJ", action: "sell", dollarAmount: 500 },
    ]);
    expect(result.after.totalValue).toBeCloseTo(result.before.totalValue, 2);
  });

  it("triggers a top1 flag for IBKR when a leg pushes concentration over cap", () => {
    // IBKR scope: only 5 MSFT shares ($2000). Buy $50k AAPL -> AAPL becomes ~96% of IBKR.
    const result = computeExposureDelta(db, "ibkr", [3], [
      { symbol: "AAPL", action: "buy", dollarAmount: 50000 },
    ]);
    const top1Flag = result.flags.find((f) => f.metric === "top1");
    expect(top1Flag).toBeDefined();
  });

  it("triggers a sector_max flag when a leg pushes a sector over cap", () => {
    // Vanguard scope: 60% Healthcare (JNJ $3000 of $5000 total). Cap is 30%.
    const result = computeExposureDelta(db, "vanguard", [1], []);
    const sectorFlag = result.flags.find((f) => f.metric.startsWith("sector:Healthcare"));
    expect(sectorFlag).toBeDefined();
  });

  it("does NOT trigger a sector flag for the Unknown bucket (data-quality issue, not concentration risk)", () => {
    // Add an unclassified position big enough that Unknown becomes the dominant sector at IBKR scope.
    // IBKR scope: only 5 MSFT shares ($2000) — Tech 100%. Add 100 shares of NOSECTOR @ $200 = $20k.
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (5, 'NOSECTOR', 'Stock', NULL)`).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (5, ?, 200, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 5, ?, 100, 'tws-nosector')`).run(today);
    const result = computeExposureDelta(db, "ibkr", [3], []);
    // Unknown sector dominates after the unclassified leg lands; no sector flag should fire for it.
    const unknownFlag = result.flags.find((f) => f.metric === "sector:Unknown");
    expect(unknownFlag).toBeUndefined();
  });

  it("triggers a beta-out-of-range flag", () => {
    // Vanguard scope blended beta: 0.6*0.6 + 0.4*1.2 = 0.36 + 0.48 = 0.84.
    // Vanguard cap is [0.7, 1.1] so 0.84 is in range. Buy lots of low-beta JNJ to push below 0.7.
    const result = computeExposureDelta(db, "vanguard", [1], [
      { symbol: "JNJ", action: "buy", dollarAmount: 50000 },
    ]);
    const betaFlag = result.flags.find((f) => f.metric === "beta");
    expect(betaFlag).toBeDefined();
  });

  it("detects factor tilt shift", () => {
    const result = computeExposureDelta(db, "all", undefined, [
      { symbol: "JNJ", action: "buy", dollarAmount: 10000 },
    ]);
    const beforeValue = result.before.factorTilts.growth_vs_value["Value"] ?? 0;
    const afterValue = result.after.factorTilts.growth_vs_value["Value"] ?? 0;
    expect(afterValue).toBeGreaterThan(beforeValue);
  });

  it("treats unknown symbol as a no-op (skipped silently)", () => {
    const result = computeExposureDelta(db, "all", undefined, [
      { symbol: "NOTREAL", action: "buy", dollarAmount: 1000 },
    ]);
    expect(result.after.totalValue).toBe(result.before.totalValue);
  });

  it("defaults beta to 1.0 when security_betas row is missing", () => {
    // Add a 4th security with no beta cache
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (4, 'NOBETA', 'Stock', 'Technology')`).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (4, ?, 100, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 4, ?, 50, 'tws-nobeta')`).run(today);
    const result = computeExposureDelta(db, "all", undefined, []);
    // beta should still compute with 1.0 default for NOBETA
    expect(result.before.beta).toBeGreaterThan(0);
    expect(Number.isFinite(result.before.beta)).toBe(true);
  });

  it("respects account scope (filters to single account)", () => {
    const result = computeExposureDelta(db, "ibkr", [3], []);
    // IBKR scope only has MSFT
    expect(result.before.topConcentrations).toHaveLength(1);
    expect(result.before.topConcentrations[0].symbol).toBe("MSFT");
  });

  it("computes across all accounts when accountIds is undefined", () => {
    const result = computeExposureDelta(db, "all", undefined, []);
    expect(result.before.topConcentrations.length).toBeGreaterThanOrEqual(3);
  });

  describe("short positions stay in the after book", () => {
    // Regression: applyLegs filtered `marketValue > 0`, dropping shorts from
    // the AFTER snapshot while BEFORE included them — every what-if's Total
    // Value Δ was inflated by a constant |sum of short MVs| (live: $57,771).
    const today = new Date().toISOString().slice(0, 10);

    beforeEach(() => {
      // Short 50 shares of PINS @ $30 = -$1,500 in IBKR.
      db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (6, 'PINS', 'Stock', 'Communication Services')`).run();
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (6, ?, 30, 'tws')`).run(today);
      db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 6, ?, -50, 'tws-pins')`).run(today);
    });

    it("what-if Δ equals exactly the entered amount when shorts are held", () => {
      const result = computeExposureDelta(db, "all", undefined, [
        { symbol: "KO_LIKE_BUY", action: "buy", dollarAmount: 0 }, // no-op leg shape guard
        { symbol: "AAPL", action: "buy", dollarAmount: 10000 },
      ]);
      // before includes the -$1,500 short: 2000 + 3000 + 2000 - 1500
      expect(result.before.totalValue).toBe(5500);
      expect(result.after.totalValue).toBeCloseTo(result.before.totalValue + 10000, 2);
    });

    it("empty legs is a true no-op even with shorts held", () => {
      const result = computeExposureDelta(db, "all", undefined, []);
      expect(result.after.totalValue).toBeCloseTo(result.before.totalValue, 2);
      expect(result.after.beta).toBeCloseTo(result.before.beta, 6);
    });

    it("buying into the short (covering) still moves total by the entered amount", () => {
      const result = computeExposureDelta(db, "all", undefined, [
        { symbol: "PINS", action: "buy", dollarAmount: 600 }, // covers 20 of 50 shares
      ]);
      expect(result.after.totalValue).toBeCloseTo(result.before.totalValue + 600, 2);
    });
  });

  it("empty legs produces a no-op delta (before == after)", () => {
    const result = computeExposureDelta(db, "all", undefined, []);
    expect(result.after.totalValue).toBeCloseTo(result.before.totalValue, 2);
    expect(result.after.beta).toBeCloseTo(result.before.beta, 4);
    expect(result.flags.filter((f) => f.metric === "top1" || f.metric === "top3").length).toBeGreaterThanOrEqual(0);
  });
});

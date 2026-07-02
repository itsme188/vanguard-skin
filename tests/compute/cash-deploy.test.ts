import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { suggestAllocation } from "@/lib/compute/cash-deploy";

// Migration 002 seeds: 1=Vanguard Taxable, 2=Vanguard Roth IRA, 3=IBKR.
// Migration 050 seeds VTI/QQQ/SPY/DIA sector compositions.

function seedVanguardPortfolio(db: Database.Database) {
  // Current Vanguard holdings: heavily Tech-overweight, no Healthcare.
  // VTI target: Tech 31%, Healthcare 11.5%. So Vanguard scope is overweight
  // Tech vs underweight Healthcare → Healthcare watchlist names should win.
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (1, 'AAPL', 'Stock', 'Technology')`).run();
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (2, 'MSFT', 'Stock', 'Technology')`).run();
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (3, 'JNJ', 'Stock', 'Healthcare')`).run();
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (4, 'LLY', 'Stock', 'Healthcare')`).run();

  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (1, ?, 200, 'tws')`).run(today);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (2, ?, 400, 'tws')`).run(today);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (3, ?, 150, 'tws')`).run(today);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (4, ?, 750, 'tws')`).run(today);

  // Vanguard Taxable: $80k Tech (40 AAPL + 100 MSFT * something), $5k Healthcare
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 1, '2026-04-30', 200, 'h-aapl')`).run(); // $40k
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 2, '2026-04-30', 100, 'h-msft')`).run(); // $40k
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 3, '2026-04-30', 33, 'h-jnj')`).run(); // $5k

  // Watchlist: JNJ + LLY in vanguard_buy group
  db.prepare(`INSERT INTO watchlist (security_id, group_name, is_active, thesis) VALUES (3, 'vanguard_buy', 1, 'defensive yield')`).run();
  db.prepare(`INSERT INTO watchlist (security_id, group_name, is_active, thesis) VALUES (4, 'vanguard_buy', 1, 'GLP-1 leader')`).run();
}

describe("suggestAllocation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("detects underweight sectors vs benchmark", () => {
    seedVanguardPortfolio(db);
    const result = suggestAllocation(db, "vanguard", [1], 10000);
    expect(result.benchmarkSymbol).toBe("VTI");
    expect(result.mode).toBe("benchmark");
    const healthcareGap = result.gaps.find((g) => g.sector === "Healthcare");
    expect(healthcareGap).toBeDefined();
    expect(healthcareGap!.gapPp).toBeLessThan(0); // underweight
  });

  it("ranks watchlist candidates in underweight sectors first", () => {
    seedVanguardPortfolio(db);
    const result = suggestAllocation(db, "vanguard", [1], 10000);
    expect(result.picks.length).toBeGreaterThan(0);
    const topPick = result.picks[0];
    expect(["JNJ", "LLY"]).toContain(topPick.symbol);
    expect(topPick.sectorTarget).toBe("Healthcare");
  });

  it("respects per-name cap (top1_max × projected total)", () => {
    seedVanguardPortfolio(db);
    // Vanguard cap top1_max = 0.08. Current $85k + cash $50k = projected $135k.
    // Cap per name = $135k × 0.08 = $10.8k.
    const result = suggestAllocation(db, "vanguard", [1], 50000);
    expect(result.picks.length).toBeGreaterThan(0);
    for (const pick of result.picks) {
      expect(pick.allocationDollars).toBeLessThanOrEqual(135000 * 0.08 + 0.01);
    }
  });

  it("returns no picks when cashAmount is zero", () => {
    seedVanguardPortfolio(db);
    const result = suggestAllocation(db, "vanguard", [1], 0);
    expect(result.picks).toHaveLength(0);
    expect(result.notes.join(" ")).toMatch(/no cash to deploy/i);
  });

  it("returns no picks when watchlist is empty", () => {
    // Seed only holdings, no watchlist
    db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (1, 'AAPL', 'Stock', 'Technology')`).run();
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (1, ?, 200, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 1, '2026-04-30', 100, 'h-aapl')`).run();

    const result = suggestAllocation(db, "vanguard", [1], 5000);
    expect(result.picks).toHaveLength(0);
    expect(result.notes.some((n) => /watchlist candidates/i.test(n))).toBe(true);
  });

  it("falls back to heuristic mode when benchmark composition is missing", () => {
    seedVanguardPortfolio(db);
    db.prepare(`DELETE FROM benchmark_compositions`).run();
    const result = suggestAllocation(db, "vanguard", [1], 10000);
    expect(result.mode).toBe("heuristic");
    expect(result.notes.some((n) => /no composition data/i.test(n))).toBe(true);
  });

  it("includes exposure delta per pick", () => {
    seedVanguardPortfolio(db);
    const result = suggestAllocation(db, "vanguard", [1], 10000);
    if (result.picks.length > 0) {
      const pick = result.picks[0];
      expect(pick.exposureDelta).toBeDefined();
      expect(pick.exposureDelta.before.totalValue).toBeGreaterThan(0);
      expect(pick.exposureDelta.after.totalValue).toBeGreaterThan(
        pick.exposureDelta.before.totalValue
      );
    }
  });

  it("uses scope-appropriate benchmark (Roth → SPY)", () => {
    seedVanguardPortfolio(db);
    const result = suggestAllocation(db, "roth", undefined, 5000);
    expect(result.benchmarkSymbol).toBe("SPY");
  });

  it("uses scope-appropriate benchmark (IBKR → QQQ)", () => {
    seedVanguardPortfolio(db);
    const result = suggestAllocation(db, "ibkr", undefined, 5000);
    expect(result.benchmarkSymbol).toBe("QQQ");
  });
});

describe("FX conversion (Task 9c — cash-deploy market value)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("sector gap dollarGap reflects USD conversion, not KRW notional", () => {
    const today = new Date().toISOString().slice(0, 10);

    // USD control: AAPL 40 sh @ $200 = $8,000, Technology.
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, sector, currency) VALUES (1, 'AAPL', 'Stock', 'Technology', 'USD')`
    ).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (1, ?, 200, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 1, '2026-04-30', 40, 'h-aapl')`).run();

    // KRW holding: 10 sh @ ₩1,731,000 = ₩17,310,000 notional. fx 0.000734 → ≈$12,705.54. Technology.
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, sector, currency) VALUES (2, '402340', 'Stock', 'Technology', 'KRW')`
    ).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (2, ?, 1731000, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 2, '2026-04-30', 10, 'h-krw')`).run();
    db.prepare(`INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('KRW', 0.000734, ?, 'test')`).run(today);

    // USD control 2: JNJ 33 sh @ $150 = $4,950, Healthcare.
    db.prepare(`INSERT INTO securities (id, symbol, security_type, sector, currency) VALUES (3, 'JNJ', 'Stock', 'Healthcare', 'USD')`).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (3, ?, 150, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 3, '2026-04-30', 33, 'h-jnj')`).run();

    // Heuristic mode (no benchmark composition) so targetWeight=0 for every
    // sector — dollarGap then equals exactly -(sector's converted dollars),
    // giving a direct handle on the per-sector market value the solver saw.
    db.prepare(`DELETE FROM benchmark_compositions`).run();

    const result = suggestAllocation(db, "vanguard", [1], 1000);
    expect(result.mode).toBe("heuristic");

    const expectedKrwUsd = 10 * 1_731_000 * 0.000734; // ≈ $12,705.54
    const expectedTechDollars = 8_000 + expectedKrwUsd;
    const expectedHealthDollars = 4_950;

    const techGap = result.gaps.find((g) => g.sector === "Technology");
    const healthGap = result.gaps.find((g) => g.sector === "Healthcare");
    expect(techGap).toBeDefined();
    expect(healthGap).toBeDefined();

    // Converted: Technology ≈ $20,705.54, NOT the ₩17.31M-inflated phantom
    // (which would put Technology's dollarGap over $17M).
    expect(Math.abs(techGap!.dollarGap)).toBeCloseTo(expectedTechDollars, 1);
    expect(Math.abs(techGap!.dollarGap)).toBeLessThan(30_000);

    // Healthcare (USD-only) byte-unchanged.
    expect(Math.abs(healthGap!.dollarGap)).toBeCloseTo(expectedHealthDollars, 1);
  });
});

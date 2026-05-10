import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAnalysisTrustState } from "@/lib/queries/analysis-trust-state";

describe("getAnalysisTrustState", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // accounts 1 (Vanguard Taxable), 2 (Vanguard Roth IRA), 3 (IBKR) pre-seeded by migration 002
  });

  it("reports zero coverage when there are no holdings", () => {
    const state = getAnalysisTrustState(db);
    expect(state.factorCoverage.percentage).toBe(0);
    expect(state.factorCoverage.totalNames).toBe(0);
  });

  it("reports factor coverage percentage based on classified securities", () => {
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (10, 'AAPL', 'Stock'), (11, 'MSFT', 'Stock')`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 10, '2026-04-30', 100, 'vg-1'),
                       (1, 11, '2026-04-30', 50, 'vg-2')`).run();
    db.prepare(`INSERT INTO security_factors (security_id, ai_exposure) VALUES (10, 'High')`).run();

    const state = getAnalysisTrustState(db);
    expect(state.factorCoverage.totalNames).toBe(2);
    expect(state.factorCoverage.classified).toBe(1);
    expect(state.factorCoverage.percentage).toBeCloseTo(0.5, 2);
    expect(state.factorCoverage.missingSymbols).toContain("MSFT");
  });

  it("reports last classification timestamp from security_factors.updated_at", () => {
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (10, 'AAPL', 'Stock')`).run();
    db.prepare(`INSERT INTO security_factors (security_id, ai_exposure, updated_at) VALUES (10, 'High', '2026-05-01 12:00:00')`).run();

    const state = getAnalysisTrustState(db);
    expect(state.lastClassification).toBe("2026-05-01 12:00:00");
  });

  it("counts stale prices (latest price older than 4 days)", () => {
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (10, 'AAPL', 'Stock'), (11, 'MSFT', 'Stock')`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 10, '2026-04-30', 100, 'vg-1'),
                       (1, 11, '2026-04-30', 50, 'vg-2')`).run();
    const today = new Date().toISOString().slice(0, 10);
    const stale = new Date(); stale.setDate(stale.getDate() - 7);
    const staleDate = stale.toISOString().slice(0, 10);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (10, ?, 195, 'tws')`).run(today);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (11, ?, 410, 'tws')`).run(staleDate);

    const state = getAnalysisTrustState(db);
    expect(state.stalePrices.count).toBe(1);
    expect(state.stalePrices.symbols).toEqual(["MSFT"]);
  });

  it("reports bond duration coverage (held bonds with non-null duration_years)", () => {
    db.prepare(`INSERT INTO securities (id, symbol, security_type, duration_years) VALUES (10, 'BOND1', 'Bond', 5.5), (11, 'BOND2', 'Bond', NULL)`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 10, '2026-04-30', 1, 'vg-1'),
                       (1, 11, '2026-04-30', 1, 'vg-2')`).run();

    const state = getAnalysisTrustState(db);
    expect(state.bondDuration.totalBonds).toBe(2);
    expect(state.bondDuration.withDuration).toBe(1);
  });
});

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
    expect(state.performanceReconciledThru).toBeNull();
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

  it("populates performanceReconciledThru when reconciliation passes", () => {
    // Two snapshots so computeTwr can produce a single-month result for April
    db.prepare(`INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, twr, source)
                VALUES (3, '2026-03-31', 100000, 0.00, 'ibkr-activity')`).run();
    db.prepare(`INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, twr, source)
                VALUES (3, '2026-04-30', 105210, 5.21, 'ibkr-activity')`).run();
    const state = getAnalysisTrustState(db, [3]);
    expect(state.performanceReconciledThru).toBe("2026-04-30");
  });

  it("returns null performanceReconciledThru when one account reconcile returns null (unresolvable)", () => {
    // account 3: passes reconciliation — two snapshots with ibkr-activity twr
    db.prepare(`INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, twr, source)
                VALUES (3, '2026-03-31', 100000, 0.00, 'ibkr-activity')`).run();
    db.prepare(`INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, twr, source)
                VALUES (3, '2026-04-30', 105210, 5.21, 'ibkr-activity')`).run();
    // account 1: has a statement snapshot for March but NOT for April.
    // getAnalysisTrustState queries for the LATEST statement snapshot per account.
    // latestStmt for account 1 → '2026-03-31'. reconcileTwrAgainstStatements for March
    // needs a prior snapshot (February) — none exists, so ibkr-activity pre-computed
    // path is used (twr=0.00 → 0bp divergence → within tolerance).
    // To force a null from reconcile: give account 1 a statement at a date where
    // computeTwr also returns null. Use a single snapshot with twr IS NULL so
    // reconcile's first guard (twr IS NOT NULL) finds nothing → null result.
    // Since latestStmt query filters for twr IS NOT NULL, there's no latestStmt row
    // for account 1 → the new !latestStmt branch fires → null + break.
    db.prepare(`INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, twr, starting_value, source)
                VALUES (1, '2026-04-30', 102000, NULL, NULL, 'vanguard-pdf')`).run();
    // twr=NULL means latestStmt query (twr IS NOT NULL) finds nothing for account 1
    // → !latestStmt branch → earliestReconciledMonth = null → break

    // Scope to [1, 3]: account 1 has no statement with twr, forces null
    const state = getAnalysisTrustState(db, [1, 3]);
    expect(state.performanceReconciledThru).toBeNull();
  });

  it("returns null performanceReconciledThru when one account has no statement TWR", () => {
    // account 3: passes reconciliation
    db.prepare(`INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, twr, source)
                VALUES (3, '2026-03-31', 100000, 0.00, 'ibkr-activity')`).run();
    db.prepare(`INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, twr, source)
                VALUES (3, '2026-04-30', 105210, 5.21, 'ibkr-activity')`).run();
    // account 2: no statement snapshot at all → latestStmt is null → must force null

    // Scope to [2, 3]: account 2 has no statement TWR, so "all accounts agree" is false
    const state = getAnalysisTrustState(db, [2, 3]);
    expect(state.performanceReconciledThru).toBeNull();
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

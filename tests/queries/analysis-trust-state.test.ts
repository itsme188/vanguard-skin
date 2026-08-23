import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAnalysisTrustState } from "@/lib/queries/analysis-trust-state";

// ─── Seed helper (mirrors tests/compute/dietz.test.ts's seedSnapshot) ──────
function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  opts: {
    startingValue?: number;
    twr?: number | null;
    depositsWithdrawals?: number;
    source?: string;
  } = {},
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, starting_value, twr, deposits_withdrawals, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    monthEndDate,
    totalValue,
    opts.startingValue ?? null,
    opts.twr === undefined ? null : opts.twr,
    opts.depositsWithdrawals ?? null,
    opts.source ?? "canonical",
  );
}

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
    expect(state.crossCheckedThru).toBeNull();
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

  it("counts an option as classified when its underlying has factors (inheritance-aware)", () => {
    db.prepare(`INSERT INTO securities (id, symbol, security_type, underlying_symbol) VALUES
                  (10, 'PANW', 'Stock', NULL),
                  (11, 'PANW  300116C00200000', 'Option', 'PANW')`).run();
    // Only the OPTION is held — the underlying just has a factor row to inherit from
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (3, 11, '2026-06-01', 2, 'tws-1')`).run();
    db.prepare(`INSERT INTO security_factors (security_id, ai_exposure) VALUES (10, 'High')`).run();

    const state = getAnalysisTrustState(db);
    expect(state.factorCoverage.totalNames).toBe(1);
    expect(state.factorCoverage.classified).toBe(1);
    expect(state.factorCoverage.missingSymbols).toEqual([]);
  });

  it("still reports an option as missing when its underlying has no factors", () => {
    db.prepare(`INSERT INTO securities (id, symbol, security_type, underlying_symbol) VALUES
                  (10, 'VLO', 'Stock', NULL),
                  (11, 'VLO   300116P00100000', 'Option', 'VLO')`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (3, 11, '2026-06-01', 1, 'tws-2')`).run();

    const state = getAnalysisTrustState(db);
    expect(state.factorCoverage.classified).toBe(0);
    expect(state.factorCoverage.missingSymbols).toEqual(["VLO   300116P00100000"]);
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

  // ─── Independent Dietz cross-check chain (Task 13) ────────────────────

  it("CHAIN START: with exactly 2 statement months, the walk starts (and can succeed) at the 2nd — the 1st is never itself walked", () => {
    // Account 1: Jan (V_start anchor only, never walked) → Feb (walked, matches Dietz).
    seedSnapshot(db, 1, "2026-01-31", 100_000, { source: "canonical" });
    seedSnapshot(db, 1, "2026-02-28", 103_000, {
      depositsWithdrawals: 0,
      twr: 0.03, // dietz = (103000-100000)/100000 = 0.03 exactly
      source: "canonical",
    });

    const state = getAnalysisTrustState(db, [1]);
    const acct1 = state.perAccountReconciliation.find((r) => r.accountId === 1)!;

    expect(acct1.bandHistory).toHaveLength(1);
    expect(acct1.bandHistory[0].monthEndDate).toBe("2026-02-28");
    expect(acct1.bandHistory[0].band).toBe("consistent");
    expect(state.crossCheckedThru).toBe("2026-02-28");
  });

  it("INVESTIGATE BREAKS: a disagreeing month stops the chain at the last good month before it", () => {
    seedSnapshot(db, 1, "2026-01-31", 100_000, { source: "canonical" });
    seedSnapshot(db, 1, "2026-02-28", 103_000, {
      depositsWithdrawals: 0,
      twr: 0.03, // consistent
      source: "canonical",
    });
    seedSnapshot(db, 1, "2026-03-31", 106_090, {
      depositsWithdrawals: 0,
      twr: 0.9, // wildly disagreeing statement figure → investigate
      source: "canonical",
    });

    const state = getAnalysisTrustState(db, [1]);
    const acct1 = state.perAccountReconciliation.find((r) => r.accountId === 1)!;

    expect(acct1.bandHistory.map((b) => b.band)).toEqual(["consistent", "investigate"]);
    expect(state.crossCheckedThru).toBe("2026-02-28");
  });

  it("NOT_COMPARABLE CONTINUES: a not_comparable month does not stop the chain — a later consistent month still counts", () => {
    // Feb's source differs from Jan's → a source seam lands on Feb → Feb is
    // not_comparable (seam-straddled), not a chain-breaker. March shares
    // Feb's source (no seam) and agrees with the statement → consistent.
    seedSnapshot(db, 1, "2026-01-31", 100_000, { source: "canonical" });
    seedSnapshot(db, 1, "2026-02-28", 103_000, {
      depositsWithdrawals: 0,
      twr: 0.05, // irrelevant — seam forces not_comparable regardless
      source: "vanguard-pdf",
    });
    seedSnapshot(db, 1, "2026-03-31", 106_090, {
      depositsWithdrawals: 0,
      twr: 0.03, // dietz = (106090-103000)/103000 = 0.03 exactly → consistent
      source: "vanguard-pdf",
    });

    const state = getAnalysisTrustState(db, [1]);
    const acct1 = state.perAccountReconciliation.find((r) => r.accountId === 1)!;

    expect(acct1.bandHistory.map((b) => b.band)).toEqual(["not_comparable", "consistent"]);
    // The chain survives PAST the not_comparable month, reaching March.
    expect(state.crossCheckedThru).toBe("2026-03-31");
  });

  it("MISSING MONTH BREAKS: a calendar month with no statement row at all stops the chain there", () => {
    // Statement rows exist for Jan and Feb (chain start) and April (latest),
    // but March has NO monthly_snapshots row at all — the walk still visits
    // March (calendar-month stepping, not statement-row stepping) and must
    // record it as a break.
    seedSnapshot(db, 1, "2026-01-31", 100_000, { source: "canonical" });
    seedSnapshot(db, 1, "2026-02-28", 103_000, {
      depositsWithdrawals: 0,
      twr: 0.03, // consistent
      source: "canonical",
    });
    // 2026-03-31 deliberately absent.
    seedSnapshot(db, 1, "2026-04-30", 110_000, {
      depositsWithdrawals: 0,
      twr: 0.03,
      source: "canonical",
    });

    const state = getAnalysisTrustState(db, [1]);
    const acct1 = state.perAccountReconciliation.find((r) => r.accountId === 1)!;

    expect(acct1.bandHistory.map((b) => b.monthEndDate)).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
    expect(acct1.bandHistory[0].band).toBe("consistent");
    expect(acct1.bandHistory[1].band).toBe("missing");
    expect(state.crossCheckedThru).toBe("2026-02-28");
  });

  it("headline row fields (statementTwr/dietzReturn/divergenceBp/band) reflect the LATEST statement month", () => {
    seedSnapshot(db, 3, "2026-03-31", 100_000, { depositsWithdrawals: 0, source: "ibkr-activity" });
    seedSnapshot(db, 3, "2026-04-30", 105_210, { depositsWithdrawals: 0, twr: 5.21, source: "ibkr-activity" });

    const state = getAnalysisTrustState(db, [3]);
    const acct3 = state.perAccountReconciliation.find((r) => r.accountId === 3)!;

    expect(acct3.monthEndDate).toBe("2026-04-30");
    expect(acct3.statementTwr).toBeCloseTo(0.0521, 6);
    expect(acct3.dietzReturn).toBeCloseTo(0.0521, 6);
    expect(acct3.band).toBe("consistent");
  });

  it("accounts with no statement row at all report null headline fields and force the rollup null", () => {
    seedSnapshot(db, 3, "2026-03-31", 100_000, { source: "ibkr-activity" });
    seedSnapshot(db, 3, "2026-04-30", 105_210, { twr: 5.21, source: "ibkr-activity" });
    // Account 1: no monthly_snapshots rows at all.

    const state = getAnalysisTrustState(db, [1, 3]);
    const acct1 = state.perAccountReconciliation.find((r) => r.accountId === 1)!;

    expect(acct1.monthEndDate).toBeNull();
    expect(acct1.statementTwr).toBeNull();
    expect(acct1.dietzReturn).toBeNull();
    expect(acct1.divergenceBp).toBeNull();
    expect(acct1.band).toBeNull();
    expect(acct1.bandHistory).toEqual([]);
    expect(state.crossCheckedThru).toBeNull();
  });

  it("an account with only 1 statement month is chainless (no 2nd month to start from) and forces the rollup null", () => {
    seedSnapshot(db, 3, "2026-03-31", 100_000, { source: "ibkr-activity" });
    seedSnapshot(db, 3, "2026-04-30", 105_210, { twr: 5.21, source: "ibkr-activity" });
    // Account 1: a single statement month — never enough to start a chain.
    seedSnapshot(db, 1, "2026-04-30", 102_000, { twr: 0.02, source: "vanguard-pdf" });

    const state = getAnalysisTrustState(db, [1, 3]);
    const acct1 = state.perAccountReconciliation.find((r) => r.accountId === 1)!;

    expect(acct1.monthEndDate).toBe("2026-04-30"); // headline still reports the single statement month
    expect(acct1.bandHistory).toEqual([]);
    expect(state.crossCheckedThru).toBeNull(); // account 1 is chainless → rollup forced null
  });

  it("rollup crossCheckedThru is the EARLIEST across in-scope accounts when both chains are healthy", () => {
    // Account 3: chain reaches April.
    seedSnapshot(db, 3, "2026-02-28", 100_000, { source: "ibkr-activity" });
    seedSnapshot(db, 3, "2026-03-31", 103_000, { depositsWithdrawals: 0, twr: 3.0, source: "ibkr-activity" });
    seedSnapshot(db, 3, "2026-04-30", 106_090, { depositsWithdrawals: 0, twr: 3.0, source: "ibkr-activity" });

    // Account 1: chain reaches only March (shorter history).
    seedSnapshot(db, 1, "2026-02-28", 50_000, { source: "canonical" });
    seedSnapshot(db, 1, "2026-03-31", 51_500, { depositsWithdrawals: 0, twr: 0.03, source: "canonical" });

    const state = getAnalysisTrustState(db, [1, 3]);

    expect(state.crossCheckedThru).toBe("2026-03-31");
  });

  it("returns per-account reconciliation rows covering every scoped account", () => {
    seedSnapshot(db, 3, "2026-03-31", 100_000, { depositsWithdrawals: 0, source: "ibkr-activity" });
    seedSnapshot(db, 3, "2026-04-30", 105_210, { depositsWithdrawals: 0, twr: 5.21, source: "ibkr-activity" });
    // account 1: no rows at all → must surface as null headline
    // account 2: no rows touched → also null headline

    const state = getAnalysisTrustState(db, [1, 2, 3]);

    expect(state.perAccountReconciliation).toHaveLength(3);
    const byId = new Map(state.perAccountReconciliation.map((r) => [r.accountId, r]));

    const acct3 = byId.get(3)!;
    expect(acct3.accountName).toBeTruthy();
    expect(acct3.monthEndDate).toBe("2026-04-30");
    expect(acct3.band).toBe("consistent");
    expect(acct3.divergenceBp).not.toBeNull();

    expect(byId.get(1)!.monthEndDate).toBeNull();
    expect(byId.get(1)!.band).toBeNull();
    expect(byId.get(2)!.monthEndDate).toBeNull();
    expect(byId.get(2)!.band).toBeNull();

    // Rollup field stays null because two accounts have no statement at all.
    expect(state.crossCheckedThru).toBeNull();
  });
});

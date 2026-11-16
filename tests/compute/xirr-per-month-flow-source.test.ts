/**
 * Two money-weighted return (XIRR) fixes, synthetic figures only.
 *
 * 1. The flow source is chosen PER MONTH: a month whose statement row
 *    reports deposits_withdrawals reads the statement; a month whose
 *    statement row leaves it NULL reads the ledger. Before, one nonzero
 *    statement month anywhere in the range made the WHOLE range read the
 *    statement, so a real ledger deposit in a NULL month vanished.
 * 2. `externalFlowCount` counts real deposits and withdrawals only. The
 *    solver's own list also carries each account's opening value and
 *    terminal value, so one real flow used to show as "3 cash flows".
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeXirr } from "@/lib/compute/xirr";

function snapshot(db: Database.Database, account: number, date: string, total: number, deps: number | null) {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source, deposits_withdrawals)
     VALUES (?, ?, ?, 'manual', ?)`,
  ).run(account, date, total, deps);
}

function ledgerFlow(db: Database.Database, account: number, date: string, amount: number) {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(account, date, amount > 0 ? "DEPOSIT" : "WITHDRAWAL", amount, `f-${account}-${date}-${amount}`);
}

describe("XIRR flow source per month and the external-flow count", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedMixedMonths(account: number) {
    snapshot(db, account, "2025-12-31", 100000, null);
    // January: the statement reports a deposit (the ledger has the same one).
    snapshot(db, account, "2026-01-31", 110000, 10000);
    ledgerFlow(db, account, "2026-01-12", 10000);
    // February: the statement leaves the field NULL; the ledger has a real deposit.
    snapshot(db, account, "2026-02-28", 125000, null);
    ledgerFlow(db, account, "2026-02-10", 10000);
    // March: the statement says zero; nothing in the ledger.
    snapshot(db, account, "2026-03-31", 126000, 0);
  }

  it("per account: a ledger deposit in a month the statement leaves NULL is counted", () => {
    seedMixedMonths(1);
    const r = computeXirr(db, { accountId: 1, startDate: "2026-01-01", endDate: "2026-03-31" });
    expect(r).not.toBeNull();
    // January from the statement, February from the ledger, never January twice.
    expect(r!.totalInvested).toBe(20000);
    expect(r!.externalFlowCount).toBe(2);
  });

  it("whole portfolio: the same NULL-month ledger deposit is counted", () => {
    seedMixedMonths(1);
    const r = computeXirr(db, { startDate: "2026-01-01", endDate: "2026-03-31" });
    expect(r).not.toBeNull();
    expect(r!.totalInvested).toBe(20000);
    expect(r!.externalFlowCount).toBe(2);
  });

  it("a month whose statement reports the figure never also reads the ledger", () => {
    seedMixedMonths(1);
    ledgerFlow(db, 1, "2026-03-05", 7000); // March statement says 0: not counted
    const r = computeXirr(db, { accountId: 1, startDate: "2026-01-01", endDate: "2026-03-31" });
    expect(r!.totalInvested).toBe(20000);
  });

  it("counts one real flow as one, not with the opening and terminal values", () => {
    snapshot(db, 1, "2025-12-31", 100000, null);
    snapshot(db, 1, "2026-01-31", 110000, 5000);
    const r = computeXirr(db, { accountId: 1, startDate: "2026-01-01", endDate: "2026-01-31" });
    expect(r).not.toBeNull();
    expect(r!.cashFlowCount).toBe(3); // the solver's list: opening, deposit, terminal
    expect(r!.externalFlowCount).toBe(1);
    expect(r!.perAccount[0].externalFlowCount).toBe(1);
  });

  it("a scope's external-flow count is the sum of its accounts' counts", () => {
    snapshot(db, 1, "2025-12-31", 100000, null);
    snapshot(db, 1, "2026-01-31", 110000, 5000);
    snapshot(db, 2, "2025-12-31", 50000, null);
    snapshot(db, 2, "2026-01-31", 56000, 5000);
    const r = computeXirr(db, { accountIds: [1, 2], startDate: "2026-01-01", endDate: "2026-01-31" });
    expect(r!.externalFlowCount).toBe(2);
  });
});

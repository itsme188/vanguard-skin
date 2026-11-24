/**
 * XIRR flow conservation: every external flow reaches the solver exactly
 * once, whatever mix of statement figures and ledger rows a range has.
 * Synthetic figures only.
 *
 * The bug this pins (review 2026-11-15, W1): a December statement row that
 * carries the YEAR's deposits (an annual summary) is reduced to its
 * December-only part by subtracting the January-November statement figures.
 * A month whose statement leaves deposits_withdrawals NULL added 0 there, so
 * its flow stayed inside the "December-only" figure, and the per-month ledger
 * read for NULL months then counted the same flow a second time.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeXirr } from "@/lib/compute/xirr";

const MONTH_ENDS_2025 = [
  "2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30", "2025-05-31", "2025-06-30",
  "2025-07-31", "2025-08-31", "2025-09-30", "2025-10-31", "2025-11-30",
];

function snap(
  db: Database.Database, account: number, date: string, total: number,
  start: number | null, deps: number | null,
) {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source, starting_value, deposits_withdrawals)
     VALUES (?, ?, ?, 'canonical', ?, ?)`,
  ).run(account, date, total, start, deps);
}

function ledger(db: Database.Database, account: number, date: string, amount: number) {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(account, date, amount > 0 ? "DEPOSIT" : "WITHDRAWAL", amount, `c-${account}-${date}-${amount}`);
}

/** Net external flow the solver used (deposits minus withdrawals). */
const netFlows = (r: { totalInvested: number; totalWithdrawn: number }) =>
  r.totalInvested - r.totalWithdrawn;

/**
 * One account through 2025: a 1,000 deposit in a month whose statement
 * leaves the figure NULL (the ledger has it), every other month 0, and a
 * December row that is an ANNUAL summary (its starting value is the Jan 1
 * value, more than 10% off November's close) carrying the year's 1,000.
 * The account grows only by the deposit, so the true XIRR is 0.
 */
function seedAnnualYear(db: Database.Database, account: number, nullMonth: string, depositDate: string) {
  snap(db, account, "2024-12-31", 10000, 9000, 0);
  let v = 10000;
  for (const d of MONTH_ENDS_2025) {
    const isNull = d.startsWith(nullMonth);
    const nv = v + (isNull ? 1000 : 0);
    snap(db, account, d, nv, v, isNull ? null : 0);
    v = nv;
  }
  ledger(db, account, depositDate, 1000);
  snap(db, account, "2025-12-31", 11000, 9000, 1000);
}

describe("XIRR counts every external flow exactly once", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("annual-summary year, NULL month with a ledger deposit: one account", () => {
    seedAnnualYear(db, 1, "2025-06", "2025-06-10");
    const r = computeXirr(db, { startDate: "2024-12-31", endDate: "2025-12-31", accountIds: [1] })!;
    expect(netFlows(r)).toBe(1000);
    expect(r.externalFlowCount).toBe(1);
    expect(Math.abs(r.xirr!)).toBeLessThan(1e-6);
  });

  it("annual-summary year, NULL month with a ledger deposit: whole portfolio", () => {
    seedAnnualYear(db, 1, "2025-06", "2025-06-10");
    snap(db, 2, "2024-12-31", 5000, 5000, 0);
    for (const d of [...MONTH_ENDS_2025, "2025-12-31"]) snap(db, 2, d, 5000, 5000, 0);
    const r = computeXirr(db, { startDate: "2024-12-31", endDate: "2025-12-31" })!;
    expect(netFlows(r)).toBe(1000);
    expect(Math.abs(r.xirr!)).toBeLessThan(1e-6);
    expect(netFlows(r.perAccount.find((p) => p.accountId === 1)!)).toBe(1000);
  });

  it("annual-summary year, NULL-month deposit BEFORE the window: December carries none of it", () => {
    seedAnnualYear(db, 1, "2025-06", "2025-06-10");
    // Window opens at the July month-end: June's deposit is already in the
    // opening value, and the annual December figure must not bring it back.
    const single = computeXirr(db, { startDate: "2025-07-31", endDate: "2025-12-31", accountIds: [1] })!;
    expect(netFlows(single)).toBe(0);
    const portfolio = computeXirr(db, { startDate: "2025-07-31", endDate: "2025-12-31" })!;
    expect(netFlows(portfolio)).toBe(0);
  });

  it("annual-summary year with a real December-only deposit keeps that deposit", () => {
    seedAnnualYear(db, 1, "2025-06", "2025-06-10");
    db.prepare(
      `UPDATE monthly_snapshots SET deposits_withdrawals = 1500, total_value = 11500
       WHERE account_id = 1 AND month_end_date = '2025-12-31'`,
    ).run();
    const single = computeXirr(db, { startDate: "2024-12-31", endDate: "2025-12-31", accountIds: [1] })!;
    expect(netFlows(single)).toBe(1500);
    const portfolio = computeXirr(db, { startDate: "2024-12-31", endDate: "2025-12-31" })!;
    expect(netFlows(portfolio)).toBe(1500);
  });

  it("normal year: NULL month with a ledger deposit is counted once", () => {
    snap(db, 1, "2025-12-31", 10000, 10000, 0);
    snap(db, 1, "2026-01-31", 11000, 10000, null);
    ledger(db, 1, "2026-01-10", 1000);
    snap(db, 1, "2026-02-28", 12000, 11000, 1000);
    ledger(db, 1, "2026-02-10", 1000);
    for (const opts of [{ accountIds: [1] }, {}]) {
      const r = computeXirr(db, { startDate: "2025-12-31", endDate: "2026-02-28", ...opts })!;
      expect(netFlows(r)).toBe(2000);
      expect(Math.abs(r.xirr!)).toBeLessThan(1e-6);
    }
  });

  it("statement 0 with a ledger deposit: the statement figure wins, nothing added", () => {
    snap(db, 1, "2025-12-31", 10000, 10000, 0);
    snap(db, 1, "2026-01-31", 10000, 10000, 0);
    ledger(db, 1, "2026-01-10", 1000);
    snap(db, 1, "2026-02-28", 11000, 10000, 1000);
    for (const opts of [{ accountIds: [1] }, {}]) {
      const r = computeXirr(db, { startDate: "2025-12-31", endDate: "2026-02-28", ...opts })!;
      expect(netFlows(r)).toBe(1000);
    }
  });

  it("portfolio: one account NULL with a ledger flow, the other reporting its figure", () => {
    for (const a of [1, 2]) snap(db, a, "2025-12-31", 10000, 10000, 0);
    snap(db, 1, "2026-01-31", 11000, 10000, 1000);
    ledger(db, 1, "2026-01-10", 1000); // also on the statement: counted once
    snap(db, 2, "2026-01-31", 11000, 10000, null);
    ledger(db, 2, "2026-01-12", 1000); // NULL month: from the ledger
    const r = computeXirr(db, { startDate: "2025-12-31", endDate: "2026-01-31" })!;
    expect(netFlows(r)).toBe(2000);
    expect(Math.abs(r.xirr!)).toBeLessThan(1e-6);
    const sumOfAccounts = r.perAccount.reduce((s, p) => s + netFlows(p), 0);
    expect(sumOfAccounts).toBe(2000);
  });
});

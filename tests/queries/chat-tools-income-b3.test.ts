/**
 * B3 / QA-6 / plan Contract J: the chat income tool counts a reinvested
 * dividend ONCE (the REINVESTMENT row is the purchase leg of its DIVIDEND),
 * and margin interest charged is a cost, not income.
 *
 * Worked example (the main scenario, account 3, period all_time):
 *   DIVIDEND +10 and REINVESTMENT +10, same account/security/day -> one
 *     payout of 10 (the old code counted 20)
 *   lone REINVESTMENT +4 on another day (no dividend row) -> +4
 *   INTEREST -25 (charged on a margin debit) -> interest_paid 25
 *   INTEREST +3 (earned) -> total_interest 3
 *   FEE -2 -> total_fees 2
 *   total_dividends = 10 + 4 = 14
 *   net_income = 14 + 3 - 25 - 2 = -10   (old code: 20 + 4 + 28 - 2 = 50)
 *
 * Conservation: the group_by=type rows and the group_by=account rows each sum
 * to the one computed total, field by field, within $0.01.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getIncomeSummaryForChat, type IncomeResult } from "@/lib/queries/chat-tools";

const IBKR = 3; // seeded by migration 002
const TAXABLE = 1;

let db: Database.Database;
let sec: number;
let other: number;
let n = 0;

function txn(account: number, security: number | null, date: string, type: string, amount: number, key?: string) {
  n += 1;
  db.prepare(
    `INSERT OR IGNORE INTO transactions (account_id, security_id, trade_date, type, amount, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(account, security, date, type, amount, key ?? `b3-${n}`);
}

function sum(rows: IncomeResult[], field: keyof IncomeResult): number {
  return rows.reduce((s, r) => s + Number(r[field] ?? 0), 0);
}

function seedMainScenario() {
  txn(IBKR, sec, "2026-03-02", "DIVIDEND", 10, "k-div");
  txn(IBKR, sec, "2026-03-02", "REINVESTMENT", 10, "k-reinv");
  txn(IBKR, sec, "2026-04-01", "REINVESTMENT", 4, "k-lone");
  txn(IBKR, null, "2026-03-31", "INTEREST", -25, "k-int-paid");
  txn(IBKR, null, "2026-04-30", "INTEREST", 3, "k-int-earned");
  txn(IBKR, null, "2026-04-30", "FEE", -2, "k-fee");
}

beforeEach(() => {
  n = 0;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  sec = db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('AAA', 'AAA Fund', 'ETF')")
    .run().lastInsertRowid as number;
  other = db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('BBB', 'BBB Fund', 'ETF')")
    .run().lastInsertRowid as number;
});

describe("getIncomeSummaryForChat income semantics (B3)", () => {
  it("a reinvested dividend counts once and charged interest is a cost", () => {
    seedMainScenario();
    const [row] = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    expect(row.total_dividends).toBeCloseTo(14, 6);
    expect(row.total_interest).toBeCloseTo(3, 6);
    expect(row.interest_paid).toBeCloseTo(25, 6);
    expect(row.total_fees).toBeCloseTo(2, 6);
    expect(row.net_income).toBeCloseTo(-10, 6);
    expect(row.unpaired_reinvestment_count).toBe(0);
  });

  it("two dividends and one reinvestment on one day pair by amount", () => {
    // DIV 10 and DIV 6 on one day; only the 6 was reinvested. Income = 16
    // (old code: 22). A reinvestment of 6 must not pair with the 10.
    txn(IBKR, sec, "2026-05-01", "DIVIDEND", 10);
    txn(IBKR, sec, "2026-05-01", "DIVIDEND", 6);
    txn(IBKR, sec, "2026-05-01", "REINVESTMENT", 6);
    const [row] = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    expect(row.total_dividends).toBeCloseTo(16, 6);

    // One-to-one: a second 6 reinvestment on that day has no dividend left
    // to pair with, so it is unpaired positive income (16 + 6 = 22).
    txn(IBKR, sec, "2026-05-01", "REINVESTMENT", 6);
    const [row2] = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    expect(row2.total_dividends).toBeCloseTo(22, 6);
  });

  it("pairing never crosses a security or an account", () => {
    txn(IBKR, sec, "2026-05-01", "DIVIDEND", 5);
    txn(IBKR, other, "2026-05-01", "REINVESTMENT", 5); // other security: unpaired
    txn(TAXABLE, sec, "2026-05-01", "REINVESTMENT", 5); // other account: unpaired
    const rows = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    expect(sum(rows, "total_dividends")).toBeCloseTo(15, 6);
  });

  it("a reinvestment net of same-day foreign tax withheld pairs with its dividend (R2-2)", () => {
    // Dividend 100, 15 withheld, 85 reinvested: one payout of 100 (gross).
    // Before this rule the 85 never paired and the payout read 185.
    txn(IBKR, sec, "2026-07-01", "DIVIDEND", 100);
    txn(IBKR, sec, "2026-07-01", "TAX_WITHHELD", -15);
    txn(IBKR, sec, "2026-07-01", "REINVESTMENT", 85);
    const [row] = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    expect(row.total_dividends).toBeCloseTo(100, 6);
  });

  it("a gross match wins over a net match, and each dividend pairs once (R2-2)", () => {
    // Dividend 100 with 15 withheld, reinvested gross (100): pairs gross.
    // A second reinvestment of 85 the same day finds no dividend left -> +85.
    txn(IBKR, sec, "2026-07-01", "DIVIDEND", 100);
    txn(IBKR, sec, "2026-07-01", "TAX_WITHHELD", -15);
    txn(IBKR, sec, "2026-07-01", "REINVESTMENT", 100);
    txn(IBKR, sec, "2026-07-01", "REINVESTMENT", 85);
    const [row] = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    expect(row.total_dividends).toBeCloseTo(185, 6);
  });

  it("withholding on another day or security does not create a net match (R2-2)", () => {
    txn(IBKR, sec, "2026-07-01", "DIVIDEND", 100);
    txn(IBKR, sec, "2026-07-02", "TAX_WITHHELD", -15); // another day
    txn(IBKR, other, "2026-07-01", "TAX_WITHHELD", -15); // another security
    txn(IBKR, sec, "2026-07-01", "REINVESTMENT", 85);
    const [row] = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    expect(row.total_dividends).toBeCloseTo(185, 6);
  });

  it("a reversed (negative) dividend is netted", () => {
    // Paid 8, reversed -8, re-paid 7: income 7 (old code ABS: 23).
    txn(IBKR, sec, "2026-06-01", "DIVIDEND", 8);
    txn(IBKR, sec, "2026-06-03", "DIVIDEND", -8);
    txn(IBKR, sec, "2026-06-03", "DIVIDEND", 7);
    const [row] = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    expect(row.total_dividends).toBeCloseTo(7, 6);
  });

  it("a negative unpaired reinvestment is not income and is counted", () => {
    txn(IBKR, sec, "2026-06-10", "DIVIDEND", 12);
    txn(IBKR, sec, "2026-06-11", "REINVESTMENT", -9); // no dividend that day
    const [row] = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    expect(row.total_dividends).toBeCloseTo(12, 6);
    expect(row.unpaired_reinvestment_count).toBe(1);
  });

  it("importing the same rows twice through the normal upsert (same source keys) changes nothing", () => {
    seedMainScenario();
    const before = getIncomeSummaryForChat(db, { period: "all_time", group_by: "type" });
    seedMainScenario(); // INSERT OR IGNORE on source_key, as lib/import/engine.ts does
    const after = getIncomeSummaryForChat(db, { period: "all_time", group_by: "type" });
    expect(after).toEqual(before);
  });

  it("group_by=type rows sum to the group_by=account total and to one computed total", () => {
    seedMainScenario();
    txn(TAXABLE, other, "2026-02-14", "DIVIDEND", 20);
    txn(TAXABLE, other, "2026-02-14", "REINVESTMENT", 20);
    // Expected whole-book: dividends 14 + 20 = 34, interest 3, paid 25,
    // fees 2, net 34 + 3 - 25 - 2 = 10.
    const byType = getIncomeSummaryForChat(db, { period: "all_time", group_by: "type" });
    const byAccount = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    const bySymbol = getIncomeSummaryForChat(db, { period: "all_time", group_by: "symbol" });
    const expected = { total_dividends: 34, total_interest: 3, interest_paid: 25, total_fees: 2, net_income: 10 };
    for (const rows of [byType, byAccount, bySymbol]) {
      for (const [field, value] of Object.entries(expected)) {
        expect(Math.abs(sum(rows, field as keyof IncomeResult) - value)).toBeLessThan(0.01);
      }
    }
    // Each row's own net equals its parts.
    for (const r of byType) {
      expect(r.net_income).toBeCloseTo(r.total_dividends + r.total_interest - r.interest_paid - r.total_fees, 6);
    }
  });

  it("an account-id filter reads exactly those accounts; an empty list reads none", () => {
    seedMainScenario();
    txn(TAXABLE, other, "2026-02-14", "DIVIDEND", 20);
    const ibkr = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account", account_ids: [IBKR] });
    expect(ibkr.map((r) => r.group_name)).toEqual(["IBKR"]);
    expect(sum(ibkr, "total_dividends")).toBeCloseTo(14, 6);
    expect(getIncomeSummaryForChat(db, { period: "all_time", account_ids: [] })).toEqual([]);
    // account_name still works for existing callers.
    const byName = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account", account_name: "IBKR" });
    expect(byName).toEqual(ibkr);
  });
});

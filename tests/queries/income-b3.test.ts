/**
 * B3 / plan O3: the dashboard income reader (Income & Yield section) uses
 * the same Contract J semantics as the chat tool, because the read-only
 * count on a copy of the live database found reinvestment rows paired with
 * same-day dividends and negative interest rows (counts only, 2026-11-11).
 *
 * Worked example (same scenario as tests/queries/chat-tools-income-b3.test.ts):
 *   dividends 10 (reinvested, counted once) + lone reinvestment 4 = 14
 *   interest earned 3, interest paid 25, fees 2
 *   net income = 14 + 3 - 25 - 2 = -10
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getIncomeSummary } from "@/lib/queries/income";
import { getIncomeSummaryForChat } from "@/lib/queries/chat-tools";

const IBKR = 3;
const TAXABLE = 1;
const START = "2026-01-01";
const END = "2026-12-31";

let db: Database.Database;
let sec: number;
let other: number;
let n = 0;

function txn(account: number, security: number | null, date: string, type: string, amount: number) {
  n += 1;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, amount, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(account, security, date, type, amount, `inc-b3-${n}`);
}

beforeEach(() => {
  n = 0;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  sec = db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('AAA', 'AAA', 'ETF')").run()
    .lastInsertRowid as number;
  other = db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('BBB', 'BBB', 'ETF')").run()
    .lastInsertRowid as number;
  txn(IBKR, sec, "2026-03-02", "DIVIDEND", 10);
  txn(IBKR, sec, "2026-03-02", "REINVESTMENT", 10);
  txn(IBKR, sec, "2026-04-01", "REINVESTMENT", 4);
  txn(IBKR, null, "2026-03-31", "INTEREST", -25);
  txn(IBKR, null, "2026-04-30", "INTEREST", 3);
  txn(IBKR, null, "2026-04-30", "FEE", -2);
});

describe("getIncomeSummary income semantics (B3)", () => {
  it("a reinvested dividend counts once and charged interest is a cost", () => {
    const s = getIncomeSummary(db, START, END);
    expect(s.totalDividends).toBeCloseTo(14, 6);
    expect(s.totalInterest).toBeCloseTo(3, 6);
    expect(s.totalInterestPaid).toBeCloseTo(25, 6);
    expect(s.totalFees).toBeCloseTo(2, 6);
    expect(s.netIncome).toBeCloseTo(-10, 6);
    expect(s.byAccount).toHaveLength(1);
    expect(s.byAccount[0].dividends).toBeCloseTo(14, 6);
    expect(s.byAccount[0].interest).toBeCloseTo(3, 6);
    expect(s.byAccount[0].interestPaid).toBeCloseTo(25, 6);
    expect(s.topPayers.find((p) => p.symbol === "AAA")?.dividends).toBeCloseTo(14, 6);
  });

  it("per-account rows sum to the totals, and agree with the chat tool", () => {
    txn(TAXABLE, other, "2026-02-14", "DIVIDEND", 20);
    txn(TAXABLE, other, "2026-02-14", "REINVESTMENT", 20);
    const s = getIncomeSummary(db, START, END);
    const sum = (f: "dividends" | "interest" | "interestPaid" | "fees") =>
      s.byAccount.reduce((acc, a) => acc + a[f], 0);
    expect(Math.abs(sum("dividends") - s.totalDividends)).toBeLessThan(0.01);
    expect(Math.abs(sum("interest") - s.totalInterest)).toBeLessThan(0.01);
    expect(Math.abs(sum("interestPaid") - s.totalInterestPaid)).toBeLessThan(0.01);
    expect(Math.abs(sum("fees") - s.totalFees)).toBeLessThan(0.01);
    expect(s.totalDividends).toBeCloseTo(34, 6);
    expect(s.netIncome).toBeCloseTo(10, 6);

    // One source of truth: the chat tool's all-accounts figures match.
    const chat = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    const chatNet = chat.reduce((acc, r) => acc + r.net_income, 0);
    expect(Math.abs(chatNet - s.netIncome)).toBeLessThan(0.01);
  });

  it("an empty account list still reads no account", () => {
    const none = getIncomeSummary(db, START, END, []);
    expect(none.totalDividends).toBe(0);
    expect(none.totalInterestPaid).toBe(0);
    expect(none.netIncome).toBe(0);
    expect(none.byAccount).toEqual([]);
  });
});

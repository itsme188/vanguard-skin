/**
 * Review R2-1: the Income & Yield card shows interest paid, its by-account
 * Total subtracts it, and the empty state is "no income rows at all", not a
 * zero net.
 *
 * Worked example (the reviewer's probe): IBKR dividends 10, interest earned
 * 3, interest paid 25, fees 2 -> Total 10 + 3 - 25 - 2 = -14; Vanguard
 * Taxable dividends 5 -> Total 5. Net income tile = -9 = -14 + 5 (the old
 * Total column read 11 and 5, summing to 16 against a tile of -9).
 *
 * The repo has no DOM harness: the arithmetic is a pure function in
 * lib/queries/income.ts, and the component is pinned to call it.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { accountIncomeTotal, getIncomeSummary, hasIncomeActivity } from "@/lib/queries/income";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const START = "2026-01-01";
const END = "2026-12-31";
let db: Database.Database;
let n = 0;

function txn(account: number, security: number | null, type: string, amount: number) {
  n += 1;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, amount, source_key)
     VALUES (?, ?, '2026-03-02', ?, ?, ?)`
  ).run(account, security, type, amount, `iys-${n}`);
}

beforeEach(() => {
  n = 0;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("income card arithmetic (R2-1)", () => {
  it("by-account totals sum to the net income tile to the cent", () => {
    const sec = db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('AAA', 'AAA', 'ETF')").run()
      .lastInsertRowid as number;
    txn(3, sec, "DIVIDEND", 10);
    txn(3, null, "INTEREST", 3);
    txn(3, null, "INTEREST", -25);
    txn(3, null, "FEE", -2);
    txn(1, sec, "DIVIDEND", 5);
    const s = getIncomeSummary(db, START, END);
    const ibkr = s.byAccount.find((a) => a.accountName === "IBKR")!;
    expect(accountIncomeTotal(ibkr)).toBeCloseTo(-14, 6);
    expect(s.netIncome).toBeCloseTo(-9, 6);
    const cents = (x: number) => Math.round(x * 100);
    expect(cents(s.byAccount.reduce((acc, a) => acc + accountIncomeTotal(a), 0))).toBe(cents(s.netIncome));
  });

  it("income exactly offset by margin interest is not an empty card", () => {
    txn(3, null, "INTEREST", 25);
    txn(3, null, "INTEREST", -25);
    const s = getIncomeSummary(db, START, END);
    expect(s.netIncome).toBe(0);
    expect(hasIncomeActivity(s)).toBe(true);
  });

  it("no income rows at all is the empty card", () => {
    txn(3, null, "DEPOSIT", 500);
    expect(hasIncomeActivity(getIncomeSummary(db, START, END))).toBe(false);
  });
});

describe("IncomeYieldSection source pins (R2-1)", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../app/dashboard/components/IncomeYieldSection.tsx"),
    "utf8"
  );

  it("keys the empty state on income rows, not on a zero net", () => {
    anchorIndex(src, "if (!hasIncomeActivity(summary))");
    expect(src).not.toMatch(/netIncome === 0/);
  });

  it("shows an Interest paid tile through Money, as a cost", () => {
    anchorIndex(src, '<KpiCell label="Interest paid" value={-summary.totalInterestPaid} />');
  });

  it("the by-account table has an Interest paid column and a Total from accountIncomeTotal", () => {
    const table = sliceBetween(src, "By account", "</table>");
    anchorIndex(table, ">Interest paid</th>");
    anchorIndex(table, "<Money value={-a.interestPaid} />");
    anchorIndex(table, "<Money value={accountIncomeTotal(a)} />");
    expect(table).not.toMatch(/a\.dividends \+ a\.interest - a\.fees/);
  });
});

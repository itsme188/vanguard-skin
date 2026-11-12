/**
 * Reinvestment pairing across nearby dates (2026-11-12 ruling).
 *
 * A broker can date a reinvestment a day or so away from its dividend
 * (month-end offsets; a dividend on the last day of a month reinvested on
 * the first of the next). A REINVESTMENT may pair with a DIVIDEND in the
 * same account and security up to 3 calendar days either side, under the
 * unchanged amount rules (gross to the cent, or net of ONE withholding row
 * dated on the dividend's or the reinvestment's day). Same date first, then the nearest; one to
 * one. A paired reinvestment adds nothing, so the pair's income is counted
 * once, on the DIVIDEND's date: a window or a month bucket that holds only
 * the reinvestment shows nothing for it, and one that holds only the
 * dividend shows the whole amount.
 *
 * Synthetic figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getIncomeSummaryForChat } from "@/lib/queries/chat-tools";
import { getIncomeSummary, accountIncomeTotal } from "@/lib/queries/income";
import { loadIncomeLegs, pairIncomeLegs, INCOME_PAIR_MAX_GAP_DAYS } from "@/lib/queries/income-sql";

const IBKR = 3;
let db: Database.Database;
let sec: number;
let n = 0;

function txn(type: string, amount: number, date: string, account = IBKR, security: number | null = sec): number {
  n += 1;
  return db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, amount, source_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(account, security, date, type, amount, `gap-${n}`).lastInsertRowid as number;
}

function pairs() {
  const p = pairIncomeLegs(loadIncomeLegs(db));
  const used = [
    ...p.map((x) => `r${x.reinvestmentId}`),
    ...p.map((x) => `d${x.dividendId}`),
    ...p.filter((x) => x.withholdingId != null).map((x) => `w${x.withholdingId}`),
  ];
  expect(new Set(used).size).toBe(used.length);
  return p;
}

/** All-time dividend figure, checked through every reader and grouping. */
function expectDividends(expected: number) {
  for (const group_by of ["type", "account", "symbol", "month"] as const) {
    const rows = getIncomeSummaryForChat(db, { period: "all_time", group_by });
    expect(rows.reduce((s, r) => s + r.total_dividends, 0)).toBeCloseTo(expected, 6);
  }
  const dash = getIncomeSummary(db, "2000-01-01", "2099-12-31");
  expect(dash.totalDividends).toBeCloseTo(expected, 6);
  expect(dash.byAccount.reduce((s, a) => s + accountIncomeTotal(a), 0)).toBeCloseTo(dash.netIncome, 6);
}

beforeEach(() => {
  n = 0;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  sec = db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('ZZF', 'ZZF', 'ETF')").run()
    .lastInsertRowid as number;
});

describe("reinvestment pairing within 3 calendar days", () => {
  it("the gap is 3 days", () => {
    expect(INCOME_PAIR_MAX_GAP_DAYS).toBe(3);
  });

  it("same day: unchanged", () => {
    const d = txn("DIVIDEND", 40, "2026-07-01");
    const r = txn("REINVESTMENT", 40, "2026-07-01");
    expect(pairs()).toEqual([{ reinvestmentId: r, dividendId: d, withholdingId: null }]);
    expectDividends(40);
  });

  it("reinvestment one day before its dividend pairs", () => {
    const r = txn("REINVESTMENT", 40, "2026-06-30");
    const d = txn("DIVIDEND", 40, "2026-07-01");
    expect(pairs()).toEqual([{ reinvestmentId: r, dividendId: d, withholdingId: null }]);
    expectDividends(40);
  });

  it("reinvestment one day after its dividend pairs", () => {
    const d = txn("DIVIDEND", 40, "2026-07-01");
    const r = txn("REINVESTMENT", 40, "2026-07-02");
    expect(pairs()).toEqual([{ reinvestmentId: r, dividendId: d, withholdingId: null }]);
    expectDividends(40);
  });

  it("three days either side pairs", () => {
    txn("DIVIDEND", 40, "2026-07-01");
    txn("REINVESTMENT", 40, "2026-07-04");
    txn("DIVIDEND", 25, "2026-08-10");
    txn("REINVESTMENT", 25, "2026-08-07");
    expect(pairs()).toHaveLength(2);
    expectDividends(65);
  });

  it("four days does NOT pair, either side", () => {
    txn("DIVIDEND", 40, "2026-07-01");
    txn("REINVESTMENT", 40, "2026-07-05");
    txn("DIVIDEND", 25, "2026-08-10");
    txn("REINVESTMENT", 25, "2026-08-06");
    expect(pairs()).toHaveLength(0);
    expectDividends(130);
  });

  it("the gap is in calendar days across a month and a year end", () => {
    const d = txn("DIVIDEND", 40, "2025-12-31");
    const r = txn("REINVESTMENT", 40, "2026-01-03");
    expect(pairs()).toEqual([{ reinvestmentId: r, dividendId: d, withholdingId: null }]);
    txn("DIVIDEND", 25, "2026-02-28");
    txn("REINVESTMENT", 25, "2026-03-04"); // 4 days in 2026 (not a leap year)
    expect(pairs()).toHaveLength(1);
  });

  it("the amount rules are not loosened by the date window", () => {
    txn("DIVIDEND", 40, "2026-07-01");
    txn("REINVESTMENT", 40.01, "2026-07-02");
    expect(pairs()).toHaveLength(0);
    expectDividends(80.01);
  });

  it("two equal dividends near one reinvestment: one pair, the nearest wins", () => {
    txn("DIVIDEND", 40, "2026-06-29"); // 2 days before
    const near = txn("DIVIDEND", 40, "2026-07-02"); // 1 day after
    const r = txn("REINVESTMENT", 40, "2026-07-01");
    expect(pairs()).toEqual([{ reinvestmentId: r, dividendId: near, withholdingId: null }]);
    expectDividends(80);
  });

  it("equally near on both sides: the earlier dividend wins (deterministic)", () => {
    const before = txn("DIVIDEND", 40, "2026-06-30");
    txn("DIVIDEND", 40, "2026-07-02");
    const r = txn("REINVESTMENT", 40, "2026-07-01");
    expect(pairs()).toEqual([{ reinvestmentId: r, dividendId: before, withholdingId: null }]);
    expectDividends(80);
  });

  it("a same-day pair is never taken by a reinvestment on another day", () => {
    const d = txn("DIVIDEND", 40, "2026-07-01");
    txn("REINVESTMENT", 40, "2026-06-30"); // lower id, one day off
    const same = txn("REINVESTMENT", 40, "2026-07-01");
    expect(pairs()).toEqual([{ reinvestmentId: same, dividendId: d, withholdingId: null }]);
    expectDividends(80);
  });

  it("one dividend, two reinvestments a day either side: only one pairs", () => {
    txn("DIVIDEND", 40, "2026-07-01");
    txn("REINVESTMENT", 40, "2026-06-30");
    txn("REINVESTMENT", 40, "2026-07-02");
    expect(pairs()).toHaveLength(1);
    expectDividends(80);
  });

  it("net of one withholding, reinvested a day later", () => {
    const d = txn("DIVIDEND", 100, "2026-07-31");
    const w = txn("TAX_WITHHELD", 15, "2026-07-31");
    const r = txn("REINVESTMENT", 85, "2026-08-01");
    expect(pairs()).toEqual([{ reinvestmentId: r, dividendId: d, withholdingId: w }]);
    expectDividends(100);
  });

  it("net match with the withholding dated on the reinvestment's day", () => {
    const d = txn("DIVIDEND", 100, "2026-07-31");
    const w = txn("TAX_WITHHELD", -15, "2026-08-01");
    const r = txn("REINVESTMENT", 85, "2026-08-01");
    expect(pairs()).toEqual([{ reinvestmentId: r, dividendId: d, withholdingId: w }]);
    expectDividends(100);
  });

  it("the dividend's-day withholding is used before the reinvestment's-day one", () => {
    const d = txn("DIVIDEND", 100, "2026-07-31");
    txn("TAX_WITHHELD", -15, "2026-08-01");
    const onDividendDay = txn("TAX_WITHHELD", -15, "2026-07-31");
    const r = txn("REINVESTMENT", 85, "2026-08-01");
    expect(pairs()).toEqual([{ reinvestmentId: r, dividendId: d, withholdingId: onDividendDay }]);
  });

  it("a withholding on neither the dividend's nor the reinvestment's day never fits", () => {
    txn("DIVIDEND", 100, "2026-07-30");
    txn("TAX_WITHHELD", -15, "2026-07-31");
    txn("REINVESTMENT", 85, "2026-08-01");
    expect(pairs()).toHaveLength(0);
    expectDividends(185);
  });

  it("never crosses a security or an account, whatever the date", () => {
    const other = db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('YYF', 'YYF', 'ETF')").run()
      .lastInsertRowid as number;
    txn("DIVIDEND", 40, "2026-07-01");
    txn("REINVESTMENT", 40, "2026-07-02", IBKR, other);
    txn("REINVESTMENT", 40, "2026-07-02", 1);
    expect(pairs()).toHaveLength(0);
    expectDividends(120);
  });
});

describe("a pair that straddles a period edge is counted once, on the dividend's date", () => {
  it("month end: the dividend's month holds the amount, the reinvestment's month nothing", () => {
    txn("DIVIDEND", 40, "2026-07-31");
    txn("REINVESTMENT", 40, "2026-08-01");
    const rows = getIncomeSummaryForChat(db, { period: "all_time", group_by: "month" });
    const byMonth = Object.fromEntries(rows.map((r) => [r.group_name, r.total_dividends]));
    expect(byMonth["2026-07"]).toBeCloseTo(40, 6);
    expect(byMonth["2026-08"] ?? 0).toBeCloseTo(0, 6);
  });

  it("window end: dividend inside, reinvestment after -> counted inside", () => {
    txn("DIVIDEND", 40, "2026-07-31");
    txn("REINVESTMENT", 40, "2026-08-01");
    const inside = getIncomeSummary(db, "2026-07-01", "2026-07-31");
    const after = getIncomeSummary(db, "2026-08-01", "2026-08-31");
    expect(inside.totalDividends).toBeCloseTo(40, 6);
    expect(after.totalDividends).toBeCloseTo(0, 6);
    expect(inside.byAccount.reduce((s, a) => s + accountIncomeTotal(a), 0)).toBeCloseTo(inside.netIncome, 6);
    expect(after.byAccount.reduce((s, a) => s + accountIncomeTotal(a), 0)).toBeCloseTo(after.netIncome, 6);
  });

  it("window start: reinvestment inside, dividend before -> counted before, not inside", () => {
    txn("REINVESTMENT", 40, "2026-08-01");
    txn("DIVIDEND", 40, "2026-07-30");
    const before = getIncomeSummary(db, "2026-07-01", "2026-07-31");
    const inside = getIncomeSummary(db, "2026-08-01", "2026-08-31");
    expect(before.totalDividends).toBeCloseTo(40, 6);
    expect(inside.totalDividends).toBeCloseTo(0, 6);
    // Adjacent windows add up to the whole: nothing vanishes, nothing doubles.
    const whole = getIncomeSummary(db, "2026-07-01", "2026-08-31");
    expect(before.totalDividends + inside.totalDividends).toBeCloseTo(whole.totalDividends, 6);
    expect(whole.totalDividends).toBeCloseTo(40, 6);
  });
});

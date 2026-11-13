/**
 * RF-6: reinvestment pairing is one-to-one all the way down. A
 * reinvestment pairs with ONE dividend, either gross (equal amount) or net
 * of ONE withholding row on that dividend (dividend - |withholding| =
 * reinvestment, to the cent). A withholding row serves at most one
 * dividend; a dividend at most one reinvestment. Tie-break: amount, then
 * row id (lowest first).
 *
 * Every case asserts the hand-worked dividend figure, that the chat tool
 * and the dashboard reader agree, and that the by-type, by-account,
 * by-symbol and by-month rows each sum to the same total.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getIncomeSummaryForChat } from "@/lib/queries/chat-tools";
import { getIncomeSummary } from "@/lib/queries/income";
import { loadIncomeLegs, pairIncomeLegs, pairIncomeLegsWithStatus } from "@/lib/queries/income-sql";

const IBKR = 3;
const DAY = "2026-07-01";
let db: Database.Database;
let sec: number;
let n = 0;

function txn(type: string, amount: number, date = DAY, account = IBKR, security: number | null = sec): number {
  n += 1;
  return db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, amount, source_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(account, security, date, type, amount, `rf6-${n}`).lastInsertRowid as number;
}

/** The hand-worked dividend figure, checked every way the readers offer. */
function expectDividends(expected: number) {
  const totals: number[] = [];
  for (const group_by of ["type", "account", "symbol", "month"] as const) {
    const rows = getIncomeSummaryForChat(db, { period: "all_time", group_by });
    totals.push(rows.reduce((s, r) => s + r.total_dividends, 0));
    const net = rows.reduce((s, r) => s + r.net_income, 0);
    const parts = rows.reduce((s, r) => s + r.total_dividends + r.total_interest - r.interest_paid - r.total_fees, 0);
    expect(net).toBeCloseTo(parts, 6);
  }
  for (const t of totals) expect(t).toBeCloseTo(expected, 6);
  const dashboard = getIncomeSummary(db, "2000-01-01", "2026-12-31");
  expect(dashboard.totalDividends).toBeCloseTo(expected, 6);
  expect(dashboard.byAccount.reduce((s, a) => s + a.dividends, 0)).toBeCloseTo(expected, 6);
}

/** No row serves two pairs. */
function expectOneToOne() {
  const pairs = pairIncomeLegs(loadIncomeLegs(db));
  const used = [
    ...pairs.map((p) => `r${p.reinvestmentId}`),
    ...pairs.map((p) => `d${p.dividendId}`),
    ...pairs.filter((p) => p.withholdingId != null).map((p) => `w${p.withholdingId}`),
  ];
  expect(new Set(used).size).toBe(used.length);
  return pairs;
}

// Every fixture here pairs exactly: the search budget is never hit.
afterEach(() => {
  expect(pairIncomeLegsWithStatus(loadIncomeLegs(db)).approximate).toEqual([]);
});

beforeEach(() => {
  n = 0;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  sec = db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('ZZF', 'ZZF', 'ETF')").run()
    .lastInsertRowid as number;
});

describe("one-to-one reinvestment pairing (RF-6)", () => {
  it("two withheld dividends on one day: 100 and 50, both reinvested net -> 150", () => {
    // Old rule subtracted the day's total withholding (22.5) from each
    // dividend, matched neither, and read 100 + 85 + 50 + 42.5 = 277.5.
    txn("DIVIDEND", 100);
    txn("TAX_WITHHELD", -15);
    txn("REINVESTMENT", 85);
    txn("DIVIDEND", 50);
    txn("TAX_WITHHELD", -7.5);
    txn("REINVESTMENT", 42.5);
    expectDividends(150);
    const pairs = expectOneToOne();
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.withholdingId != null)).toBe(true);
  });

  it("one withholding row: one pair net, the other gross -> 150", () => {
    txn("DIVIDEND", 100);
    txn("TAX_WITHHELD", -15);
    txn("REINVESTMENT", 85);
    txn("DIVIDEND", 50);
    txn("REINVESTMENT", 50);
    expectDividends(150);
    const pairs = expectOneToOne();
    expect(pairs).toHaveLength(2);
    expect(pairs.filter((p) => p.withholdingId == null)).toHaveLength(1);
  });

  it("three dividends, two withholdings, three reinvestments in mixed id order -> 60", () => {
    // 10 reinvested gross; 30 - 3 = 27 and 20 - 2 = 18 reinvested net.
    // The crossed sums (30 - 2 = 28, 20 - 3 = 17) match nothing.
    txn("REINVESTMENT", 18);
    txn("DIVIDEND", 10);
    txn("TAX_WITHHELD", -2);
    txn("REINVESTMENT", 27);
    const d30 = txn("DIVIDEND", 30);
    const w3 = txn("TAX_WITHHELD", -3);
    txn("DIVIDEND", 20);
    txn("REINVESTMENT", 10);
    expectDividends(60);
    const pairs = expectOneToOne();
    expect(pairs).toHaveLength(3);
    expect(pairs.find((p) => p.dividendId === d30)?.withholdingId).toBe(w3);
  });

  it("several assignments fit: the lowest amount, then the lowest row id, wins", () => {
    const first = txn("DIVIDEND", 20);
    const second = txn("DIVIDEND", 20);
    txn("TAX_WITHHELD", -2);
    txn("REINVESTMENT", 18);
    expectDividends(40); // either way the payouts count once each
    const pairs = expectOneToOne();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].dividendId).toBe(first);
    expect(pairs[0].dividendId).not.toBe(second);
  });

  it("a withholding with no reinvestment: the dividend counts gross once", () => {
    txn("DIVIDEND", 100);
    txn("TAX_WITHHELD", -15);
    expectDividends(100);
    expect(expectOneToOne()).toHaveLength(0);
  });

  it("a withholding stored positive pairs the same as one stored negative", () => {
    // The ledger holds both signs for withheld tax: 100 - |+15| = 85.
    txn("DIVIDEND", 100);
    txn("TAX_WITHHELD", 15);
    txn("REINVESTMENT", 85);
    expectDividends(100);
    expect(expectOneToOne()).toHaveLength(1);
  });

  it("a withholding larger than the dividend never makes a net match", () => {
    // 10 - 15 = -5: no reinvestment of 5 is its purchase leg, so the 5 is
    // an unpaired positive reinvestment: 10 + 5 = 15.
    txn("DIVIDEND", 10);
    txn("TAX_WITHHELD", -15);
    txn("REINVESTMENT", 5);
    expectDividends(15);
    expect(expectOneToOne()).toHaveLength(0);
  });

  it("a reversed dividend and refunded tax net to zero", () => {
    // Paid 100, 15 withheld, 85 reinvested; then reversed (-100) and the
    // tax refunded (+15). Income 100 - 100 = 0; the 85 is the paid
    // dividend's purchase leg. The +15 is on another day with no
    // reinvestment, so it pairs with nothing.
    txn("DIVIDEND", 100);
    txn("TAX_WITHHELD", -15);
    txn("REINVESTMENT", 85);
    txn("DIVIDEND", -100, "2026-07-08");
    txn("TAX_WITHHELD", 15, "2026-07-08");
    expectDividends(0);
    expect(expectOneToOne()).toHaveLength(1);
  });

  it("a withholding on another day, security or account never makes a net match", () => {
    const other = db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('YYF', 'YYF', 'ETF')").run()
      .lastInsertRowid as number;
    txn("DIVIDEND", 100);
    txn("TAX_WITHHELD", -15, "2026-07-02"); // another day
    txn("TAX_WITHHELD", -15, DAY, IBKR, other); // another security
    txn("TAX_WITHHELD", -15, DAY, 1); // another account
    txn("REINVESTMENT", 85);
    expectDividends(185);
  });

  it("stays fast on 20000 rows", () => {
    const secs: number[] = [];
    for (let i = 0; i < 50; i++) {
      secs.push(
        db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'ETF')").run(`P${i}`, `P${i}`)
          .lastInsertRowid as number
      );
    }
    const insert = db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, amount, source_key) VALUES (?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        const s = secs[i % 50];
        const day = `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;
        const amt = 10 + (i % 90);
        insert.run(IBKR, s, day, "DIVIDEND", amt, `perf-d-${i}`);
        insert.run(IBKR, s, day, "TAX_WITHHELD", -1, `perf-w-${i}`);
        insert.run(IBKR, s, day, "REINVESTMENT", amt - 1, `perf-r-${i}`);
        insert.run(IBKR, null, day, "INTEREST", 1, `perf-i-${i}`);
      }
    })();
    const t0 = performance.now();
    getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    const ms = performance.now() - t0;
    console.log(`[rf6] income summary over 20000 rows: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
  });
});

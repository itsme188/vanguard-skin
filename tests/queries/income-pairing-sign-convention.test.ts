/**
 * Reinvestment pairing reads each leg's MEANING, not its raw sign
 * (2026-11-12, after the eval fixture showed DIVIDEND +120 / REINVESTMENT
 * -120 unpaired).
 *
 * - A DIVIDEND is a payment (positive) or a charge / reversal (negative):
 *   every importer agrees.
 * - A REINVESTMENT is a purchase or a reversal, read through its importer's
 *   convention, which the row carries in its source_key:
 *     * `vanguard-pdf:` and `vanguard-export:` store the broker's signed cash
 *       effect: a purchase is NEGATIVE (a positive row is a reversal);
 *     * every other row follows the documented ledger convention
 *       (docs/reference/conventions-detail.md, canonical CSV): a purchase is
 *       POSITIVE (a negative row is a reversal).
 * - A payment pairs with a purchase; a reversal with a reversal; net of
 *   withholding needs a payment and a purchase.
 * - An unpaired purchase counts as dividend income; an unpaired reversal is
 *   left out and counted in unpaired_reinvestment_count.
 *
 * Synthetic figures only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getIncomeSummaryForChat } from "@/lib/queries/chat-tools";
import { getIncomeSummary, accountIncomeTotal } from "@/lib/queries/income";
import { loadIncomeLegs, pairIncomeLegs, pairIncomeLegsWithStatus, reinvestmentIsPurchase } from "@/lib/queries/income-sql";

const TAXABLE = 1;
let db: Database.Database;
let sec: number;
let n = 0;

type Source = "canonical" | "vanguard-pdf" | "vanguard-export" | "eval";

function txn(type: string, amount: number, date: string, source: Source = "canonical"): number {
  n += 1;
  const key =
    source === "canonical"
      ? `canonical:txn:Vanguard Taxable:ZZF:${date}:${type}:${n}`
      : source === "eval"
        ? `eval:${type}:${TAXABLE}:${sec}:${date}:${n}`
        : `${source}:txn:Vanguard Taxable:${date}:ZZF:${type.toLowerCase()}:${amount}:${n}`;
  return db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, amount, source_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(TAXABLE, sec, date, type, amount, key).lastInsertRowid as number;
}

function summary() {
  const rows = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
  const dash = getIncomeSummary(db, "2000-01-01", "2099-12-31");
  const dividends = rows.reduce((s, r) => s + r.total_dividends, 0);
  expect(dash.totalDividends).toBeCloseTo(dividends, 6);
  expect(dash.byAccount.reduce((s, a) => s + accountIncomeTotal(a), 0)).toBeCloseTo(dash.netIncome, 6);
  return { dividends, leftOut: rows.reduce((s, r) => s + r.unpaired_reinvestment_count, 0) };
}

const pairs = () => pairIncomeLegs(loadIncomeLegs(db));

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

describe("which way a reinvestment row points", () => {
  it("reads the importer from the source key", () => {
    expect(reinvestmentIsPurchase(40, "canonical:txn:x")).toBe(true);
    expect(reinvestmentIsPurchase(-40, "canonical:txn:x")).toBe(false);
    expect(reinvestmentIsPurchase(-40, "vanguard-pdf:txn:x")).toBe(true);
    expect(reinvestmentIsPurchase(40, "vanguard-pdf:txn:x")).toBe(false);
    expect(reinvestmentIsPurchase(-40, "vanguard-export:txn:x")).toBe(true);
    expect(reinvestmentIsPurchase(40, "vanguard-export:txn:x")).toBe(false);
    expect(reinvestmentIsPurchase(40, null)).toBe(true);
    expect(reinvestmentIsPurchase(-40, "eval:REINVESTMENT:1")).toBe(false);
  });
});

describe("documented convention (canonical CSV): a purchase is positive", () => {
  it("payment + purchase pair", () => {
    txn("DIVIDEND", 40, "2026-07-01");
    txn("REINVESTMENT", 40, "2026-07-01");
    expect(pairs()).toHaveLength(1);
    expect(summary()).toEqual({ dividends: 40, leftOut: 0 });
  });

  it("a reversal of both legs pairs and still reduces income", () => {
    txn("DIVIDEND", -40, "2026-07-01");
    txn("REINVESTMENT", -40, "2026-07-01");
    expect(pairs()).toHaveLength(1);
    expect(summary()).toEqual({ dividends: -40, leftOut: 0 });
  });

  it("a charge never hides a purchase", () => {
    txn("DIVIDEND", -40, "2026-07-01");
    txn("REINVESTMENT", 40, "2026-07-01");
    expect(pairs()).toHaveLength(0);
    expect(summary()).toEqual({ dividends: 0, leftOut: 0 });
  });

  it("an unpaired reversal is left out and counted", () => {
    txn("REINVESTMENT", -25, "2026-07-01");
    expect(summary()).toEqual({ dividends: 0, leftOut: 1 });
  });
});

describe.each(["vanguard-pdf", "vanguard-export"] as const)("broker cash effect (%s): a purchase is negative", (source) => {
  it("payment + purchase pair (Dividend +120, Reinvestment -120 same day)", () => {
    const d = txn("DIVIDEND", 120, "2026-09-28", source);
    const r = txn("REINVESTMENT", -120, "2026-09-28", source);
    expect(pairs()).toEqual([{ reinvestmentId: r, dividendId: d, withholdingId: null }]);
    expect(summary()).toEqual({ dividends: 120, leftOut: 0 });
  });

  it("net of withholding, a day apart", () => {
    txn("DIVIDEND", 100, "2026-07-31", source);
    txn("TAX_WITHHELD", -15, "2026-07-31", source);
    txn("REINVESTMENT", -85, "2026-08-01", source);
    expect(pairs()).toHaveLength(1);
    expect(summary()).toEqual({ dividends: 100, leftOut: 0 });
  });

  it("a reversal of both legs pairs and still reduces income", () => {
    txn("DIVIDEND", -40, "2026-07-01", source);
    txn("REINVESTMENT", 40, "2026-07-01", source);
    expect(pairs()).toHaveLength(1);
    expect(summary()).toEqual({ dividends: -40, leftOut: 0 });
  });

  it("a charge never hides a purchase", () => {
    txn("DIVIDEND", -40, "2026-07-01", source);
    txn("REINVESTMENT", -40, "2026-07-01", source);
    expect(pairs()).toHaveLength(0);
    expect(summary()).toEqual({ dividends: 0, leftOut: 0 }); // -40 charge, +40 unpaired purchase
  });

  it("an unpaired purchase counts as income; an unpaired reversal is left out", () => {
    txn("REINVESTMENT", -25, "2026-07-01", source);
    expect(summary()).toEqual({ dividends: 25, leftOut: 0 });
    txn("REINVESTMENT", 10, "2026-08-01", source);
    expect(summary()).toEqual({ dividends: 25, leftOut: 1 });
  });
});

describe("the two conventions side by side in one security", () => {
  it("each row is read through its own importer", () => {
    txn("DIVIDEND", 30, "2026-06-01", "canonical");
    txn("REINVESTMENT", 30, "2026-06-01", "canonical");
    txn("DIVIDEND", 30, "2026-07-01", "vanguard-pdf");
    txn("REINVESTMENT", -30, "2026-07-01", "vanguard-pdf");
    expect(pairs()).toHaveLength(2);
    expect(summary()).toEqual({ dividends: 60, leftOut: 0 });
  });
});

describe("a row from no importer follows the documented convention", () => {
  it("an eval-fixture REINVESTMENT -120 is read as a reversal, not a purchase", () => {
    // The fixture writes the broker's cash-effect sign under an `eval:` key,
    // which names no importer that uses that convention.
    txn("DIVIDEND", 120, "2026-09-28", "eval");
    txn("REINVESTMENT", -120, "2026-09-28", "eval");
    expect(pairs()).toHaveLength(0);
    expect(summary()).toEqual({ dividends: 120, leftOut: 1 });
  });
});

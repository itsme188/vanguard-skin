/**
 * The Fixed Income card's "Bond Allocation" and its "X of Y" total must use
 * the SAME portfolio total as the Allocation breakdown on the same page:
 * latest holdings per (account, security) INCLUDING shorts (signed), an
 * unpriced position at its cost basis, matured bonds and expired options
 * left out. Pre-fix the card dropped shorts and unpriced positions, so its
 * bond share differed from the breakdown's Bond row.
 * Synthetic symbols and round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { computeFixedIncomeExposure } from "@/lib/compute/fixed-income-exposure";
import { getAllocationByDimension } from "@/lib/queries/analysis";

let db: Database.Database;
let acctA: number;
let acctB: number;
const TODAY = todayET();
const DAY = addDays(TODAY, -1);

function seed(
  account: number,
  symbol: string,
  type: string,
  qty: number,
  price: number | null,
  opts: { maturity?: string; costBasis?: number } = {},
) {
  const existing = db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as { id: number } | undefined;
  const id =
    existing?.id ??
    (db
      .prepare("INSERT INTO securities (symbol, name, security_type, currency, multiplier, maturity_date) VALUES (?, ?, ?, 'USD', 1, ?)")
      .run(symbol, symbol, type, opts.maturity ?? null).lastInsertRowid as number);
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(account, id, qty, opts.costBasis ?? null, DAY, `t:${account}:${symbol}`);
  if (price != null && !existing) {
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(id, DAY, price);
  }
}

function bondRowPct(ids?: number[]): number {
  return getAllocationByDimension(db, "asset_class", ids).find((e) => e.group_name === "Bond")!.percentage!;
}

function breakdownTotal(ids?: number[]): number {
  return getAllocationByDimension(db, "asset_class", ids).reduce((s, e) => s + e.total_market_value, 0);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('ZZ One'), ('ZZ Two')").run();
  acctA = (db.prepare("SELECT id FROM accounts WHERE name = 'ZZ One'").get() as { id: number }).id;
  acctB = (db.prepare("SELECT id FROM accounts WHERE name = 'ZZ Two'").get() as { id: number }).id;

  seed(acctA, "ZZBOND", "Bond", 10_000, 100, { maturity: addDays(TODAY, 3650) }); // 10,000
  seed(acctA, "ZZA", "Stock", 100, 100); // 10,000
  seed(acctA, "ZZS", "Stock", -20, 100); // short, -2,000
  seed(acctB, "ZZU", "Stock", 10, null, { costBasis: 3_000 }); // unpriced, at cost 3,000
  seed(acctB, "ZZOLD", "Bond", 5_000, 100, { maturity: addDays(TODAY, -30) }); // matured, out
  seed(acctB, "ZZA", "Stock", 50, null); // second leg of ZZA, 5,000
});

describe("E3: the Fixed Income card's portfolio total is the Allocation breakdown's", () => {
  it("whole book: bond share equals the breakdown's Bond row", () => {
    const fi = computeFixedIncomeExposure(db, undefined, TODAY);
    expect(fi.portfolioValue).toBeCloseTo(breakdownTotal(), 6);
    expect(fi.portfolioValue).toBeCloseTo(10_000 + 15_000 - 2_000 + 3_000, 6);
    expect(fi.bondAllocationPct).toBeCloseTo(bondRowPct(), 9);
  });

  it("one-account scopes match too", () => {
    for (const ids of [[acctA], [acctB], [acctA, acctB]]) {
      const fi = computeFixedIncomeExposure(db, ids, TODAY);
      expect(fi.portfolioValue).toBeCloseTo(breakdownTotal(ids), 6);
    }
    expect(computeFixedIncomeExposure(db, [acctA], TODAY).bondAllocationPct).toBeCloseTo(bondRowPct([acctA]), 9);
  });

  it("a defined empty scope is no accounts", () => {
    const fi = computeFixedIncomeExposure(db, [], TODAY);
    expect(fi.portfolioValue).toBe(0);
    expect(fi.bonds).toHaveLength(0);
  });
});

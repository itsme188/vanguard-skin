// tests/compute/exposure-cross-account-e1.test.ts
//
// One option contract held in two accounts is two holdings rows. Each row
// must carry only ITS OWN delta exposure: the pre-fix map summed the contract
// across accounts and every row read that whole total, so two rows of one
// contract counted four legs where two are owned, and a long in one account
// plus a short in the other put the same netted figure (zero) in both
// account buckets. Synthetic symbols and round figures only.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import {
  getOptionExposureMap,
  getPortfolioExposureSummary,
  getNetExposureForSymbolFamilies,
} from "@/lib/compute/exposure";
import { getAllocationByDimension } from "@/lib/queries/analysis";

let db: Database.Database;
let acctA: number;
let acctB: number;
let call: number;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedHolding(accountId: number, securityId: number, quantity: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)"
  ).run(accountId, securityId, quantity, addDays(todayET(), -1), `test:${accountId}:${securityId}`);
}

function seedPrice(securityId: number, price: number) {
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, price, addDays(todayET(), -1));
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  acctA = seedAccount("ZZ Alpha");
  acctB = seedAccount("ZZ Beta");
  const stock = db
    .prepare("INSERT INTO securities (symbol, name, security_type, multiplier, currency) VALUES ('ZZA', 'ZZA Inc', 'Stock', 1, 'USD')")
    .run().lastInsertRowid as number;
  seedPrice(stock, 100);
  call = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier, currency)
       VALUES ('ZZA  C90', 'ZZA C90', 'Option', 'ZZA', 'CALL', 90, ?, 100, 'USD')`
    )
    .run(addDays(todayET(), 365)).lastInsertRowid as number;
});

/** One contract's exposure, measured with it held once in one account. */
function oneLeg(): number {
  const solo = getOptionExposureMap(db, [acctA]).get(call)!;
  expect(solo).toBeGreaterThan(0);
  return solo;
}

describe("E1: an option held in two accounts counts once per row", () => {
  it("two long legs in two accounts: net and gross are two legs, not four", () => {
    seedPrice(call, 18);
    seedHolding(acctA, call, 1);
    const leg = oneLeg();
    seedHolding(acctB, call, 1);

    const summary = getPortfolioExposureSummary(db);
    expect(summary.net_exposure).toBeCloseTo(2 * leg, 6);
    expect(summary.gross_exposure).toBeCloseTo(2 * leg, 6);

    const byAccount = getAllocationByDimension(db, "account");
    expect(byAccount.find((e) => e.group_name === "ZZ Alpha")!.net_exposure).toBeCloseTo(leg, 6);
    expect(byAccount.find((e) => e.group_name === "ZZ Beta")!.net_exposure).toBeCloseTo(leg, 6);

    const bySector = getAllocationByDimension(db, "sector");
    expect(bySector.reduce((s, e) => s + e.net_exposure, 0)).toBeCloseTo(2 * leg, 6);

    expect(getNetExposureForSymbolFamilies(db, ["ZZA"]).ZZA).toBeCloseTo(2 * leg, 6);
  });

  it("long in one account and short in the other: net zero, each account bucket keeps its own sign", () => {
    seedPrice(call, 18);
    seedHolding(acctA, call, 1);
    const leg = oneLeg();
    seedHolding(acctB, call, -1);

    const summary = getPortfolioExposureSummary(db);
    expect(summary.net_exposure).toBeCloseTo(0, 6);

    const byAccount = getAllocationByDimension(db, "account");
    expect(byAccount.find((e) => e.group_name === "ZZ Alpha")!.net_exposure).toBeCloseTo(leg, 6);
    expect(byAccount.find((e) => e.group_name === "ZZ Beta")!.net_exposure).toBeCloseTo(-leg, 6);

    // A scope of one account reads that account's leg alone.
    expect(getPortfolioExposureSummary(db, [acctB]).net_exposure).toBeCloseTo(-leg, 6);
  });

  it("an unpriced contract in two accounts still totals two legs", () => {
    // No option price: Greeks run at the fallback vol, the row value is 0.
    seedHolding(acctA, call, 1);
    const leg = oneLeg();
    seedHolding(acctB, call, 1);

    expect(getPortfolioExposureSummary(db).net_exposure).toBeCloseTo(2 * leg, 6);
    const byType = getAllocationByDimension(db, "security_type");
    expect(byType.reduce((s, e) => s + e.net_exposure, 0)).toBeCloseTo(2 * leg, 6);
    expect(getNetExposureForSymbolFamilies(db, ["ZZA"]).ZZA).toBeCloseTo(2 * leg, 6);
  });
});

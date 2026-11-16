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
  exposureForHolding,
  holdingKey,
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

// Review 2026-11-15 (W3): a contract with NO close whose rows did not name
// their account got the netted total split evenly over its rows, so long 2
// in one account and short 1 in another put half the net (half a leg) in
// each account bucket. Every allocation row now names its account, so the
// exact per-account share always applies.
describe("W3: an unpriced contract long in one account and short in another", () => {
  it("each account bucket keeps its own legs (long 2, short 1)", () => {
    seedHolding(acctA, call, 1);
    const leg = oneLeg();
    db.prepare("DELETE FROM holdings").run();
    seedHolding(acctA, call, 2);
    seedHolding(acctB, call, -1);

    const byAccount = getAllocationByDimension(db, "account");
    expect(byAccount.find((e) => e.group_name === "ZZ Alpha")!.net_exposure).toBeCloseTo(2 * leg, 6);
    expect(byAccount.find((e) => e.group_name === "ZZ Beta")!.net_exposure).toBeCloseTo(-leg, 6);
    expect(getPortfolioExposureSummary(db).net_exposure).toBeCloseTo(leg, 6);
  });

  it("the allocation and look-through row queries both select the row's account", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/queries/analysis.ts", "utf8");
    for (const fn of ["export function getAllocationByDimension(", "function getSectorAllocationWithLookThrough("]) {
      const start = src.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf("getOptionExposureMap(db, accountIds)", start));
      expect(body).toMatch(/SELECT\s+[\s\S]*h\.account_id[\s\S]*FROM latest_holdings h/);
    }
  });

  it("a copied map is refused, never read as netted totals", () => {
    seedHolding(acctA, call, 2);
    seedHolding(acctB, call, -1);
    const map = getOptionExposureMap(db);
    const row = { security_id: call, security_type: "Option", option_type: "CALL", mv: 0, account_id: acctA };
    expect(() => exposureForHolding(row, new Map(map) as never)).toThrow(/OptionExposureMap/);
    expect(exposureForHolding(row, map)).toBeCloseTo(map.byHolding.get(holdingKey(acctA, call))!, 6);
  });
});

/**
 * B22 (Portfolio Assistant plan, Task 5): query_options_greeks with an
 * `underlying` returned whole-book totals and strategies beside the filtered
 * positions, so "what's my delta on AAA?" got the whole book's delta.
 *
 * The fix filters inside the engine (one additive `underlying` option on
 * computePortfolioGreeks) BEFORE its own aggregation and coverage step, so the
 * totals keep the engine's rule: per-unit greek x signed quantity x
 * multiplier, summed over priced positions only.
 *
 * Hand-worked fixture (synthetic): AAA at 100 holds a SHORT call (-2) and a
 * long put (+3) - unequal quantities, one short. CCC at 50 holds a covered
 * call (stock + short call). BBB holds 4 calls and has NO price (unpriced).
 *  - filter AAA: 2 of 2 positions priced; totalDelta = d(call)*(-2)*100 +
 *    d(put)*3*100; equal to a book holding only those two positions.
 *  - filter BBB: 0 of 1 priced, totals withheld (null), never zero.
 *  - no filter: 3 of 4 priced (the BBB call is the unpriced one).
 *
 * Protects: the Greeks totals for a filtered underlying. Bound: within 1e-9 of
 * the engine's totals for a book holding only that underlying, and of the sum
 * over the returned positions.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";
import { todayET, addDays } from "@/lib/calendar/date-utils";

const EXPIRY = addDays(todayET(), 120);

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Both books read the same default risk-free rate (nothing cached).
  return db;
}

let nextKey = 0;
function stock(db: Database.Database, symbol: string, price: number | null, qty = 0): void {
  const id = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency, multiplier) VALUES (?, ?, 'stock', 'USD', 1)")
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  if (price != null) {
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(id, todayET(), price);
  }
  if (qty !== 0) holding(db, id, qty);
}
function option(db: Database.Database, und: string, type: "CALL" | "PUT", strike: number, qty: number, mark: number | null): void {
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier, currency)
       VALUES (?, 'option', ?, ?, ?, ?, 100, 'USD')`,
    )
    .run(`${und} ${type} ${strike}`, type, strike, EXPIRY, und).lastInsertRowid as number;
  if (mark != null) db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(id, todayET(), mark);
  holding(db, id, qty);
}
function holding(db: Database.Database, securityId: number, qty: number): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (3, ?, ?, 0, ?, ?)",
  ).run(securityId, qty, todayET(), `g-${nextKey++}`);
}

function seedAaa(db: Database.Database): void {
  stock(db, "AAA", 100);
  option(db, "AAA", "CALL", 105, -2, 4);
  option(db, "AAA", "PUT", 95, 3, 3);
}
function seedWholeBook(db: Database.Database): void {
  seedAaa(db);
  stock(db, "CCC", 50, 100);
  option(db, "CCC", "CALL", 55, -1, 1.5);
  stock(db, "BBB", null);
  option(db, "BBB", "CALL", 20, 4, null);
}

type Portfolio = {
  totalDelta: number | null;
  totalGamma: number | null;
  totalTheta: number | null;
  totalVega: number | null;
  computedPositions: number;
  totalPositions: number;
  note: string | null;
};
type Result = {
  error?: string;
  data: {
    portfolio: Portfolio;
    positions: Array<{ underlying: string; quantity: number; delta?: number; gamma?: number; theta?: number; vega?: number }>;
    strategies: Array<{ underlying: string }>;
    positionCount: number;
  };
};

describe("query_options_greeks with an underlying", () => {
  it("filtered totals equal the engine's totals for a book holding only that underlying", async () => {
    const whole = freshDb();
    seedWholeBook(whole);
    const only = freshDb();
    seedAaa(only);
    const expected = computePortfolioGreeks(only);

    const r = (await executeTool(whole, "query_options_greeks", { underlying: "AAA" })) as Result;
    expect(r.error).toBeUndefined();
    const p = r.data.portfolio;
    expect(p.computedPositions).toBe(2);
    expect(p.totalPositions).toBe(2);
    expect(p.note).toBeNull();
    expect(p.totalDelta).toBeCloseTo(expected.totalDelta, 9);
    expect(p.totalGamma).toBeCloseTo(expected.totalGamma, 9);
    expect(p.totalTheta).toBeCloseTo(expected.totalTheta, 9);
    expect(p.totalVega).toBeCloseTo(expected.totalVega, 9);

    // And the totals are the sum over the filtered positions of
    // per-unit greek x signed quantity x multiplier (100), never a sum of
    // per-unit greeks.
    const sum = (k: "delta" | "gamma" | "theta" | "vega") =>
      r.data.positions.reduce((acc, pos) => acc + (pos[k] as number) * pos.quantity * 100, 0);
    expect(r.data.positions.map((x) => x.underlying)).toEqual(["AAA", "AAA"]);
    expect(p.totalDelta).toBeCloseTo(sum("delta"), 9);
    expect(p.totalGamma).toBeCloseTo(sum("gamma"), 9);
    expect(p.totalTheta).toBeCloseTo(sum("theta"), 9);
    expect(p.totalVega).toBeCloseTo(sum("vega"), 9);
    // A short call's share-equivalent delta is negative: the short is signed.
    const unitSum = r.data.positions.reduce((acc, pos) => acc + (pos.delta as number), 0);
    expect(p.totalDelta).not.toBeCloseTo(unitSum, 3);
  });

  it("the whole book still counts the unpriced BBB position", async () => {
    const whole = freshDb();
    seedWholeBook(whole);
    const r = (await executeTool(whole, "query_options_greeks", {})) as Result;
    expect(r.data.portfolio.computedPositions).toBe(3);
    expect(r.data.portfolio.totalPositions).toBe(4);
    expect(r.data.strategies.some((s) => s.underlying === "CCC")).toBe(true);
  });

  it("strategies are filtered to the underlying", async () => {
    const whole = freshDb();
    seedWholeBook(whole);
    const r = (await executeTool(whole, "query_options_greeks", { underlying: "aaa" })) as Result;
    expect(r.data.positionCount).toBe(2);
    expect(r.data.strategies.every((s) => s.underlying.toUpperCase() === "AAA")).toBe(true);
  });

  it("an underlying whose only position is unpriced withholds the totals", async () => {
    const whole = freshDb();
    seedWholeBook(whole);
    const r = (await executeTool(whole, "query_options_greeks", { underlying: "BBB" })) as Result;
    const p = r.data.portfolio;
    expect(p.computedPositions).toBe(0);
    expect(p.totalPositions).toBe(1);
    expect(p.totalDelta).toBeNull();
    expect(p.note).toBe("no position could be priced");
  });
});

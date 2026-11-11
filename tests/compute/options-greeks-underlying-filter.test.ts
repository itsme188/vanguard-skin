/**
 * The one additive `underlying` option on computePortfolioGreeks (Portfolio
 * Assistant plan, Task 5, B22). With no filter the output is unchanged; with
 * a filter only that underlying's contracts enter the engine's aggregation
 * and coverage counts. Synthetic tickers and figures only.
 *
 * Protects: the engine's totals for one underlying. Bound: equal (1e-9) to
 * the totals of a book holding only that underlying.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";
import { todayET, addDays } from "@/lib/calendar/date-utils";

const EXPIRY = addDays(todayET(), 90);
let k = 0;

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}
function seed(db: Database.Database, und: string, price: number, strike: number, qty: number): void {
  const s = db
    .prepare("INSERT INTO securities (symbol, security_type, currency, multiplier) VALUES (?, 'stock', 'USD', 1)")
    .run(und).lastInsertRowid as number;
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(s, todayET(), price);
  const o = db
    .prepare(
      `INSERT INTO securities (symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier, currency)
       VALUES (?, 'option', 'CALL', ?, ?, ?, 100, 'USD')`,
    )
    .run(`${und} C${strike}`, strike, EXPIRY, und).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (1, ?, ?, 0, ?, ?)",
  ).run(o, qty, todayET(), `o-${k++}`);
}

describe("computePortfolioGreeks underlying option", () => {
  it("no filter: identical output to a call without the option", () => {
    const db = freshDb();
    seed(db, "AAQ", 100, 100, 2);
    seed(db, "BBQ", 40, 45, -3);
    expect(computePortfolioGreeks(db, { underlying: undefined })).toEqual(computePortfolioGreeks(db));
  });

  it("a filter (any case) equals the book holding only that underlying", () => {
    const both = freshDb();
    seed(both, "AAQ", 100, 100, 2);
    seed(both, "BBQ", 40, 45, -3);
    const only = freshDb();
    seed(only, "AAQ", 100, 100, 2);
    const got = computePortfolioGreeks(both, { underlying: "aaq" });
    const want = computePortfolioGreeks(only);
    expect(got.positions.map((p) => p.underlying)).toEqual(["AAQ"]);
    expect(got.totalPositions).toBe(want.totalPositions);
    expect(got.computedPositions).toBe(want.computedPositions);
    expect(got.totalDelta).toBeCloseTo(want.totalDelta, 9);
    expect(got.totalGamma).toBeCloseTo(want.totalGamma, 9);
    expect(got.totalTheta).toBeCloseTo(want.totalTheta, 9);
    expect(got.totalVega).toBeCloseTo(want.totalVega, 9);
  });
});

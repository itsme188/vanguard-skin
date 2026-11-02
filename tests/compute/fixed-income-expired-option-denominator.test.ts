/**
 * The Fixed Income card's portfolio total (the allocation denominator) must
 * not count expired options that still carry a last-price row, in either
 * stored expiration spelling. Synthetic symbols and round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeFixedIncomeExposure } from "@/lib/compute/fixed-income-exposure";

const TODAY = "2030-01-15";
const ACCOUNT = 1;

let db: Database.Database;

function seed(symbol: string, type: string, qty: number, price: number, opts: { expiry?: string; multiplier?: number; maturity?: string } = {}) {
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, currency, multiplier, expiration_date, maturity_date)
       VALUES (?, ?, ?, 'USD', ?, ?, ?)`,
    )
    .run(symbol, symbol, type, opts.multiplier ?? null, opts.expiry ?? null, opts.maturity ?? null).lastInsertRowid as number;
  db.prepare(`INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)`).run(
    ACCOUNT, id, qty, "2030-01-14", `hold-${symbol}`,
  );
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(id, "2030-01-14", price);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("computeFixedIncomeExposure: portfolio denominator excludes expired options", () => {
  it("counts the bond and the live option, not expired options (dashed or compact)", () => {
    seed("AAA", "Bond", 10000, 100, { maturity: "2035-01-15" }); // 10,000
    seed("ZZZ1", "Option", 1, 5, { expiry: "2031-06-21", multiplier: 100 }); // 500 live
    seed("ZZZ2", "Option", 1, 5, { expiry: "2029-12-21", multiplier: 100 }); // expired, dashed
    seed("ZZZ3", "Option", 1, 5, { expiry: "20291221", multiplier: 100 }); // expired, compact
    const r = computeFixedIncomeExposure(db, undefined, TODAY);
    expect(r.portfolioValue).toBe(10500);
  });
});

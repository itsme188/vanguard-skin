import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";

function seedSecurity(db: Database.Database, symbol: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name) VALUES (?, ?)")
    .run(symbol, symbol + " Corp");
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  costBasis?: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, costBasis ?? null, asOfDate, `hold-${accountId}-${securityId}-${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
}

function seedCashTransaction(
  db: Database.Database,
  accountId: number,
  date: string,
  amount: number,
  type: string = "DEPOSIT"
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(accountId, date, type, amount, `cash-${accountId}-${date}-${Math.random()}`);
}

describe("daily valuation computation", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // Vanguard Taxable

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("computes valuation from holdings and prices", () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);

    const result = computeDailyValuations(db);
    expect(result.datesComputed).toBe(1);

    const vals = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .all(ACCOUNT_ID) as any[];
    expect(vals).toHaveLength(1);
    expect(vals[0].holdings_value).toBe(1500); // 10 * 150
    expect(vals[0].total_value).toBe(1500);
    expect(vals[0].valuation_date).toBe("2025-01-31");
  });

  it("computes valuations across multiple dates", () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);
    seedPrice(db, sec, "2025-02-28", 160);

    const result = computeDailyValuations(db);
    expect(result.datesComputed).toBe(2);

    const vals = db
      .prepare(
        "SELECT * FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date"
      )
      .all(ACCOUNT_ID) as any[];
    expect(vals).toHaveLength(2);
    expect(vals[0].holdings_value).toBe(1500); // 10 * 150
    expect(vals[1].holdings_value).toBe(1600); // 10 * 160
  });

  it("handles multiple securities per account", () => {
    const aapl = seedSecurity(db, "AAPL");
    const msft = seedSecurity(db, "MSFT");

    seedHolding(db, ACCOUNT_ID, aapl, 10, "2025-01-31");
    seedHolding(db, ACCOUNT_ID, msft, 5, "2025-01-31");
    seedPrice(db, aapl, "2025-01-31", 150);
    seedPrice(db, msft, "2025-01-31", 300);

    computeDailyValuations(db);

    const vals = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .all(ACCOUNT_ID) as any[];
    expect(vals).toHaveLength(1);
    expect(vals[0].holdings_value).toBe(3000); // (10*150) + (5*300)
  });

  it("handles multiple accounts independently", () => {
    const sec = seedSecurity(db, "AAPL");
    const ROTH = 2;

    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedHolding(db, ROTH, sec, 5, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);

    computeDailyValuations(db);

    const taxable = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .all(ACCOUNT_ID) as any[];
    const roth = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .all(ROTH) as any[];

    expect(taxable[0].holdings_value).toBe(1500);
    expect(roth[0].holdings_value).toBe(750);
  });

  it("is idempotent — recomputing produces same results", () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);

    computeDailyValuations(db);
    computeDailyValuations(db);

    const vals = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .all(ACCOUNT_ID) as any[];
    expect(vals).toHaveLength(1);
    expect(vals[0].holdings_value).toBe(1500);
  });

  it("uses most recent holdings for dates without new snapshot", () => {
    const sec = seedSecurity(db, "AAPL");
    // Holdings as of Jan 31
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    // Prices for Jan and Feb — no Feb holdings snapshot
    seedPrice(db, sec, "2025-01-31", 150);
    seedPrice(db, sec, "2025-02-28", 160);

    computeDailyValuations(db);

    const vals = db
      .prepare(
        "SELECT * FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date"
      )
      .all(ACCOUNT_ID) as any[];
    expect(vals).toHaveLength(2);
    // Feb uses Jan holdings (10 shares) with Feb price
    expect(vals[1].holdings_value).toBe(1600);
  });

  it("returns summary statistics", () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);

    const result = computeDailyValuations(db);
    expect(result.datesComputed).toBeGreaterThan(0);
    expect(result.accountsProcessed).toBeGreaterThan(0);
  });
});

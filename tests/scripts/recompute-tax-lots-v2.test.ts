import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getTaxConventionState } from "@/lib/compute/tax-convention";
import {
  runRecompute,
  checkDailyIdentity,
  snapshotBusinessColumns,
  diffBusinessSnapshots,
} from "@/scripts/recompute-tax-lots-v2";

const ACCOUNT_ID = 1; // Vanguard Taxable (seeded by runMigrations)

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function seedSecurity(db: Database.Database, symbol: string, name: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name) VALUES (?, ?)")
    .run(symbol, name);
  return result.lastInsertRowid as number;
}

function seedTransaction(
  db: Database.Database,
  opts: {
    account_id: number;
    security_id: number;
    trade_date: string;
    type: string;
    quantity: number;
    price_per_share: number;
    amount: number;
    fees?: number;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.account_id,
      opts.security_id,
      opts.trade_date,
      opts.type,
      opts.quantity,
      opts.price_per_share,
      opts.amount,
      opts.fees ?? 0,
      `test-${opts.type}-${opts.trade_date}-${Math.random()}`,
    );
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, securityId, quantity, asOfDate, `hold-${accountId}-${securityId}-${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)",
  ).run(securityId, date, price);
}

/** Seeds a BUY + partial SELL (produces exactly one tax lot and one sale)
 *  plus the matching holding/price so computeDailyValuations has something
 *  to build a real daily_valuations row from. */
function seedBuyAndPartialSell(db: Database.Database): number {
  const secId = seedSecurity(db, "AAPL", "Apple Inc.");
  seedTransaction(db, {
    account_id: ACCOUNT_ID,
    security_id: secId,
    trade_date: "2025-01-15",
    type: "BUY",
    quantity: 10,
    price_per_share: 100,
    amount: -1000,
  });
  seedTransaction(db, {
    account_id: ACCOUNT_ID,
    security_id: secId,
    trade_date: "2025-06-01",
    type: "SELL",
    quantity: 4,
    price_per_share: 150,
    amount: 600,
  });
  seedHolding(db, ACCOUNT_ID, secId, 6, "2025-06-01");
  seedPrice(db, secId, "2025-06-01", 150);
  return secId;
}

describe("runRecompute", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("rebuilds lots/sales, recomputes valuations, and confirms the daily identity", () => {
    seedBuyAndPartialSell(db);

    const result = runRecompute(db);

    expect(result.lots).toBe(1);
    expect(result.sales).toBe(1);
    expect(result.identityOk).toBe(true);

    const lots = db.prepare("SELECT * FROM tax_lots").all() as any[];
    expect(lots).toHaveLength(1);
    expect(lots[0].quantity_remaining).toBe(6);

    const valuations = db.prepare("SELECT * FROM daily_valuations").all() as any[];
    expect(valuations.length).toBeGreaterThan(0);
    for (const v of valuations) {
      expect(v.cash_balance + v.holdings_value).toBeCloseTo(v.total_value, 2);
    }
  });

  it("stamps the v2 tax-lots convention marker as current", () => {
    seedBuyAndPartialSell(db);

    expect(getTaxConventionState(db).recomputeCurrent).toBe(false);

    runRecompute(db);

    expect(getTaxConventionState(db).recomputeCurrent).toBe(true);
  });

  it("returns zero counts and identityOk true on an empty DB", () => {
    const result = runRecompute(db);
    expect(result).toEqual({ lots: 0, sales: 0, identityOk: true });
  });
});

describe("checkDailyIdentity", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("is vacuously true with zero daily_valuations rows", () => {
    expect(checkDailyIdentity(db)).toBe(true);
  });

  it("is true when every row satisfies cash + holdings = total", () => {
    db.prepare(
      `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(ACCOUNT_ID, "2025-01-01", 100, 200, 300);

    expect(checkDailyIdentity(db)).toBe(true);
  });

  it("is false when a row's total_value contradicts cash + holdings", () => {
    db.prepare(
      `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(ACCOUNT_ID, "2025-01-01", 100, 200, 999);

    expect(checkDailyIdentity(db)).toBe(false);
  });
});

describe("idempotence (snapshotBusinessColumns / diffBusinessSnapshots)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("running computeTaxLots twice produces IDENTICAL business columns", () => {
    seedBuyAndPartialSell(db);
    runRecompute(db);

    const before = snapshotBusinessColumns(db);
    computeTaxLots(db); // second application, direct (mirrors the CLI's --verify-idempotent flow)
    const after = snapshotBusinessColumns(db);

    const diff = diffBusinessSnapshots(before, after);
    expect(diff.identical).toBe(true);
    expect(diff.differences).toEqual([]);
  });

  it("surrogate ids differ across runs but are excluded from the diff", () => {
    seedBuyAndPartialSell(db);
    runRecompute(db);
    const lotIdBefore = (db.prepare("SELECT id FROM tax_lots").get() as { id: number }).id;

    computeTaxLots(db);
    const lotIdAfter = (db.prepare("SELECT id FROM tax_lots").get() as { id: number }).id;

    // Sanity: the underlying AUTOINCREMENT id actually did move (otherwise
    // this test would be vacuous) — but the business-column diff still
    // reports identical.
    expect(lotIdAfter).not.toBe(lotIdBefore);

    const before = snapshotBusinessColumns(db);
    computeTaxLots(db);
    const after = snapshotBusinessColumns(db);
    expect(diffBusinessSnapshots(before, after).identical).toBe(true);
  });

  it("detects a real business-column divergence between two snapshots", () => {
    seedBuyAndPartialSell(db);
    runRecompute(db);

    const before = snapshotBusinessColumns(db);
    db.prepare("UPDATE tax_lots SET cost_basis = cost_basis + 1").run();
    const after = snapshotBusinessColumns(db);

    const diff = diffBusinessSnapshots(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.differences.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { generateTaxReport } from "@/lib/compute/tax-report";

// QA finding tax-lots-wash-sales--repurchased-date-precedes-sale-date-on-most-entries:
// the wash-sale window correctly scans both BEFORE and AFTER a loss sale
// (that is the actual IRS rule), but the warning always said "repurchased"
// even when the replacement purchase came first — reading as a date error.
// These tests pin the direction-aware wording so a purchase before the sale
// never says "repurchased" (which implies "after").

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      security_type TEXT DEFAULT 'stock',
      multiplier REAL DEFAULT 1,
      currency TEXT NOT NULL DEFAULT 'USD'
    );

    CREATE TABLE tax_lots (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      acquisition_date TEXT NOT NULL,
      acquisition_price REAL NOT NULL,
      quantity_acquired REAL NOT NULL,
      quantity_remaining REAL NOT NULL DEFAULT 0,
      cost_basis REAL NOT NULL,
      is_from_opening_snapshot INTEGER NOT NULL DEFAULT 0,
      is_short INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (security_id) REFERENCES securities(id)
    );

    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER,
      trade_date TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity REAL,
      price_per_share REAL,
      amount REAL,
      fees REAL DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE tax_lot_sales (
      id INTEGER PRIMARY KEY,
      tax_lot_id INTEGER NOT NULL,
      sale_transaction_id INTEGER,
      sale_date TEXT NOT NULL,
      quantity_sold REAL NOT NULL,
      sale_price REAL NOT NULL,
      proceeds REAL NOT NULL,
      cost_basis_allocated REAL NOT NULL,
      realized_gain_loss REAL NOT NULL,
      is_long_term INTEGER NOT NULL DEFAULT 0,
      holding_period_days INTEGER NOT NULL DEFAULT 0,
      premium_rollover INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (tax_lot_id) REFERENCES tax_lots(id),
      FOREIGN KEY (sale_transaction_id) REFERENCES transactions(id)
    );

    CREATE TABLE prices (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT DEFAULT 'test',
      UNIQUE(security_id, date)
    );
  `);

  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'IBKR')");
  db.exec("INSERT INTO securities (id, symbol, name) VALUES (1, 'ZBRA', 'Synthetic Test Co.')");

  return db;
}

function addLossSale(
  db: Database.Database,
  opts: { acquisitionDate: string; saleDate: string; quantity: number; acquisitionPrice: number; salePrice: number }
) {
  const costBasis = opts.quantity * opts.acquisitionPrice;
  const proceeds = opts.quantity * opts.salePrice;
  const gain = proceeds - costBasis;
  const holdingDays = Math.round(
    (new Date(opts.saleDate).getTime() - new Date(opts.acquisitionDate).getTime()) / (24 * 3600 * 1000)
  );

  const lotResult = db
    .prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (1, 1, ?, ?, ?, 0, ?)`
    )
    .run(opts.acquisitionDate, opts.acquisitionPrice, opts.quantity, costBasis);

  const txnResult = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount)
       VALUES (1, 1, ?, 'SELL', ?, ?, ?)`
    )
    .run(opts.saleDate, opts.quantity, opts.salePrice, proceeds);

  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    lotResult.lastInsertRowid,
    txnResult.lastInsertRowid,
    opts.saleDate,
    opts.quantity,
    opts.salePrice,
    proceeds,
    costBasis,
    gain,
    holdingDays
  );
}

function addReplacementLot(db: Database.Database, acquisitionDate: string, quantity: number, price: number) {
  db.prepare(
    `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_from_opening_snapshot)
     VALUES (1, 1, ?, ?, ?, ?, ?, 0)`
  ).run(acquisitionDate, price, quantity, quantity, quantity * price);
}

describe("wash-sale warning direction (QA tax-lots-wash-sales)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("flags direction 'before' when the replacement purchase precedes the sale", () => {
    // Loss sale on 2025-06-19; replacement bought 10 days BEFORE, on 2025-06-09.
    addReplacementLot(db, "2025-06-09", 20, 40);
    addLossSale(db, {
      acquisitionDate: "2025-01-05",
      saleDate: "2025-06-19",
      quantity: 20,
      acquisitionPrice: 50,
      salePrice: 42,
    });

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleWarnings).toHaveLength(1);
    const w = report.washSaleWarnings[0];
    expect(w.direction).toBe("before");
    expect(w.daysFromSale).toBe(10);
    expect(w.description).toContain("before the sale");
    expect(w.description).not.toContain("repurchased");
  });

  it("flags direction 'after' when the replacement purchase follows the sale", () => {
    // Loss sale on 2025-06-19; replacement bought 5 days AFTER, on 2025-06-24.
    addLossSale(db, {
      acquisitionDate: "2025-01-05",
      saleDate: "2025-06-19",
      quantity: 20,
      acquisitionPrice: 50,
      salePrice: 42,
    });
    addReplacementLot(db, "2025-06-24", 20, 41);

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleWarnings).toHaveLength(1);
    const w = report.washSaleWarnings[0];
    expect(w.direction).toBe("after");
    expect(w.daysFromSale).toBe(5);
    expect(w.description).toContain("repurchased");
  });
});

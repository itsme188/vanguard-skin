/**
 * QA finding tax-lots-exports--form-8949-csv-txf-print-unrounded-float-share-counts:
 * the Form 8949 CSV and the TurboTax TXF built their Description field
 * straight off the raw float (`${sale.quantity_sold} sh ${sale.symbol}`), so
 * lots whose remaining quantity had accumulated binary-float noise printed as
 * "42.99999999999997 sh …" / "7.1229999999997354 sh …" — a handful of rows in
 * a real export. The TXF P-records carried the identical strings. The
 * on-screen tables never showed it because they render through <Shares> /
 * formatShares.
 *
 * Fix: a pure export-side quantity formatter (formatExportShares in
 * lib/format.ts) strips the noise at up to 4 decimals and trims trailing
 * zeros, WITHOUT thousands separators — a comma inside the CSV Description
 * field would break the row.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { formatExportShares } from "@/lib/format";
import {
  generateTaxReport,
  generateForm8949CSV,
  generateTXF,
} from "@/lib/compute/tax-report";

describe("formatExportShares (pure)", () => {
  it("collapses float noise on a whole-share count", () => {
    expect(formatExportShares(42.99999999999997)).toBe("43");
  });

  it("keeps a genuine fraction but drops the noise tail", () => {
    expect(formatExportShares(15.307999999999995)).toBe("15.308");
    expect(formatExportShares(7.1229999999997354)).toBe("7.123");
    expect(formatExportShares(0.006999999999975195)).toBe("0.007");
  });

  it("leaves clean values alone", () => {
    expect(formatExportShares(250)).toBe("250");
    expect(formatExportShares(0.5)).toBe("0.5");
  });

  it("never emits a thousands separator (a comma would break the CSV row)", () => {
    expect(formatExportShares(12345)).toBe("12345");
    expect(formatExportShares(12345.678)).toBe("12345.678");
    expect(formatExportShares(12345)).not.toContain(",");
  });
});

// ── Report-level: the same string reaches the CSV and the TXF ──────────

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
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

  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'QA Brokerage')");
  db.exec("INSERT INTO securities (id, symbol, name) VALUES (1, 'QAAA', 'QA Alpha Inc.')");
  return db;
}

/** One closed lot sale with an exact (noisy) quantity. */
function addNoisySale(db: Database.Database, quantity: number) {
  const acquisitionPrice = 10;
  const salePrice = 12;
  const costBasis = quantity * acquisitionPrice;
  const proceeds = quantity * salePrice;

  const lot = db
    .prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (1, 1, '2025-02-03', ?, ?, 0, ?)`,
    )
    .run(acquisitionPrice, quantity, costBasis);

  const txn = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount)
       VALUES (1, 1, '2025-08-11', 'SELL', ?, ?, ?)`,
    )
    .run(quantity, salePrice, proceeds);

  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
     VALUES (?, ?, '2025-08-11', ?, ?, ?, ?, ?, 0, 189)`,
  ).run(
    lot.lastInsertRowid,
    txn.lastInsertRowid,
    quantity,
    salePrice,
    proceeds,
    costBasis,
    proceeds - costBasis,
  );
}

describe("tax report exports print a clean share count", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("the Form 8949 row description drops the float tail", () => {
    addNoisySale(db, 15.307999999999995);
    const report = generateTaxReport(db, 2025);

    expect(report.shortTermRows).toHaveLength(1);
    expect(report.shortTermRows[0].description).toBe("15.308 sh QAAA");
  });

  it("the CSV carries the same cleaned description", () => {
    addNoisySale(db, 42.99999999999997);
    const csv = generateForm8949CSV(generateTaxReport(db, 2025));

    expect(csv).toContain("43 sh QAAA");
    expect(csv).not.toContain("42.99999999999997");
  });

  it("the TXF P-record carries the identical string", () => {
    addNoisySale(db, 7.1229999999997354);
    const report = generateTaxReport(db, 2025);
    const txf = generateTXF(report);

    expect(report.shortTermRows[0].description).toBe("7.123 sh QAAA");
    expect(txf).toContain("P7.123 sh QAAA");
    expect(txf).not.toContain("7.1229999999997354");
  });
});

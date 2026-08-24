import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { generateTaxReport, generateForm8949CSV } from "@/lib/compute/tax-report";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
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
  db.exec("INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple Inc.')");
  db.exec("INSERT INTO securities (id, symbol, name) VALUES (2, 'MSFT', 'Microsoft Corp.')");

  return db;
}

function addSale(
  db: Database.Database,
  opts: {
    securityId: number;
    acquisitionDate: string;
    saleDate: string;
    quantity: number;
    acquisitionPrice: number;
    salePrice: number;
    isLongTerm?: boolean;
  }
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
       VALUES (1, ?, ?, ?, ?, 0, ?)`
    )
    .run(opts.securityId, opts.acquisitionDate, opts.acquisitionPrice, opts.quantity, costBasis);

  // getClosedTaxLotSales (number-trust durable fixes, WS1) INNER JOINs
  // transactions via sale_transaction_id — every sale row needs a real
  // backing transaction of an ordinary type (never RECONCILE_CLOSE here).
  const txnResult = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount)
       VALUES (1, ?, ?, 'SELL', ?, ?, ?)`
    )
    .run(opts.securityId, opts.saleDate, opts.quantity, opts.salePrice, proceeds);

  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lotResult.lastInsertRowid,
    txnResult.lastInsertRowid,
    opts.saleDate,
    opts.quantity,
    opts.salePrice,
    proceeds,
    costBasis,
    gain,
    opts.isLongTerm ?? (holdingDays > 365) ? 1 : 0,
    holdingDays
  );
}

describe("generateTaxReport", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns empty report with no sales", () => {
    const report = generateTaxReport(db, 2025);
    expect(report.year).toBe(2025);
    expect(report.shortTermRows).toHaveLength(0);
    expect(report.longTermRows).toHaveLength(0);
    expect(report.washSaleWarnings).toHaveLength(0);
  });

  it("separates short-term and long-term sales", () => {
    // Short-term: bought 2025-01-15, sold 2025-06-15 (151 days)
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2025-01-15",
      saleDate: "2025-06-15",
      quantity: 50,
      acquisitionPrice: 150,
      salePrice: 170,
      isLongTerm: false,
    });

    // Long-term: bought 2023-06-01, sold 2025-03-01 (>365 days)
    addSale(db, {
      securityId: 2,
      acquisitionDate: "2023-06-01",
      saleDate: "2025-03-01",
      quantity: 100,
      acquisitionPrice: 300,
      salePrice: 400,
      isLongTerm: true,
    });

    const report = generateTaxReport(db, 2025);
    expect(report.shortTermRows).toHaveLength(1);
    expect(report.longTermRows).toHaveLength(1);

    // Short-term: 50 * (170 - 150) = $1000 gain
    expect(report.shortTermTotal.gainLoss).toBeCloseTo(1000, 0);
    // Long-term: 100 * (400 - 300) = $10,000 gain
    expect(report.longTermTotal.gainLoss).toBeCloseTo(10000, 0);
  });

  it("formats Form 8949 rows correctly", () => {
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2025-02-10",
      saleDate: "2025-05-20",
      quantity: 25,
      acquisitionPrice: 180,
      salePrice: 160,
      isLongTerm: false,
    });

    const report = generateTaxReport(db, 2025);
    expect(report.shortTermRows[0].description).toBe("25 sh AAPL");
    expect(report.shortTermRows[0].dateAcquired).toBe("02/10/2025");
    expect(report.shortTermRows[0].dateSold).toBe("05/20/2025");
    expect(report.shortTermRows[0].proceeds).toBe(4000);
    expect(report.shortTermRows[0].costBasis).toBe(4500);
    expect(report.shortTermRows[0].gainOrLoss).toBe(-500);
  });

  it("detects wash sales within 30-day window", () => {
    // Sell AAPL at loss on 2025-03-15
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2025-01-01",
      saleDate: "2025-03-15",
      quantity: 50,
      acquisitionPrice: 200,
      salePrice: 180,
      isLongTerm: false,
    });

    // Buy AAPL again on 2025-03-25 (10 days later — within 30-day window)
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_from_opening_snapshot)
       VALUES (1, 1, '2025-03-25', 175, 50, 50, 8750, 0)`
    ).run();

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleWarnings).toHaveLength(1);
    expect(report.washSaleWarnings[0].symbol).toBe("AAPL");

    // The wash sale row should have adjustment code "W"
    const washRow = report.shortTermRows.find((r) => r.isWashSale);
    expect(washRow).toBeDefined();
    expect(washRow!.adjustmentCode).toBe("W");
    expect(washRow!.gainOrLoss).toBe(0); // loss disallowed
  });

  it("does NOT flag as wash sale when repurchase is >30 days away", () => {
    // Sell at loss on 2025-03-15
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2025-01-01",
      saleDate: "2025-03-15",
      quantity: 50,
      acquisitionPrice: 200,
      salePrice: 180,
      isLongTerm: false,
    });

    // Buy again on 2025-05-01 (47 days later — outside window)
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_from_opening_snapshot)
       VALUES (1, 1, '2025-05-01', 175, 50, 50, 8750, 0)`
    ).run();

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleWarnings).toHaveLength(0);
  });
});

describe("non-USD sales (QA 2026-08-07)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.exec(
      "INSERT INTO securities (id, symbol, name, currency) VALUES (3, '402340', 'KRW Name', 'KRW')"
    );
  });

  it("excludes a native-currency sale from the USD totals and counts the exclusion", () => {
    // USD short-term gain: +1,000
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2026-01-05",
      saleDate: "2026-03-01",
      quantity: 10,
      acquisitionPrice: 100,
      salePrice: 200,
    });
    // KRW sale: realized_gain_loss is native won — must not sum into USD totals
    addSale(db, {
      securityId: 3,
      acquisitionDate: "2026-02-01",
      saleDate: "2026-07-12",
      quantity: 10,
      acquisitionPrice: 1_000_000,
      salePrice: 602_000,
    });

    const report = generateTaxReport(db, 2026);

    // Rows keep the raw export set (8949 FX intentionally out of scope)…
    expect(report.shortTermRows).toHaveLength(2);
    // …but the USD-labeled totals exclude the won figure.
    expect(report.shortTermTotal.gainLoss).toBe(1000);
    expect(report.shortTermTotal.proceeds).toBe(2000);
    expect(report.shortTermTotal.costBasis).toBe(1000);
    expect(report.excludedNonUsdSales).toBe(1);
  });

  it("reports zero exclusions on an all-USD year", () => {
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2026-01-05",
      saleDate: "2026-03-01",
      quantity: 10,
      acquisitionPrice: 100,
      salePrice: 200,
    });
    const report = generateTaxReport(db, 2026);
    expect(report.excludedNonUsdSales).toBe(0);
    expect(report.shortTermTotal.gainLoss).toBe(1000);
  });
});

describe("generateForm8949CSV", () => {
  it("produces valid CSV with headers and totals", () => {
    const db = createTestDb();
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2025-01-15",
      saleDate: "2025-06-15",
      quantity: 100,
      acquisitionPrice: 150,
      salePrice: 170,
      isLongTerm: false,
    });

    const report = generateTaxReport(db, 2025);
    const csv = generateForm8949CSV(report);
    const lines = csv.split("\n");

    // Header
    expect(lines[0]).toContain("Term,Description,Date Acquired,Date Sold,Proceeds,Cost Basis");
    // Data row
    expect(lines[1]).toContain("Short-Term");
    expect(lines[1]).toContain("100 sh AAPL");
    // Totals row
    expect(lines[2]).toContain("Short-Term Totals");
  });
});

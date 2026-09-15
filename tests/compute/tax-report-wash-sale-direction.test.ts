import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { generateTaxReport, washSaleReplacementPhrase } from "@/lib/compute/tax-report";

// QA finding tax-lots-wash-sales--repurchased-date-precedes-sale-date-on-most-entries:
// the wash-sale window correctly scans both BEFORE and AFTER a loss sale
// (that is the actual IRS rule), but the warning always said "repurchased"
// even when the replacement purchase came first — reading as a date error.
// These tests pin the direction-aware wording so a purchase before the sale
// never says "repurchased" (which implies "after").
//
// Landing review follow-up: the *reason* "most entries" read backwards was
// the SELECTION, not just the wording — purchases arrive ordered by
// acquisition_date ascending and the scan stopped at the first in-window
// hit, so the chronologically earliest (always the before-side, when one
// exists) was the one named. The replacement purchase named is now the one
// NEAREST the sale, ties going to the after-side. The W-code decision is
// deliberately untouched by that choice: it depends on ANY in-window
// replacement existing, not on which one gets named.

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
  // ZBAS is a deliberately non-listed placeholder ticker: fixtures in this
  // repo never pair a real listed symbol with share counts and prices.
  db.exec("INSERT INTO securities (id, symbol, name) VALUES (1, 'ZBAS', 'Synthetic Test Co.')");

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

/** The one loss sale every case below hangs off: sold 2025-06-19 at a loss. */
function addTheLossSale(db: Database.Database) {
  addLossSale(db, {
    acquisitionDate: "2025-01-05",
    saleDate: "2025-06-19",
    quantity: 20,
    acquisitionPrice: 50,
    salePrice: 42,
  });
}

describe("wash-sale warning direction (QA tax-lots-wash-sales)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("flags direction 'before' when the replacement purchase precedes the sale", () => {
    // Loss sale on 2025-06-19; replacement bought 10 days BEFORE, on 2025-06-09.
    addReplacementLot(db, "2025-06-09", 20, 40);
    addTheLossSale(db);

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleWarnings).toHaveLength(1);
    const w = report.washSaleWarnings[0];
    expect(w.direction).toBe("before");
    expect(w.daysFromSale).toBe(10);
    expect(w.purchaseDate).toBe("2025-06-09");
    expect(w.description).toContain("before the sale");
    expect(w.description).not.toContain("repurchased");
  });

  it("flags direction 'after' when the replacement purchase follows the sale", () => {
    // Loss sale on 2025-06-19; replacement bought 5 days AFTER, on 2025-06-24.
    addTheLossSale(db);
    addReplacementLot(db, "2025-06-24", 20, 41);

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleWarnings).toHaveLength(1);
    const w = report.washSaleWarnings[0];
    expect(w.direction).toBe("after");
    expect(w.daysFromSale).toBe(5);
    expect(w.purchaseDate).toBe("2025-06-24");
    expect(w.description).toContain("repurchased");
  });
});

describe("wash-sale replacement selection: nearest the sale, ties to the after-side", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("names the after-side purchase when it is nearer than the before-side one", () => {
    // 20 days before vs 3 days after → the 3-days-after purchase is named.
    addReplacementLot(db, "2025-05-30", 20, 44); // 20 days before
    addTheLossSale(db);
    addReplacementLot(db, "2025-06-22", 20, 41); // 3 days after

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleWarnings).toHaveLength(1);
    const w = report.washSaleWarnings[0];
    expect(w.direction).toBe("after");
    expect(w.daysFromSale).toBe(3);
    expect(w.purchaseDate).toBe("2025-06-22");
  });

  it("names the before-side purchase when it is nearer than the after-side one", () => {
    // 2 days before vs 25 days after → the 2-days-before purchase is named.
    // This is the case the old first-hit scan got right only by accident.
    addReplacementLot(db, "2025-06-17", 20, 44); // 2 days before
    addTheLossSale(db);
    addReplacementLot(db, "2025-07-14", 20, 41); // 25 days after

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleWarnings).toHaveLength(1);
    const w = report.washSaleWarnings[0];
    expect(w.direction).toBe("before");
    expect(w.daysFromSale).toBe(2);
    expect(w.purchaseDate).toBe("2025-06-17");
  });

  it("breaks an exact distance tie in favour of the after-side purchase", () => {
    // 7 days before AND 7 days after → the after-side one wins, because that
    // is the leg a reader expects a wash sale to name.
    addReplacementLot(db, "2025-06-12", 20, 44); // 7 days before
    addTheLossSale(db);
    addReplacementLot(db, "2025-06-26", 20, 41); // 7 days after

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleWarnings).toHaveLength(1);
    const w = report.washSaleWarnings[0];
    expect(w.direction).toBe("after");
    expect(w.daysFromSale).toBe(7);
    expect(w.purchaseDate).toBe("2025-06-26");
  });

  it("ignores purchases outside the 30-day window even when they are the only after-side ones", () => {
    addReplacementLot(db, "2025-06-04", 20, 44); // 15 days before — in window
    addTheLossSale(db);
    addReplacementLot(db, "2025-07-25", 20, 41); // 36 days after — out of window

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleWarnings).toHaveLength(1);
    const w = report.washSaleWarnings[0];
    expect(w.direction).toBe("before");
    expect(w.daysFromSale).toBe(15);
    expect(w.purchaseDate).toBe("2025-06-04");
  });

  it("calls a same-day replacement 'the same day', never '0 days after'", () => {
    // Reachable because the skip guard compares the purchase against the
    // SOLD LOT's acquisition date (2025-01-05), not the sale date.
    addTheLossSale(db);
    addReplacementLot(db, "2025-06-19", 20, 41); // same day as the sale

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleWarnings).toHaveLength(1);
    const w = report.washSaleWarnings[0];
    expect(w.direction).toBe("after");
    expect(w.daysFromSale).toBe(0);
    expect(w.description).toContain("the same day");
    expect(w.description).not.toContain("0 day");
  });

  it("leaves the W adjustment code untouched no matter which side is named", () => {
    // Both a before-side and an after-side replacement exist. The W-code
    // decision keys on ANY in-window replacement, so it is identical here
    // to the single-purchase cases — only the named purchase changes.
    addReplacementLot(db, "2025-06-09", 20, 44); // 10 days before
    addTheLossSale(db);
    addReplacementLot(db, "2025-06-21", 20, 41); // 2 days after

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleWarnings).toHaveLength(1);
    expect(report.washSaleWarnings[0].direction).toBe("after");

    // One flagged sale row, W-coded, loss disallowed and added back — the
    // exact shape the before-only and after-only cases produce.
    const rows = [...report.shortTermRows, ...report.longTermRows];
    expect(rows).toHaveLength(1);
    expect(rows[0].isWashSale).toBe(true);
    expect(rows[0].adjustmentCode).toBe("W");
    expect(rows[0].gainOrLoss).toBe(0);
    expect(rows[0].adjustmentAmount).toBeCloseTo(Math.abs(report.washSaleWarnings[0].lossAmount), 6);
  });
});

describe("washSaleReplacementPhrase (single source of the user-visible sentence)", () => {
  it("phrases a before-side replacement without implying a repurchase", () => {
    const phrase = washSaleReplacementPhrase({
      purchaseDate: "2025-06-09",
      direction: "before",
      daysFromSale: 10,
    });
    expect(phrase).toBe("replacement shares bought 2025-06-09, 10 days before the sale");
  });

  it("phrases an after-side replacement as a repurchase", () => {
    const phrase = washSaleReplacementPhrase({
      purchaseDate: "2025-06-24",
      direction: "after",
      daysFromSale: 5,
    });
    expect(phrase).toBe("repurchased 2025-06-24, 5 days after the sale");
  });

  it("singularises a one-day gap on both sides", () => {
    expect(
      washSaleReplacementPhrase({ purchaseDate: "2025-06-18", direction: "before", daysFromSale: 1 })
    ).toBe("replacement shares bought 2025-06-18, 1 day before the sale");
    expect(
      washSaleReplacementPhrase({ purchaseDate: "2025-06-20", direction: "after", daysFromSale: 1 })
    ).toBe("repurchased 2025-06-20, 1 day after the sale");
  });

  it("says 'the same day' for a zero-day gap", () => {
    expect(
      washSaleReplacementPhrase({ purchaseDate: "2025-06-19", direction: "after", daysFromSale: 0 })
    ).toBe("repurchased 2025-06-19, the same day");
  });

  it("is the phrase the warning description itself is built from", () => {
    const db = createTestDb();
    addReplacementLot(db, "2025-06-24", 20, 41);
    addTheLossSale(db);
    const w = generateTaxReport(db, 2025).washSaleWarnings[0];
    expect(w.description).toContain(washSaleReplacementPhrase(w));
    db.close();
  });
});

describe("TaxReportCard renders the exported phrase (source pin)", () => {
  const source = readFileSync(
    join(process.cwd(), "app/dashboard/components/TaxReportCard.tsx"),
    "utf-8"
  );

  it("imports washSaleReplacementPhrase from lib/compute/tax-report", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bwashSaleReplacementPhrase\b[^}]*\}\s*from\s*["']@\/lib\/compute\/tax-report["']/
    );
  });

  it("calls the builder on the warning instead of composing the sentence inline", () => {
    expect(source).toMatch(/washSaleReplacementPhrase\s*\(\s*w\s*\)/);
    // No hand-built copy left in the card: those exact words live in
    // lib/compute/tax-report.ts and nowhere else.
    expect(source).not.toMatch(/replacement\s+shares\s+bought/);
    expect(source).not.toMatch(/repurchased/);
    expect(source).not.toMatch(/before\s+the\s+sale/);
  });
});

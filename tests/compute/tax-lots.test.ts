import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";

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
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      `test-${opts.type}-${opts.trade_date}-${Math.random()}`
    );
  return result.lastInsertRowid as number;
}

describe("tax lot computation (FIFO)", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // Vanguard Taxable (seeded)

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("creates a tax lot from a single buy", () => {
    const secId = seedSecurity(db, "AAPL", "Apple Inc.");
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2025-01-15",
      type: "BUY",
      quantity: 10,
      price_per_share: 150,
      amount: -1500,
    });

    const result = computeTaxLots(db);
    expect(result.lotsCreated).toBe(1);

    const lots = db
      .prepare("SELECT * FROM tax_lots WHERE account_id = ? AND security_id = ?")
      .all(ACCOUNT_ID, secId) as any[];
    expect(lots).toHaveLength(1);
    expect(lots[0].quantity_acquired).toBe(10);
    expect(lots[0].quantity_remaining).toBe(10);
    expect(lots[0].cost_basis).toBe(1500);
    expect(lots[0].acquisition_price).toBe(150);
    expect(lots[0].acquisition_date).toBe("2025-01-15");
  });

  it("matches a sell to the oldest lot (FIFO)", () => {
    const secId = seedSecurity(db, "AAPL", "Apple Inc.");
    // Buy 10 @ $100 on Jan 15
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2025-01-15",
      type: "BUY",
      quantity: 10,
      price_per_share: 100,
      amount: -1000,
    });
    // Buy 10 @ $120 on Feb 15
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2025-02-15",
      type: "BUY",
      quantity: 10,
      price_per_share: 120,
      amount: -1200,
    });
    // Sell 5 @ $130 on Mar 15
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2025-03-15",
      type: "SELL",
      quantity: 5,
      price_per_share: 130,
      amount: 650,
    });

    const result = computeTaxLots(db);
    expect(result.lotsCreated).toBe(2);
    expect(result.salesProcessed).toBe(1);

    // First lot should have 5 remaining (10 - 5 sold)
    const lots = db
      .prepare(
        "SELECT * FROM tax_lots WHERE account_id = ? AND security_id = ? ORDER BY acquisition_date"
      )
      .all(ACCOUNT_ID, secId) as any[];
    expect(lots[0].quantity_remaining).toBe(5);
    expect(lots[1].quantity_remaining).toBe(10);

    // Sale record
    const sales = db.prepare("SELECT * FROM tax_lot_sales").all() as any[];
    expect(sales).toHaveLength(1);
    expect(sales[0].quantity_sold).toBe(5);
    expect(sales[0].sale_price).toBe(130);
    expect(sales[0].proceeds).toBe(650);
    expect(sales[0].cost_basis_allocated).toBe(500); // 5 * $100
    expect(sales[0].realized_gain_loss).toBe(150); // 650 - 500
  });

  it("sells across multiple lots when quantity exceeds first lot", () => {
    const secId = seedSecurity(db, "AAPL", "Apple Inc.");
    // Buy 5 @ $100
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2025-01-15",
      type: "BUY",
      quantity: 5,
      price_per_share: 100,
      amount: -500,
    });
    // Buy 10 @ $120
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2025-02-15",
      type: "BUY",
      quantity: 10,
      price_per_share: 120,
      amount: -1200,
    });
    // Sell 8 @ $150
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2025-03-15",
      type: "SELL",
      quantity: 8,
      price_per_share: 150,
      amount: 1200,
    });

    computeTaxLots(db);

    const lots = db
      .prepare(
        "SELECT * FROM tax_lots WHERE account_id = ? AND security_id = ? ORDER BY acquisition_date"
      )
      .all(ACCOUNT_ID, secId) as any[];
    // First lot fully consumed: 5 - 5 = 0
    expect(lots[0].quantity_remaining).toBe(0);
    // Second lot partially consumed: 10 - 3 = 7
    expect(lots[1].quantity_remaining).toBe(7);

    // Two sale records (one per lot consumed)
    const sales = db.prepare("SELECT * FROM tax_lot_sales ORDER BY id").all() as any[];
    expect(sales).toHaveLength(2);
    expect(sales[0].quantity_sold).toBe(5); // from first lot
    expect(sales[0].cost_basis_allocated).toBe(500); // 5 * $100
    expect(sales[1].quantity_sold).toBe(3); // from second lot
    expect(sales[1].cost_basis_allocated).toBe(360); // 3 * $120
  });

  it("determines long-term vs short-term correctly", () => {
    const secId = seedSecurity(db, "AAPL", "Apple Inc.");
    // Buy on Jan 15, 2025
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2025-01-15",
      type: "BUY",
      quantity: 10,
      price_per_share: 100,
      amount: -1000,
    });
    // Sell 5 on Mar 15, 2025 (short-term: 59 days)
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2025-03-15",
      type: "SELL",
      quantity: 5,
      price_per_share: 110,
      amount: 550,
    });
    // Sell 5 on Feb 15, 2026 (long-term: 396 days)
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2026-02-15",
      type: "SELL",
      quantity: 5,
      price_per_share: 130,
      amount: 650,
    });

    computeTaxLots(db);

    const sales = db
      .prepare("SELECT * FROM tax_lot_sales ORDER BY sale_date")
      .all() as any[];
    expect(sales).toHaveLength(2);
    expect(sales[0].is_long_term).toBe(0); // short-term
    expect(sales[0].holding_period_days).toBe(59);
    expect(sales[1].is_long_term).toBe(1); // long-term
    expect(sales[1].holding_period_days).toBe(396);
  });

  it("is idempotent — recomputing produces same results", () => {
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
      trade_date: "2025-03-15",
      type: "SELL",
      quantity: 5,
      price_per_share: 130,
      amount: 650,
    });

    computeTaxLots(db);
    const firstLots = db.prepare("SELECT * FROM tax_lots").all();
    const firstSales = db.prepare("SELECT * FROM tax_lot_sales").all();

    // Recompute
    computeTaxLots(db);
    const secondLots = db.prepare("SELECT * FROM tax_lots").all();
    const secondSales = db.prepare("SELECT * FROM tax_lot_sales").all();

    // Same number of records (IDs may differ since we clear + recreate)
    expect(secondLots.length).toBe(firstLots.length);
    expect(secondSales.length).toBe(firstSales.length);
  });

  it("handles multiple securities independently", () => {
    const appl = seedSecurity(db, "AAPL", "Apple Inc.");
    const msft = seedSecurity(db, "MSFT", "Microsoft");

    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: appl,
      trade_date: "2025-01-15",
      type: "BUY",
      quantity: 10,
      price_per_share: 150,
      amount: -1500,
    });
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: msft,
      trade_date: "2025-01-20",
      type: "BUY",
      quantity: 5,
      price_per_share: 300,
      amount: -1500,
    });

    const result = computeTaxLots(db);
    expect(result.lotsCreated).toBe(2);

    const lots = db.prepare("SELECT * FROM tax_lots ORDER BY security_id").all() as any[];
    expect(lots).toHaveLength(2);
    expect(lots[0].security_id).toBe(appl);
    expect(lots[1].security_id).toBe(msft);
  });

  it("handles multiple accounts independently", () => {
    const secId = seedSecurity(db, "AAPL", "Apple Inc.");
    const ROTH_ACCOUNT = 2; // Vanguard Roth IRA

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
      account_id: ROTH_ACCOUNT,
      security_id: secId,
      trade_date: "2025-01-20",
      type: "BUY",
      quantity: 5,
      price_per_share: 110,
      amount: -550,
    });

    const result = computeTaxLots(db);
    expect(result.lotsCreated).toBe(2);

    const taxable = db
      .prepare("SELECT * FROM tax_lots WHERE account_id = ?")
      .all(ACCOUNT_ID) as any[];
    const roth = db
      .prepare("SELECT * FROM tax_lots WHERE account_id = ?")
      .all(ROTH_ACCOUNT) as any[];
    expect(taxable).toHaveLength(1);
    expect(roth).toHaveLength(1);
  });

  it("returns summary statistics", () => {
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
      trade_date: "2025-03-15",
      type: "SELL",
      quantity: 3,
      price_per_share: 130,
      amount: 390,
    });

    const result = computeTaxLots(db);
    expect(result.lotsCreated).toBe(1);
    expect(result.salesProcessed).toBe(1);
    expect(result.totalRealizedGain).toBeCloseTo(90); // 3 * (130 - 100)
  });

  it("creates a tax lot from a TRANSFER_IN (ACATS in-kind) transaction", () => {
    const secId = seedSecurity(db, "XYZ", "Transferred Fund");
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2024-01-05",
      type: "TRANSFER_IN",
      quantity: 2500,
      price_per_share: 14.84,
      amount: 37100,
    });
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2024-01-09",
      type: "SELL",
      quantity: 2500,
      price_per_share: 15.0,
      amount: 37500,
    });

    computeTaxLots(db);

    const lots = db
      .prepare("SELECT * FROM tax_lots WHERE account_id = ? AND security_id = ?")
      .all(ACCOUNT_ID, secId) as any[];
    expect(lots).toHaveLength(1);
    expect(lots[0].acquisition_date).toBe("2024-01-05");
    expect(lots[0].cost_basis).toBeCloseTo(37100, 0);
    expect(lots[0].is_short).toBe(0);

    const sales = db.prepare("SELECT * FROM tax_lot_sales").all() as any[];
    expect(sales).toHaveLength(1);
    expect(sales[0].holding_period_days).toBe(4); // no more negative pairing
  });
});

describe("REDEMPTION with null price (bond/bill maturity)", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedRedemption(
    db: Database.Database,
    secId: number,
    opts: { quantity: number; amount: number | null }
  ) {
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
       VALUES (?, ?, '2023-08-10', 'REDEMPTION', ?, NULL, ?, ?)`
    ).run(ACCOUNT_ID, secId, opts.quantity, opts.amount, `test-redemption-${Math.random()}`);
  }

  it("closes the lot at ~zero realized when amount carries the principal (per-100 bond price basis)", () => {
    const secId = seedSecurity(db, "912796XY0", "U S TREASURY BILL");
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2023-02-08",
      type: "BUY",
      quantity: 10000,
      price_per_share: 97.6137, // per-100-face statement basis
      amount: 9761.37,
    });
    seedRedemption(db, secId, { quantity: 10000, amount: 9761.37 });

    computeTaxLots(db);

    const lot = db
      .prepare("SELECT quantity_remaining FROM tax_lots WHERE security_id = ?")
      .get(secId) as any;
    expect(lot.quantity_remaining).toBe(0);

    const sale = db
      .prepare("SELECT proceeds, realized_gain_loss FROM tax_lot_sales")
      .get() as any;
    // proceeds derived on the same per-100 basis as the buy: |amount|/qty*100
    expect(sale.proceeds).toBeCloseTo(976137, 0);
    expect(sale.realized_gain_loss).toBeCloseTo(0, 2);
  });

  it("still skips a redemption with neither price nor amount (cannot value it)", () => {
    const secId = seedSecurity(db, "912796ZZ5", "U S TREASURY BILL");
    seedTransaction(db, {
      account_id: ACCOUNT_ID,
      security_id: secId,
      trade_date: "2023-04-24",
      type: "BUY",
      quantity: 4000,
      price_per_share: 98.81625,
      amount: 3952.65,
    });
    seedRedemption(db, secId, { quantity: 4000, amount: null });

    computeTaxLots(db);

    const lot = db
      .prepare("SELECT quantity_remaining FROM tax_lots WHERE security_id = ?")
      .get(secId) as any;
    expect(lot.quantity_remaining).toBe(4000); // untouched, no crash
    expect(db.prepare("SELECT COUNT(*) n FROM tax_lot_sales").get()).toEqual({ n: 0 });
  });
});

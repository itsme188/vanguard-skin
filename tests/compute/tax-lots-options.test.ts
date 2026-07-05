/**
 * Tests for IRS-compliant option tax lot handling.
 *
 * Covers: expired options (long/short), exercised calls/puts,
 * assigned calls/puts, and mixed scenarios with regular stock lots.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  // Use IBKR account seeded by migration 002 (id=3)
  // Create underlying stock security
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type)
     VALUES (1, 'AAPL', 'Apple Inc', 'stock')`
  ).run();
});

function insertOptionSecurity(
  id: number,
  symbol: string,
  optionType: "CALL" | "PUT",
  strike: number,
  expiry: string
) {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
     VALUES (?, ?, ?, 'option', 'AAPL', ?, ?, ?, 100)`
  ).run(id, symbol, `AAPL ${strike} ${optionType}`, optionType, strike, expiry);
}

function insertTransaction(
  securityId: number,
  type: string,
  date: string,
  quantity: number,
  pricePerShare: number
) {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, type, trade_date, quantity, price_per_share, amount, fees)
     VALUES (3, ?, ?, ?, ?, ?, ?, 0)`
  ).run(securityId, type, date, quantity, pricePerShare, quantity * pricePerShare);
}

function getTaxLots() {
  return db.prepare(
    `SELECT tl.*, s.symbol, s.security_type
     FROM tax_lots tl
     JOIN securities s ON s.id = tl.security_id
     ORDER BY tl.acquisition_date, tl.id`
  ).all() as Array<{
    id: number;
    security_id: number;
    symbol: string;
    security_type: string;
    acquisition_price: number;
    quantity_acquired: number;
    quantity_remaining: number;
    cost_basis: number;
  }>;
}

function getTaxLotSales() {
  return db.prepare(
    `SELECT tls.*, s.symbol, s.security_type
     FROM tax_lot_sales tls
     JOIN tax_lots tl ON tl.id = tls.tax_lot_id
     JOIN securities s ON s.id = tl.security_id
     ORDER BY tls.sale_date, tls.id`
  ).all() as Array<{
    id: number;
    tax_lot_id: number;
    symbol: string;
    security_type: string;
    quantity_sold: number;
    sale_price: number;
    proceeds: number;
    cost_basis_allocated: number;
    realized_gain_loss: number;
  }>;
}

describe("option tax lot handling", () => {
  it("long call expired: full premium loss", () => {
    // Buy AAPL call for $5/share premium, then it expires worthless
    insertOptionSecurity(10, "AAPL  260619C00180000", "CALL", 180, "2026-06-19");
    insertTransaction(10, "BUY_TO_OPEN", "2026-01-15", 2, 5.00);
    insertTransaction(10, "EXPIRED", "2026-06-19", 2, 0);

    const result = computeTaxLots(db);
    expect(result.lotsCreated).toBe(1);
    expect(result.salesProcessed).toBe(1);

    const sales = getTaxLotSales();
    expect(sales.length).toBe(1);
    expect(sales[0].sale_price).toBe(0); // expired at $0
    expect(sales[0].proceeds).toBe(0);
    expect(sales[0].cost_basis_allocated).toBe(1000); // 2 * $5 * 100 multiplier
    expect(sales[0].realized_gain_loss).toBe(-1000); // full loss of premium
  });

  it("short call expired: full premium gain", () => {
    // Sell AAPL call for $4/share premium (SELL_TO_OPEN), then it expires
    insertOptionSecurity(10, "AAPL  260619C00200000", "CALL", 200, "2026-06-19");
    insertTransaction(10, "SELL_TO_OPEN", "2026-02-01", 3, 4.00);
    insertTransaction(10, "EXPIRED", "2026-06-19", 3, 0);

    const result = computeTaxLots(db);
    expect(result.lotsCreated).toBe(1); // SELL_TO_OPEN creates a lot
    expect(result.salesProcessed).toBe(1);

    const lots = getTaxLots();
    expect(lots.length).toBe(1);
    expect(lots[0].acquisition_price).toBe(4.00); // premium received as "cost"

    const sales = getTaxLotSales();
    expect(sales.length).toBe(1);
    expect(sales[0].sale_price).toBe(0); // expired at $0
    expect(sales[0].cost_basis_allocated).toBe(1200); // 3 * $4 * 100 multiplier
    expect(sales[0].realized_gain_loss).toBe(1200); // kept full premium = $1,200 gain
    // Short option P&L is negated: raw (0 - 1200 = -1200) → negated → +1200
  });

  it("buy_to_close: closes short option lot", () => {
    // Sell call for $6, buy it back for $2 → $4/share profit
    insertOptionSecurity(10, "AAPL  260619C00180000", "CALL", 180, "2026-06-19");
    insertTransaction(10, "SELL_TO_OPEN", "2026-01-10", 1, 6.00);
    insertTransaction(10, "BUY_TO_CLOSE", "2026-03-01", 1, 2.00);

    const result = computeTaxLots(db);

    const sales = getTaxLotSales();
    expect(sales.length).toBe(1);
    expect(sales[0].cost_basis_allocated).toBe(600); // opened at $6 × 100 multiplier
    expect(sales[0].sale_price).toBe(2); // closed at $2 (per-unit)
    expect(sales[0].realized_gain_loss).toBe(400); // sold at $6, bought back at $2, ×100
    // Short option P&L is negated: raw (200 - 600 = -400) → negated → +400
  });

  it("long call exercised: stock cost basis includes premium", () => {
    // Buy AAPL call at $5 premium, exercise into stock at $180 strike
    // IRS: stock cost basis = strike ($180) + premium ($5) = $185/share
    insertOptionSecurity(10, "AAPL  260619C00180000", "CALL", 180, "2026-06-19");
    insertTransaction(10, "BUY_TO_OPEN", "2026-01-15", 1, 5.00); // buy 1 call
    insertTransaction(10, "EXERCISED", "2026-05-01", 1, 5.00); // exercise the call
    insertTransaction(1, "BUY", "2026-05-01", 100, 180.00); // receive 100 shares at strike

    const result = computeTaxLots(db);

    // Option lot should be closed at $0 (no gain/loss)
    const optionSales = getTaxLotSales().filter((s) => s.security_type === "option");
    expect(optionSales.length).toBe(1);
    expect(optionSales[0].sale_price).toBe(0);
    expect(optionSales[0].realized_gain_loss).toBe(-500); // option lot: 0 - 5×100

    // Stock lot should have adjusted cost basis: $180 + $5 = $185
    const stockLots = getTaxLots().filter((l) => l.security_type === "stock");
    expect(stockLots.length).toBe(1);
    expect(stockLots[0].acquisition_price).toBe(185);
    expect(stockLots[0].cost_basis).toBe(18500); // 100 * $185
  });

  it("long put exercised: stock sale proceeds reduced by premium", () => {
    // Own 100 AAPL shares at $150, buy $170 put for $8, exercise put
    // IRS: sale proceeds = strike ($170) - premium ($8) = $162/share
    insertOptionSecurity(10, "AAPL  260619P00170000", "PUT", 170, "2026-06-19");

    insertTransaction(1, "BUY", "2025-06-01", 100, 150.00); // buy stock
    insertTransaction(10, "BUY_TO_OPEN", "2026-01-15", 1, 8.00); // buy put
    insertTransaction(10, "EXERCISED", "2026-04-01", 1, 8.00); // exercise put
    insertTransaction(1, "SELL", "2026-04-01", 100, 170.00); // sell stock at strike

    const result = computeTaxLots(db);

    // Stock sale should have adjusted proceeds: $170 - $8 = $162/share
    const stockSales = getTaxLotSales().filter((s) => s.security_type === "stock");
    expect(stockSales.length).toBe(1);
    expect(stockSales[0].sale_price).toBe(162); // 170 - 8
    expect(stockSales[0].proceeds).toBe(16200); // 100 * 162
    expect(stockSales[0].cost_basis_allocated).toBe(15000); // 100 * 150
    expect(stockSales[0].realized_gain_loss).toBe(1200); // 16200 - 15000
  });

  it("short call assigned: stock sale proceeds include premium", () => {
    // Own 100 AAPL at $150, sell $180 call for $6 (covered call), get assigned
    // IRS: sale proceeds = strike ($180) + premium ($6) = $186/share
    insertOptionSecurity(10, "AAPL  260619C00180000", "CALL", 180, "2026-06-19");

    insertTransaction(1, "BUY", "2025-06-01", 100, 150.00); // buy stock
    insertTransaction(10, "SELL_TO_OPEN", "2026-02-01", 1, 6.00); // sell call
    insertTransaction(10, "ASSIGNED", "2026-05-15", 1, 6.00); // assigned
    insertTransaction(1, "SELL", "2026-05-15", 100, 180.00); // forced sell at strike

    const result = computeTaxLots(db);

    // Stock sale should have adjusted proceeds: $180 + $6 = $186/share
    const stockSales = getTaxLotSales().filter((s) => s.security_type === "stock");
    expect(stockSales.length).toBe(1);
    expect(stockSales[0].sale_price).toBe(186); // 180 + 6
    expect(stockSales[0].proceeds).toBe(18600);
    expect(stockSales[0].cost_basis_allocated).toBe(15000);
    expect(stockSales[0].realized_gain_loss).toBe(3600); // 18600 - 15000
  });

  it("short put assigned: stock cost basis reduced by premium", () => {
    // Sell AAPL $160 put for $7, get assigned → forced buy at $160
    // IRS: stock cost basis = strike ($160) - premium ($7) = $153/share
    insertOptionSecurity(10, "AAPL  260619P00160000", "PUT", 160, "2026-06-19");

    insertTransaction(10, "SELL_TO_OPEN", "2026-02-01", 1, 7.00); // sell put
    insertTransaction(10, "ASSIGNED", "2026-05-01", 1, 7.00); // assigned
    insertTransaction(1, "BUY", "2026-05-01", 100, 160.00); // forced buy at strike

    const result = computeTaxLots(db);

    // Stock lot should have adjusted cost basis: $160 - $7 = $153/share
    const stockLots = getTaxLots().filter((l) => l.security_type === "stock");
    expect(stockLots.length).toBe(1);
    expect(stockLots[0].acquisition_price).toBe(153); // 160 - 7
    expect(stockLots[0].cost_basis).toBe(15300); // 100 * 153
  });

  it("mixed scenario: option lots don't affect regular stock lots", () => {
    // Regular stock buy/sell + unrelated option buy/sell
    insertOptionSecurity(10, "AAPL  260619C00200000", "CALL", 200, "2026-06-19");

    insertTransaction(1, "BUY", "2025-06-01", 50, 140.00); // stock buy
    insertTransaction(10, "BUY_TO_OPEN", "2026-01-15", 2, 3.50); // option buy
    insertTransaction(1, "SELL", "2026-03-01", 50, 160.00); // stock sell (unrelated to option)
    insertTransaction(10, "SELL_TO_CLOSE", "2026-04-01", 2, 5.00); // close option

    const result = computeTaxLots(db);

    // Stock sale should NOT be affected by option premium
    const stockSales = getTaxLotSales().filter((s) => s.security_type === "stock");
    expect(stockSales.length).toBe(1);
    expect(stockSales[0].sale_price).toBe(160); // unchanged
    expect(stockSales[0].realized_gain_loss).toBe(1000); // (160-140)*50

    // Option sale should be normal
    const optionSales = getTaxLotSales().filter((s) => s.security_type === "option");
    expect(optionSales.length).toBe(1);
    expect(optionSales[0].sale_price).toBe(5);
    expect(optionSales[0].cost_basis_allocated).toBe(700); // 2 * 3.50 * 100
    expect(optionSales[0].realized_gain_loss).toBe(300); // 1000 - 700
  });

  it("applies the contract multiplier to option sale dollar amounts", () => {
    // Buy 2 calls at $3.50/unit, sell at $5.00/unit. With the ×100 contract
    // multiplier the real dollars are: cost $700, proceeds $1,000, P&L $300.
    // sale_price stays per-unit ($5) — only the dollar columns scale.
    insertOptionSecurity(10, "AAPL  260619C00200000", "CALL", 200, "2026-06-19");
    insertTransaction(10, "BUY_TO_OPEN", "2026-01-15", 2, 3.50);
    insertTransaction(10, "SELL_TO_CLOSE", "2026-04-01", 2, 5.00);

    const result = computeTaxLots(db);

    const sales = getTaxLotSales();
    expect(sales.length).toBe(1);
    expect(sales[0].sale_price).toBe(5); // per-unit, unchanged
    expect(sales[0].cost_basis_allocated).toBe(700); // 2 × $3.50 × 100
    expect(sales[0].proceeds).toBe(1000); // 2 × $5.00 × 100
    expect(sales[0].realized_gain_loss).toBe(300);
    expect(result.totalRealizedGain).toBe(300);
  });

  it("applies the contract multiplier to short option P&L", () => {
    // Sell 3 calls at $4/unit, expire worthless → keep 3 × $4 × 100 = $1,200
    insertOptionSecurity(10, "AAPL  260619C00200000", "CALL", 200, "2026-06-19");
    insertTransaction(10, "SELL_TO_OPEN", "2026-02-01", 3, 4.00);
    insertTransaction(10, "EXPIRED", "2026-06-19", 3, 0);

    computeTaxLots(db);

    const sales = getTaxLotSales();
    expect(sales.length).toBe(1);
    expect(sales[0].cost_basis_allocated).toBe(1200); // 3 × $4 × 100
    expect(sales[0].realized_gain_loss).toBe(1200); // kept full premium
  });

  it("sets is_short=1 on SELL_TO_OPEN lots, is_short=0 on others", () => {
    insertOptionSecurity(10, "AAPL  260619C00200000", "CALL", 200, "2026-06-19");

    // Long option (BUY_TO_OPEN) — should be is_short=0
    insertTransaction(10, "BUY_TO_OPEN", "2026-01-10", 1, 5.00);
    // Short option (SELL_TO_OPEN) — should be is_short=1
    insertTransaction(10, "SELL_TO_OPEN", "2026-01-15", 1, 4.00);
    // Regular stock buy — should be is_short=0
    insertTransaction(1, "BUY", "2025-06-01", 100, 150.00);

    computeTaxLots(db);

    const lots = db
      .prepare(
        "SELECT is_short, acquisition_price FROM tax_lots ORDER BY acquisition_date, id"
      )
      .all() as Array<{ is_short: number; acquisition_price: number }>;

    expect(lots).toHaveLength(3);
    expect(lots[0].is_short).toBe(0); // stock BUY
    expect(lots[1].is_short).toBe(0); // BUY_TO_OPEN
    expect(lots[2].is_short).toBe(1); // SELL_TO_OPEN
  });

  it("existing stock/bond tax lots are unaffected by option changes", () => {
    // Verify that adding option support doesn't break regular stock FIFO
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type) VALUES (2, 'MSFT', 'Microsoft', 'stock')"
    ).run();
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type) VALUES (3, 'BOND1', 'Treasury Bond', 'bond')"
    ).run();

    insertTransaction(1, "BUY", "2025-01-15", 100, 150.00); // AAPL stock
    insertTransaction(2, "BUY", "2025-02-01", 50, 400.00); // MSFT stock
    insertTransaction(1, "SELL", "2025-12-01", 30, 175.00); // partial AAPL sell

    const result = computeTaxLots(db);
    expect(result.lotsCreated).toBe(2);
    expect(result.salesProcessed).toBe(1);

    const aaplLots = getTaxLots().filter((l) => l.symbol === "AAPL");
    expect(aaplLots[0].quantity_remaining).toBe(70); // 100 - 30

    const sales = getTaxLotSales();
    expect(sales[0].realized_gain_loss).toBe(750); // (175-150)*30
  });
});

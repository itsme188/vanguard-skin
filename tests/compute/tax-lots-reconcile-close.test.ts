import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";

/**
 * Broker-close reconciliation pass (deep-QA phantom-lot finding): when the
 * latest holdings row for (account, security) is an explicit quantity-0
 * broker snapshot (the reconcileClosedEquityHoldings family writes these)
 * and FIFO left lots open with no matching SELL, computeTaxLots synthesizes
 * an engine-owned RECONCILE_CLOSE transaction and closes the lots through
 * the normal FIFO path. Self-healing: synthetic rows are deleted and
 * regenerated every run, so the real statement SELL supersedes them.
 */

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts: { type?: string } = {},
): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)")
    .run(symbol, `${symbol} Corp`, opts.type ?? "Stock");
  return result.lastInsertRowid as number;
}

let txnSeq = 0;
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
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      opts.account_id,
      opts.security_id,
      opts.trade_date,
      opts.type,
      opts.quantity,
      opts.price_per_share,
      opts.amount,
      `test-${opts.type}-${opts.trade_date}-${txnSeq++}`,
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
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run(accountId, securityId, quantity, asOfDate, `test-hold-${accountId}-${securityId}-${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')",
  ).run(securityId, date, price);
}

function openLots(db: Database.Database, accountId: number, securityId: number) {
  return db
    .prepare(
      "SELECT * FROM tax_lots WHERE account_id = ? AND security_id = ? AND quantity_remaining > 0",
    )
    .all(accountId, securityId) as any[];
}

function syntheticTxns(db: Database.Database) {
  return db
    .prepare("SELECT * FROM transactions WHERE type = 'RECONCILE_CLOSE' ORDER BY id")
    .all() as any[];
}

describe("computeTaxLots broker-close reconciliation", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("synthesizes a close for a broker-zeroed position with no matching SELL (AAPL repro)", () => {
    const sec = seedSecurity(db, "AAPL");
    seedTransaction(db, {
      account_id: ACCOUNT_ID, security_id: sec, trade_date: "2026-06-25",
      type: "BUY", quantity: 20, price_per_share: 250, amount: -5000,
    });
    // Broker snapshot: position closed 2026-06-29 (explicit zero row).
    seedHolding(db, ACCOUNT_ID, sec, 0, "2026-06-29");
    seedPrice(db, sec, "2026-06-29", 280);

    const result = computeTaxLots(db);

    expect(openLots(db, ACCOUNT_ID, sec)).toHaveLength(0);
    const synth = syntheticTxns(db);
    expect(synth).toHaveLength(1);
    expect(synth[0].trade_date).toBe("2026-06-29");
    expect(synth[0].quantity).toBe(20);
    expect(synth[0].price_per_share).toBe(280);

    const sales = db.prepare("SELECT * FROM tax_lot_sales").all() as any[];
    expect(sales).toHaveLength(1);
    expect(sales[0].quantity_sold).toBe(20);
    expect(sales[0].sale_price).toBe(280);
    expect(sales[0].realized_gain_loss).toBeCloseTo(20 * (280 - 250), 6);
    expect(sales[0].is_long_term).toBe(0);
    expect(result.salesProcessed).toBe(1);
  });

  it("self-heals when the real SELL arrives: synthetic row deleted, sale attributed to the real transaction", () => {
    const sec = seedSecurity(db, "AAPL");
    seedTransaction(db, {
      account_id: ACCOUNT_ID, security_id: sec, trade_date: "2026-06-25",
      type: "BUY", quantity: 20, price_per_share: 250, amount: -5000,
    });
    seedHolding(db, ACCOUNT_ID, sec, 0, "2026-06-29");
    seedPrice(db, sec, "2026-06-29", 280);
    computeTaxLots(db); // first run synthesizes

    // Next statement import lands the real sell.
    const realSell = seedTransaction(db, {
      account_id: ACCOUNT_ID, security_id: sec, trade_date: "2026-06-27",
      type: "SELL", quantity: 20, price_per_share: 275, amount: 5500,
    });
    computeTaxLots(db); // second run must NOT double-close

    expect(syntheticTxns(db)).toHaveLength(0);
    const sales = db.prepare("SELECT * FROM tax_lot_sales").all() as any[];
    expect(sales).toHaveLength(1);
    expect(sales[0].sale_transaction_id).toBe(realSell);
    expect(sales[0].sale_price).toBe(275);
    expect(openLots(db, ACCOUNT_ID, sec)).toHaveLength(0);
  });

  it("is idempotent — consecutive runs produce one synthetic close, not duplicates", () => {
    const sec = seedSecurity(db, "AAPL");
    seedTransaction(db, {
      account_id: ACCOUNT_ID, security_id: sec, trade_date: "2026-06-25",
      type: "BUY", quantity: 20, price_per_share: 250, amount: -5000,
    });
    seedHolding(db, ACCOUNT_ID, sec, 0, "2026-06-29");
    seedPrice(db, sec, "2026-06-29", 280);

    computeTaxLots(db);
    computeTaxLots(db);
    computeTaxLots(db);

    expect(syntheticTxns(db)).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) c FROM tax_lot_sales").get()).toMatchObject({ c: 1 });
  });

  it("closes only the remainder when a real SELL consumed part of the lot", () => {
    const sec = seedSecurity(db, "MSFT");
    seedTransaction(db, {
      account_id: ACCOUNT_ID, security_id: sec, trade_date: "2026-05-01",
      type: "BUY", quantity: 30, price_per_share: 100, amount: -3000,
    });
    seedTransaction(db, {
      account_id: ACCOUNT_ID, security_id: sec, trade_date: "2026-05-20",
      type: "SELL", quantity: 10, price_per_share: 110, amount: 1100,
    });
    seedHolding(db, ACCOUNT_ID, sec, 0, "2026-06-01");
    seedPrice(db, sec, "2026-06-01", 120);

    computeTaxLots(db);

    const synth = syntheticTxns(db);
    expect(synth).toHaveLength(1);
    expect(synth[0].quantity).toBe(20);
    expect(openLots(db, ACCOUNT_ID, sec)).toHaveLength(0);
  });

  it("does NOT synthesize when the ledger is fresher than the snapshot (BUY after the zero row)", () => {
    const sec = seedSecurity(db, "NVDA");
    seedTransaction(db, {
      account_id: ACCOUNT_ID, security_id: sec, trade_date: "2026-06-01",
      type: "BUY", quantity: 10, price_per_share: 100, amount: -1000,
    });
    seedHolding(db, ACCOUNT_ID, sec, 0, "2026-06-10");
    // Re-entered AFTER the broker snapshot went flat — snapshot is stale.
    seedTransaction(db, {
      account_id: ACCOUNT_ID, security_id: sec, trade_date: "2026-06-15",
      type: "BUY", quantity: 5, price_per_share: 105, amount: -525,
    });
    seedPrice(db, sec, "2026-06-10", 110);

    computeTaxLots(db);

    expect(syntheticTxns(db)).toHaveLength(0);
    // Both lots stay open — nothing sold.
    expect(openLots(db, ACCOUNT_ID, sec)).toHaveLength(2);
  });

  it("does NOT synthesize without an explicit zero row (missing holdings ≠ closed)", () => {
    const sec = seedSecurity(db, "TSLA");
    seedTransaction(db, {
      account_id: ACCOUNT_ID, security_id: sec, trade_date: "2026-06-01",
      type: "BUY", quantity: 10, price_per_share: 100, amount: -1000,
    });
    // No holdings rows at all for this pair.
    computeTaxLots(db);

    expect(syntheticTxns(db)).toHaveLength(0);
    expect(openLots(db, ACCOUNT_ID, sec)).toHaveLength(1);
  });

  it("does NOT synthesize when the latest holdings row is non-zero", () => {
    const sec = seedSecurity(db, "AMD");
    seedTransaction(db, {
      account_id: ACCOUNT_ID, security_id: sec, trade_date: "2026-06-01",
      type: "BUY", quantity: 10, price_per_share: 100, amount: -1000,
    });
    seedHolding(db, ACCOUNT_ID, sec, 0, "2026-06-10");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2026-06-20"); // later live row wins
    computeTaxLots(db);

    expect(syntheticTxns(db)).toHaveLength(0);
    expect(openLots(db, ACCOUNT_ID, sec)).toHaveLength(1);
  });

  it("never synthesizes for options or bonds (their own purge paths + EXPIRED/REDEMPTION own those)", () => {
    const opt = seedSecurity(db, "AAPL  260320C00250000", { type: "Option" });
    const bond = seedSecurity(db, "T-BILL-2026", { type: "Bond" });
    for (const sec of [opt, bond]) {
      seedTransaction(db, {
        account_id: ACCOUNT_ID, security_id: sec, trade_date: "2026-06-01",
        type: "BUY", quantity: 1, price_per_share: 5, amount: -5,
      });
      seedHolding(db, ACCOUNT_ID, sec, 0, "2026-06-20");
      seedPrice(db, sec, "2026-06-20", 6);
    }
    computeTaxLots(db);

    expect(syntheticTxns(db)).toHaveLength(0);
    expect(openLots(db, ACCOUNT_ID, opt)).toHaveLength(1);
    expect(openLots(db, ACCOUNT_ID, bond)).toHaveLength(1);
  });

  it("falls back to a breakeven close (acquisition price) when no price exists", () => {
    const sec = seedSecurity(db, "NOPRICE");
    seedTransaction(db, {
      account_id: ACCOUNT_ID, security_id: sec, trade_date: "2026-06-01",
      type: "BUY", quantity: 10, price_per_share: 40, amount: -400,
    });
    seedHolding(db, ACCOUNT_ID, sec, 0, "2026-06-15");

    computeTaxLots(db);

    const sales = db.prepare("SELECT * FROM tax_lot_sales").all() as any[];
    expect(sales).toHaveLength(1);
    expect(sales[0].realized_gain_loss).toBeCloseTo(0, 6);
    expect(openLots(db, ACCOUNT_ID, sec)).toHaveLength(0);
  });

  it("marks a >365-day holding long-term as of the zero-row date", () => {
    const sec = seedSecurity(db, "OLD");
    seedTransaction(db, {
      account_id: ACCOUNT_ID, security_id: sec, trade_date: "2025-01-10",
      type: "BUY", quantity: 5, price_per_share: 50, amount: -250,
    });
    seedHolding(db, ACCOUNT_ID, sec, 0, "2026-06-15");
    seedPrice(db, sec, "2026-06-15", 60);

    computeTaxLots(db);

    const sales = db.prepare("SELECT * FROM tax_lot_sales").all() as any[];
    expect(sales).toHaveLength(1);
    expect(sales[0].is_long_term).toBe(1);
  });
});

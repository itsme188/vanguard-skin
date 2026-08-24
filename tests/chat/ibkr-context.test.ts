import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeBullishness, computeIbkrTradingContext } from "@/lib/chat/ibkr-context";

describe("computeBullishness", () => {
  it("returns 1 for very high cash (>=50%)", () => {
    expect(computeBullishness(60, null)).toBe(1);
    expect(computeBullishness(50, null)).toBe(1);
  });

  it("returns 2 for high cash (40-49%)", () => {
    expect(computeBullishness(45, null)).toBe(2);
    expect(computeBullishness(40, null)).toBe(2);
  });

  it("returns 3 for moderate cash (30-39%)", () => {
    expect(computeBullishness(35, null)).toBe(3);
    expect(computeBullishness(30, null)).toBe(3);
  });

  it("returns 4 for low cash (20-29%)", () => {
    expect(computeBullishness(25, null)).toBe(4);
    expect(computeBullishness(20, null)).toBe(4);
  });

  it("returns 5 for very low cash (<20%)", () => {
    expect(computeBullishness(10, null)).toBe(5);
    expect(computeBullishness(5, null)).toBe(5);
    expect(computeBullishness(0, null)).toBe(5);
  });

  it("adjusts down by 1 for low beta (<0.5)", () => {
    // 25% cash → 4, but beta 0.3 → 3
    expect(computeBullishness(25, 0.3)).toBe(3);
    // 10% cash → 5, but beta 0.4 → 4
    expect(computeBullishness(10, 0.4)).toBe(4);
  });

  it("adjusts up by 1 for high beta (>1.2)", () => {
    // 35% cash → 3, but beta 1.5 → 4
    expect(computeBullishness(35, 1.5)).toBe(4);
    // 45% cash → 2, but beta 1.3 → 3
    expect(computeBullishness(45, 1.3)).toBe(3);
  });

  it("clamps to minimum 1", () => {
    // 60% cash → 1, beta 0.3 would adjust to 0, clamped to 1
    expect(computeBullishness(60, 0.3)).toBe(1);
  });

  it("clamps to maximum 5", () => {
    // 5% cash → 5, beta 1.5 would adjust to 6, clamped to 5
    expect(computeBullishness(5, 1.5)).toBe(5);
  });

  it("no adjustment when beta is exactly 0.5", () => {
    expect(computeBullishness(25, 0.5)).toBe(4); // no adjustment
  });

  it("no adjustment when beta is exactly 1.2", () => {
    expect(computeBullishness(25, 1.2)).toBe(4); // no adjustment
  });

  it("handles null beta (no adjustment)", () => {
    expect(computeBullishness(25, null)).toBe(4);
  });

  it("handles 100% cash", () => {
    expect(computeBullishness(100, null)).toBe(1);
  });
});

// ─── avgHoldingDays — signed-HPD convention (number-trust durable fixes) ──

describe("computeIbkrTradingContext — avgHoldingDays", () => {
  let db: Database.Database;
  const IBKR_ACCOUNT_ID = 3; // seeded by migration 002_seed_accounts.sql

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedSecurity(symbol: string): number {
    const r = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'stock')"
      )
      .run(symbol, symbol);
    return r.lastInsertRowid as number;
  }

  function recentDate(daysAgo: number): string {
    return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  }

  it("uses AVG(ABS(holding_period_days)) so a short round-trip's signed-negative days don't drag the average toward zero", () => {
    const longSec = seedSecurity("LONGCO");
    const shortSec = seedSecurity("SHRTCO");

    // Long round-trip: held 20 days, holding_period_days = +20 (unsigned already).
    const longBuyTxn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
         VALUES (?, ?, ?, 'BUY', 10, 100, -1000, 'k-long-buy')`
      )
      .run(IBKR_ACCOUNT_ID, longSec, recentDate(30));
    const longLot = db
      .prepare(
        `INSERT INTO tax_lots (account_id, security_id, acquisition_transaction_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_short)
         VALUES (?, ?, ?, ?, 100, 10, 0, 1000, 0)`
      )
      .run(IBKR_ACCOUNT_ID, longSec, longBuyTxn.lastInsertRowid, recentDate(30));
    const longSellTxn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
         VALUES (?, ?, ?, 'SELL', 10, 110, 1100, 'k-long-sell')`
      )
      .run(IBKR_ACCOUNT_ID, longSec, recentDate(10));
    db.prepare(
      `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, sale_date)
       VALUES (?, ?, 10, 110, 1100, 1000, 100, 0, 20, ?)`
    ).run(longLot.lastInsertRowid, longSellTxn.lastInsertRowid, recentDate(10));

    // Short round-trip: open→cover span is 6 days, stored SIGNED NEGATIVE (-6)
    // per the WS1 convention — a bookkeeping signal (always short-term), not
    // a literal negative duration.
    const shortOpenTxn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
         VALUES (?, ?, ?, 'SELL_TO_OPEN', 5, 50, 250, 'k-short-open')`
      )
      .run(IBKR_ACCOUNT_ID, shortSec, recentDate(15));
    const shortLot = db
      .prepare(
        `INSERT INTO tax_lots (account_id, security_id, acquisition_transaction_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_short)
         VALUES (?, ?, ?, ?, 50, 5, 0, 250, 1)`
      )
      .run(IBKR_ACCOUNT_ID, shortSec, shortOpenTxn.lastInsertRowid, recentDate(15));
    const shortCoverTxn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
         VALUES (?, ?, ?, 'BUY_TO_COVER', 5, 40, -200, 'k-short-cover')`
      )
      .run(IBKR_ACCOUNT_ID, shortSec, recentDate(9));
    db.prepare(
      `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, sale_date)
       VALUES (?, ?, 5, 40, 200, 250, 50, 0, -6, ?)`
    ).run(shortLot.lastInsertRowid, shortCoverTxn.lastInsertRowid, recentDate(9));

    const ctx = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");

    // AVG(ABS([20, -6])) = AVG([20, 6]) = 13 — NOT the naive signed average
    // AVG([20, -6]) = 7, which would understate true average days-in-trade
    // (or go negative for a short-heavy trader).
    expect(ctx.avgHoldingDays).toBe(13);
  });

  it("returns null when there are no closed lots in the window", () => {
    const ctx = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");
    expect(ctx.avgHoldingDays).toBeNull();
  });
});

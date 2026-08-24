/**
 * lib/queries/trade-reviews.ts — getTradeRoundtrips.
 *
 * finding 1 (number-trust durable fixes): a stored trade_roundtrips row
 * whose sale_transaction_id points at an engine-owned synthetic
 * RECONCILE_CLOSE transaction (never real broker activity) must expose
 * isSyntheticClose so the TradeReviewView surface can label the realized
 * P&L "estimated" rather than presenting it as a genuine broker trade.
 * Derived at READ time (joined via sale_transaction_id) rather than
 * persisted, so it can never drift from the current ledger state.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getTradeRoundtrips } from "@/lib/queries/trade-reviews";

describe("getTradeRoundtrips", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // seeded by migration 002

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedReview(): number {
    const review = db
      .prepare(
        `INSERT INTO trade_reviews
           (account_id, period_start, period_end, total_trades, winning_trades, losing_trades,
            win_rate, total_realized_pnl, review_markdown)
         VALUES (?, '2026-06-01', '2026-06-30', 1, 1, 0, 1, 148, 'test review')`
      )
      .run(ACCOUNT_ID);
    return review.lastInsertRowid as number;
  }

  function seedSecurity(symbol: string): number {
    const sec = db
      .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`)
      .run(symbol, `${symbol} Corp`);
    return sec.lastInsertRowid as number;
  }

  function seedSaleTransaction(securityId: number, type: string): number {
    const txn = db
      .prepare(
        `INSERT INTO transactions
           (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
         VALUES (?, ?, '2026-06-15', ?, 10, 20, 200, ?)`
      )
      .run(ACCOUNT_ID, securityId, type, `sale-${type}-${securityId}`);
    return txn.lastInsertRowid as number;
  }

  function seedRoundtrip(reviewId: number, securityId: number, saleTransactionId: number | null): void {
    db.prepare(
      `INSERT INTO trade_roundtrips
         (review_id, account_id, security_id, symbol, entry_date, entry_price, entry_quantity, entry_cost,
          exit_date, exit_price, exit_quantity, exit_proceeds, holding_days, realized_pnl, return_pct,
          sale_transaction_id)
       VALUES (?, ?, ?, 'AAPL', '2026-05-01', 15, 10, 150, '2026-06-15', 20, 10, 200, 45, 50, 33.3, ?)`
    ).run(reviewId, ACCOUNT_ID, securityId, saleTransactionId);
  }

  it("is false for a roundtrip whose sale transaction is a real SELL", () => {
    const reviewId = seedReview();
    const secId = seedSecurity("AAPL");
    const saleTxnId = seedSaleTransaction(secId, "SELL");
    seedRoundtrip(reviewId, secId, saleTxnId);

    const rows = getTradeRoundtrips(db, reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_synthetic_close).toBe(false);
  });

  it("is true for a roundtrip whose sale transaction is an engine-owned RECONCILE_CLOSE", () => {
    const reviewId = seedReview();
    const secId = seedSecurity("MSFT");
    const saleTxnId = seedSaleTransaction(secId, "RECONCILE_CLOSE");
    seedRoundtrip(reviewId, secId, saleTxnId);

    const rows = getTradeRoundtrips(db, reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_synthetic_close).toBe(true);
  });

  it("is false (never null/undefined) for a legacy roundtrip with no sale_transaction_id", () => {
    const reviewId = seedReview();
    const secId = seedSecurity("TSLA");
    seedRoundtrip(reviewId, secId, null);

    const rows = getTradeRoundtrips(db, reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_synthetic_close).toBe(false);
  });
});

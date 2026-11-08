import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getLedgerCensus } from "@/lib/compute/donation-recompute";

/**
 * QA finding: the Giving recompute dialog said "Estimated closes 3" while the
 * Tax Lots page said 17 for the same book. The page counts engine-estimated
 * closes as tax_lot_sales rows whose sale transaction is a RECONCILE_CLOSE;
 * the census counted the RECONCILE_CLOSE transactions themselves. One unit.
 */
describe("getLedgerCensus engineCloses", () => {
  it("counts sale rows closed by an engine transaction, not the transactions", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const accountId = db.prepare(
      "INSERT INTO accounts (name, tax_treatment) VALUES ('Test', 'taxable')",
    ).run().lastInsertRowid as number;
    const secId = db.prepare(
      "INSERT INTO securities (symbol, name, security_type) VALUES ('AAA', 'AAA Corp', 'Stock')",
    ).run().lastInsertRowid as number;
    const buy = db.prepare(
      `INSERT INTO transactions (account_id, security_id, type, trade_date, quantity, price_per_share, amount, source_key)
       VALUES (?, ?, 'BUY', '2025-01-02', 30, 10, -300, 'txn:buy')`,
    ).run(accountId, secId).lastInsertRowid as number;
    const close = db.prepare(
      `INSERT INTO transactions (account_id, security_id, type, trade_date, quantity, price_per_share, amount, source_key)
       VALUES (?, ?, 'RECONCILE_CLOSE', '2025-06-30', 30, 12, 360, 'txn:recon')`,
    ).run(accountId, secId).lastInsertRowid as number;
    const insLot = db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis, acquisition_transaction_id)
       VALUES (?, ?, '2025-01-02', 10, 10, 0, 100, ?)`,
    );
    const insSale = db.prepare(
      `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
       VALUES (?, ?, '2025-06-30', 10, 12, 120, 100, 20, 0, 179)`,
    );
    for (let i = 0; i < 3; i++) {
      const lotId = insLot.run(accountId, secId, buy).lastInsertRowid as number;
      insSale.run(lotId, close);
    }
    const census = getLedgerCensus(db);
    expect(census.closedSales).toBe(3);
    expect(census.engineCloses).toBe(3);
  });
});

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Digest of the computed tax ledger keyed by transaction source_key, never by
 * autoincrement id (a synthetic close is re-inserted on every run, so its id
 * moves while its source_key does not). Two engine runs that produce the same
 * lots and sales produce the same digest.
 */
export function ledgerDigest(db: Database.Database): string {
  const lots = db
    .prepare(
      `SELECT bt.source_key AS k, tl.account_id, tl.security_id, tl.acquisition_date,
              tl.quantity_acquired, tl.quantity_remaining, ROUND(tl.cost_basis, 6) AS cb
         FROM tax_lots tl LEFT JOIN transactions bt ON bt.id = tl.acquisition_transaction_id
        ORDER BY k, tl.account_id, tl.security_id, tl.acquisition_date, tl.quantity_acquired`,
    )
    .all();
  const sales = db
    .prepare(
      `SELECT st.source_key AS sk, bt.source_key AS bk, st.trade_date, tls.quantity_sold,
              ROUND(tls.proceeds, 6) AS p, ROUND(tls.realized_gain_loss, 6) AS g
         FROM tax_lot_sales tls
         JOIN transactions st ON st.id = tls.sale_transaction_id
         JOIN tax_lots tl ON tl.id = tls.tax_lot_id
         LEFT JOIN transactions bt ON bt.id = tl.acquisition_transaction_id
        ORDER BY sk, bk, tls.quantity_sold`,
    )
    .all();
  return createHash("sha256").update(JSON.stringify({ lots, sales })).digest("hex");
}

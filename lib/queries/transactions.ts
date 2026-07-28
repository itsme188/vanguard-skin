import type Database from "better-sqlite3";
import type { Transaction } from "@/lib/types";

export interface TransactionWithSecurity extends Transaction {
  symbol: string | null;
  security_name: string | null;
  account_name: string;
}

/**
 * price_per_share / amount are stored in the security's NATIVE currency
 * (FX convention) — the fx_rates join converts them to USD for this
 * pure-display path, mirroring getTransactionsBySecurity on Security
 * Detail (a703773). The converted aliases after t.* deliberately shadow
 * the native columns (better-sqlite3 row objects are built in column
 * order, so the last same-named column wins).
 */
export function getTransactionsByAccount(
  db: Database.Database,
  accountId: number,
  options?: { limit?: number; offset?: number; type?: string }
): TransactionWithSecurity[] {
  let sql = `
    SELECT t.*,
           t.price_per_share * COALESCE(fx.usd_per_unit, 1) as price_per_share,
           t.amount * COALESCE(fx.usd_per_unit, 1) as amount,
           s.symbol, s.name as security_name, a.name as account_name
    FROM transactions t
    LEFT JOIN securities s ON s.id = t.security_id
    LEFT JOIN fx_rates fx ON fx.currency = s.currency
    JOIN accounts a ON a.id = t.account_id
    WHERE t.account_id = ?
  `;
  const params: (number | string)[] = [accountId];

  if (options?.type) {
    sql += " AND t.type = ?";
    params.push(options.type);
  }

  sql += " ORDER BY t.trade_date DESC";

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
    if (options?.offset) {
      sql += " OFFSET ?";
      params.push(options.offset);
    }
  }

  return db.prepare(sql).all(...params) as TransactionWithSecurity[];
}

export function getTransactionCount(
  db: Database.Database,
  accountId: number
): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) as count FROM transactions WHERE account_id = ?"
      )
      .get(accountId) as { count: number }
  ).count;
}

import type Database from "better-sqlite3";
import type { Transaction } from "@/lib/types";

export interface TransactionWithSecurity extends Transaction {
  symbol: string | null;
  security_name: string | null;
  account_name: string;
}

export function getTransactionsByAccount(
  db: Database.Database,
  accountId: number,
  options?: { limit?: number; offset?: number; type?: string }
): TransactionWithSecurity[] {
  let sql = `
    SELECT t.*, s.symbol, s.name as security_name, a.name as account_name
    FROM transactions t
    LEFT JOIN securities s ON s.id = t.security_id
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

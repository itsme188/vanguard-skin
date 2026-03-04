import type Database from "better-sqlite3";
import type { Holding } from "@/lib/types";

export interface HoldingWithSecurity extends Holding {
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  account_name: string;
}

export function getHoldingsByAccount(
  db: Database.Database,
  accountId: number,
  asOfDate?: string
): HoldingWithSecurity[] {
  let sql = `
    SELECT h.*, s.symbol, s.name as security_name, s.security_type, a.name as account_name
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    JOIN accounts a ON a.id = h.account_id
    WHERE h.account_id = ?
  `;
  const params: (number | string)[] = [accountId];

  if (asOfDate) {
    sql += " AND h.as_of_date = ?";
    params.push(asOfDate);
  } else {
    sql +=
      " AND h.as_of_date = (SELECT MAX(as_of_date) FROM holdings WHERE account_id = ?)";
    params.push(accountId);
  }

  sql += " ORDER BY s.symbol";

  return db.prepare(sql).all(...params) as HoldingWithSecurity[];
}

export function getLatestHoldingsDate(
  db: Database.Database,
  accountId: number
): string | null {
  const result = db
    .prepare(
      "SELECT MAX(as_of_date) as latest FROM holdings WHERE account_id = ?"
    )
    .get(accountId) as { latest: string | null };
  return result?.latest ?? null;
}

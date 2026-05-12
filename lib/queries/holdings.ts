import type Database from "better-sqlite3";
import type { Holding } from "@/lib/types";
import { adjustedMarketValueSQL } from "@/lib/valuation";

export interface HoldingWithSecurity extends Holding {
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  account_name: string;
  underlying_symbol: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  option_type: "CALL" | "PUT" | null;
  multiplier: number;
}

export interface AllHoldingsRow {
  account_id: number;
  account_name: string;
  security_id: number;
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  multiplier: number;
  quantity: number;
  cost_basis: number | null;
  as_of_date: string;
  current_price: number | null;
  current_value: number | null;
  unrealized_gain: number | null;
}

export function getAllHoldings(db: Database.Database): AllHoldingsRow[] {
  const marketValueExpr = adjustedMarketValueSQL(
    "h.quantity",
    "p.close_price",
    "s.security_type",
    "COALESCE(s.multiplier, 1)",
  );

  const sql = `
    SELECT
      h.account_id,
      a.name AS account_name,
      h.security_id,
      s.symbol,
      s.name AS security_name,
      s.security_type,
      COALESCE(s.multiplier, 1) AS multiplier,
      h.quantity,
      h.cost_basis,
      h.as_of_date,
      p.close_price AS current_price,
      CASE WHEN p.close_price IS NOT NULL
        THEN ${marketValueExpr}
        ELSE NULL END AS current_value,
      CASE WHEN p.close_price IS NOT NULL AND h.cost_basis IS NOT NULL
        THEN ${marketValueExpr} - h.cost_basis
        ELSE NULL END AS unrealized_gain
    FROM holdings h
    JOIN accounts a ON a.id = h.account_id
    JOIN securities s ON s.id = h.security_id
    LEFT JOIN prices p ON p.security_id = h.security_id
      AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = h.security_id)
    WHERE h.quantity > 0
      AND h.as_of_date = (
        SELECT MAX(h2.as_of_date) FROM holdings h2
        WHERE h2.account_id = h.account_id
      )
      AND (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
    ORDER BY current_value DESC NULLS LAST
  `;

  return db.prepare(sql).all() as AllHoldingsRow[];
}

export function getHoldingsByAccount(
  db: Database.Database,
  accountId: number,
  asOfDate?: string
): HoldingWithSecurity[] {
  let sql = `
    SELECT h.*, s.symbol, s.name as security_name, s.security_type, a.name as account_name,
           s.underlying_symbol, s.strike_price, s.expiration_date, s.option_type,
           COALESCE(s.multiplier, 1) as multiplier
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

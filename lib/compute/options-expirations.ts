import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

export interface ExpiringOption {
  securityId: number;
  symbol: string;
  underlying: string;
  optionType: "CALL" | "PUT";
  strike: number;
  expiration: string;
  daysToExpiry: number;
  quantity: number;
  accountId: number;
  accountName: string;
}

export interface GetExpiringOptionsOptions {
  accountIds?: number[];
  daysWindow?: number; // default 90
  today?: string;
}

export function getExpiringOptions(
  db: Database.Database,
  options?: GetExpiringOptionsOptions
): ExpiringOption[] {
  const today = options?.today ?? todayET();
  const daysWindow = options?.daysWindow ?? 90;

  const accountFilter = options?.accountIds?.length
    ? `AND h.account_id IN (${options.accountIds.map(() => "?").join(",")})`
    : "";

  // params order matches placeholders left-to-right:
  // 1: SELECT julianday anchor (today), 2: WHERE expiration_date >= today,
  // 3: WHERE julianday anchor (today), 4: WHERE daysWindow ceiling
  const params: (string | number)[] = [today, today, today, daysWindow];
  if (options?.accountIds?.length) params.push(...options.accountIds);

  const rows = db.prepare(`
    SELECT
      s.id AS securityId,
      s.symbol,
      s.underlying_symbol AS underlying,
      UPPER(s.option_type) AS optionType,
      s.strike_price AS strike,
      s.expiration_date AS expiration,
      CAST(julianday(s.expiration_date) - julianday(?) AS INTEGER) AS daysToExpiry,
      h.quantity,
      h.account_id AS accountId,
      a.name AS accountName
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    JOIN accounts a ON a.id = h.account_id
    WHERE LOWER(s.security_type) = 'option'
      AND s.expiration_date IS NOT NULL
      AND s.expiration_date >= ?
      AND CAST(julianday(s.expiration_date) - julianday(?) AS INTEGER) <= ?
      AND ${latestHoldingsPredicate({ accountFilter })}
    ORDER BY s.expiration_date ASC, s.symbol ASC
  `).all(...params) as ExpiringOption[];

  return rows;
}

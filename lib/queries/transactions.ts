import type Database from "better-sqlite3";
import type { Transaction } from "@/lib/types";

export interface TransactionWithSecurity extends Transaction {
  symbol: string | null;
  security_name: string | null;
  account_name: string;
}

export type TransactionSortField =
  | "trade_date"
  | "type"
  | "symbol"
  | "quantity"
  | "amount";

export interface TransactionSort {
  field: TransactionSortField;
  dir: "asc" | "desc";
}

export const DEFAULT_TRANSACTION_SORT: TransactionSort = {
  field: "trade_date",
  dir: "desc",
};

/**
 * The Amount column PRINTS displayCashEffect(type, amount)
 * (lib/format/cash-effect.ts): a buy is always an outflow, a sell always an
 * inflow, whatever sign the source stored. The sort must order by that same
 * printed figure, so this is the SQL twin of that function.
 * tests/queries/transactions-sort.test.ts reads the type lists out of
 * cash-effect.ts and fails if the two drift.
 */
const DISPLAYED_AMOUNT_SQL = `(
  CASE
    WHEN t.type IN ('BUY', 'BUY_TO_OPEN', 'BUY_TO_CLOSE', 'BUY_TO_COVER')
      THEN -ABS(t.amount)
    WHEN t.type IN ('SELL', 'SELL_TO_CLOSE', 'SELL_TO_OPEN')
      THEN ABS(t.amount)
    ELSE t.amount
  END * COALESCE(fx.usd_per_unit, 1)
)`;

// Whitelist: the sort field reaches SQL only through this map, never as a
// raw string from the URL.
const SORT_SQL: Record<TransactionSortField, string> = {
  trade_date: "t.trade_date",
  type: "t.type COLLATE NOCASE",
  symbol: "s.symbol COLLATE NOCASE",
  quantity: "t.quantity",
  amount: DISPLAYED_AMOUNT_SQL,
};

/**
 * Turn the `txnsSort` / `txnsDir` URL params into a safe sort. Anything
 * unrecognised falls back to the default (newest first), the same fallback
 * `useSortParam("txns", "trade_date", "desc")` applies in the browser.
 */
export function parseTransactionSort(
  field: string | null | undefined,
  dir: string | null | undefined,
): TransactionSort {
  const known =
    typeof field === "string" &&
    Object.prototype.hasOwnProperty.call(SORT_SQL, field);
  return {
    field: known ? (field as TransactionSortField) : DEFAULT_TRANSACTION_SORT.field,
    dir: dir === "asc" || dir === "desc" ? dir : DEFAULT_TRANSACTION_SORT.dir,
  };
}

// One predicate for the list and its count, so "showing 50 of N" can never
// disagree with the rows (RECONCILE_CLOSE is engine-owned, see below).
const USER_ACTIVITY_WHERE = "t.account_id = ? AND t.type != 'RECONCILE_CLOSE'";

/**
 * price_per_share / amount are stored in the security's NATIVE currency
 * (FX convention) — the fx_rates join converts them to USD for this
 * pure-display path, mirroring getTransactionsBySecurity on Security
 * Detail (a703773). The converted aliases after t.* deliberately shadow
 * the native columns (better-sqlite3 row objects are built in column
 * order, so the last same-named column wins).
 *
 * RECONCILE_CLOSE rows are excluded — they're engine-owned synthetic
 * transactions (lib/compute/tax-lots.ts), deleted and regenerated on every
 * recompute, and never real user activity (CLAUDE.md invariant). Showing
 * one here reads as a trade the user made when it isn't.
 *
 * `sort` is applied BEFORE `limit`, so a capped list sorted by Amount shows
 * the account's largest rows, not the largest of the newest 50. Missing
 * values sort last in both directions (compareValues does the same in the
 * browser); ties fall back to newest first, then id, so paging is stable.
 */
export function getTransactionsByAccount(
  db: Database.Database,
  accountId: number,
  options?: {
    limit?: number;
    offset?: number;
    type?: string;
    sort?: TransactionSort;
  }
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
    WHERE ${USER_ACTIVITY_WHERE}
  `;
  const params: (number | string)[] = [accountId];

  if (options?.type) {
    sql += " AND t.type = ?";
    params.push(options.type);
  }

  const sort = options?.sort ?? DEFAULT_TRANSACTION_SORT;
  const sortExpr = SORT_SQL[sort.field] ?? SORT_SQL.trade_date;
  const sortDir = sort.dir === "asc" ? "ASC" : "DESC";
  sql += ` ORDER BY (${sortExpr}) IS NULL, ${sortExpr} ${sortDir}, t.trade_date DESC, t.id DESC`;

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

/**
 * How many rows getTransactionsByAccount would return with no limit: the
 * same predicate (engine-owned RECONCILE_CLOSE rows are not counted).
 */
export function getTransactionCount(
  db: Database.Database,
  accountId: number,
  options?: { type?: string }
): number {
  let sql = `SELECT COUNT(*) as count FROM transactions t WHERE ${USER_ACTIVITY_WHERE}`;
  const params: (number | string)[] = [accountId];
  if (options?.type) {
    sql += " AND t.type = ?";
    params.push(options.type);
  }
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

export interface AccountTransactionPage {
  rows: TransactionWithSecurity[];
  /** Every user-activity row for the account, not just the ones in `rows`. */
  total: number;
  /** The sort the rows were fetched in (parsed from the URL params). */
  sort: TransactionSort;
}

/**
 * One capped, sorted page of an account's transactions plus the full count,
 * for the Accounts page: the server component passes the `txnsSort` /
 * `txnsDir` search params straight in.
 */
export function getAccountTransactionPage(
  db: Database.Database,
  accountId: number,
  options: {
    sortParam?: string | null;
    dirParam?: string | null;
    limit: number;
  }
): AccountTransactionPage {
  const sort = parseTransactionSort(options.sortParam, options.dirParam);
  return {
    rows: getTransactionsByAccount(db, accountId, { limit: options.limit, sort }),
    total: getTransactionCount(db, accountId),
    sort,
  };
}

import type Database from "better-sqlite3";

export interface IncomeSummary {
  totalDividends: number;
  totalInterest: number;
  totalFees: number;
  netIncome: number;
  startDate: string;
  endDate: string;
  byAccount: AccountIncome[];
  topPayers: SymbolIncome[];
}

export interface AccountIncome {
  accountId: number;
  accountName: string;
  dividends: number;
  interest: number;
  fees: number;
}

export interface SymbolIncome {
  symbol: string;
  securityName: string | null;
  dividends: number;
  interest: number;
}

interface AccountRow {
  account_id: number;
  account_name: string;
  dividends: number;
  interest: number;
  fees: number;
}

interface SymbolRow {
  symbol: string;
  security_name: string | null;
  dividends: number;
  interest: number;
}

interface TotalRow {
  total_dividends: number;
  total_interest: number;
  total_fees: number;
}

/**
 * Aggregate dividend / interest / fee transactions over a date range,
 * with per-account and per-symbol breakdowns. Uses uppercase-normalized
 * type comparisons consistent with the rest of the codebase.
 */
export function getIncomeSummary(
  db: Database.Database,
  startDate: string,
  endDate: string,
  accountIds?: number[],
): IncomeSummary {
  const accountFilter = accountIds && accountIds.length > 0
    ? `AND t.account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";
  const accountParams = accountIds ?? [];

  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN UPPER(t.type) IN ('DIVIDEND', 'REINVESTMENT') THEN ABS(t.amount) ELSE 0 END), 0) AS total_dividends,
         COALESCE(SUM(CASE WHEN UPPER(t.type) = 'INTEREST' THEN ABS(t.amount) ELSE 0 END), 0) AS total_interest,
         COALESCE(SUM(CASE WHEN UPPER(t.type) IN ('FEE', 'COMMISSION') THEN ABS(t.amount) ELSE 0 END), 0) AS total_fees
       FROM transactions t
       WHERE t.trade_date >= ? AND t.trade_date <= ?
         AND UPPER(t.type) IN ('DIVIDEND', 'REINVESTMENT', 'INTEREST', 'FEE', 'COMMISSION')
         ${accountFilter}`,
    )
    .get(startDate, endDate, ...accountParams) as TotalRow;

  const byAccount = db
    .prepare(
      `SELECT
         a.id AS account_id,
         a.name AS account_name,
         COALESCE(SUM(CASE WHEN UPPER(t.type) IN ('DIVIDEND', 'REINVESTMENT') THEN ABS(t.amount) ELSE 0 END), 0) AS dividends,
         COALESCE(SUM(CASE WHEN UPPER(t.type) = 'INTEREST' THEN ABS(t.amount) ELSE 0 END), 0) AS interest,
         COALESCE(SUM(CASE WHEN UPPER(t.type) IN ('FEE', 'COMMISSION') THEN ABS(t.amount) ELSE 0 END), 0) AS fees
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.trade_date >= ? AND t.trade_date <= ?
         AND UPPER(t.type) IN ('DIVIDEND', 'REINVESTMENT', 'INTEREST', 'FEE', 'COMMISSION')
         ${accountFilter}
       GROUP BY a.id, a.name
       ORDER BY (dividends + interest) DESC`,
    )
    .all(startDate, endDate, ...accountParams) as AccountRow[];

  const topPayers = db
    .prepare(
      `SELECT
         COALESCE(s.symbol, 'CASH') AS symbol,
         s.name AS security_name,
         COALESCE(SUM(CASE WHEN UPPER(t.type) IN ('DIVIDEND', 'REINVESTMENT') THEN ABS(t.amount) ELSE 0 END), 0) AS dividends,
         COALESCE(SUM(CASE WHEN UPPER(t.type) = 'INTEREST' THEN ABS(t.amount) ELSE 0 END), 0) AS interest
       FROM transactions t
       LEFT JOIN securities s ON s.id = t.security_id
       WHERE t.trade_date >= ? AND t.trade_date <= ?
         AND UPPER(t.type) IN ('DIVIDEND', 'REINVESTMENT', 'INTEREST')
         ${accountFilter}
       GROUP BY symbol, security_name
       HAVING (dividends + interest) > 0
       ORDER BY (dividends + interest) DESC
       LIMIT 10`,
    )
    .all(startDate, endDate, ...accountParams) as SymbolRow[];

  return {
    totalDividends: totals.total_dividends,
    totalInterest: totals.total_interest,
    totalFees: totals.total_fees,
    netIncome: totals.total_dividends + totals.total_interest - totals.total_fees,
    startDate,
    endDate,
    byAccount: byAccount.map((r) => ({
      accountId: r.account_id,
      accountName: r.account_name,
      dividends: r.dividends,
      interest: r.interest,
      fees: r.fees,
    })),
    topPayers: topPayers.map((r) => ({
      symbol: r.symbol,
      securityName: r.security_name,
      dividends: r.dividends,
      interest: r.interest,
    })),
  };
}

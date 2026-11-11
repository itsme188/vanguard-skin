import type Database from "better-sqlite3";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";
import {
  DIVIDEND_INCOME_SQL,
  FEES_SQL,
  INCOME_PAIRED_JOIN,
  INCOME_TYPES_SQL,
  INTEREST_EARNED_SQL,
  INTEREST_PAID_SQL,
  incomePairingCtes,
} from "@/lib/queries/income-sql";

export interface IncomeSummary {
  /** Each payout once (lib/queries/income-sql.ts, plan Contract J). */
  totalDividends: number;
  /** Interest EARNED (positive INTEREST rows only). */
  totalInterest: number;
  /** Interest CHARGED (e.g. margin interest), as a positive magnitude; a cost. */
  totalInterestPaid: number;
  totalFees: number;
  /** totalDividends + totalInterest - totalInterestPaid - totalFees. */
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
  /** Interest earned. */
  interest: number;
  /** Interest charged, positive magnitude. */
  interestPaid: number;
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
  interest_paid: number;
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
  total_interest_paid: number;
  total_fees: number;
}

/**
 * Aggregate dividend / interest / fee transactions over a date range,
 * with per-account and per-symbol breakdowns. The income rules (a
 * reinvested dividend counts once, a reversal nets, interest charged is a
 * cost) are the one copy in lib/queries/income-sql.ts, shared with the chat
 * income tool.
 */
export function getIncomeSummary(
  db: Database.Database,
  startDate: string,
  endDate: string,
  accountIds?: number[],
): IncomeSummary {
  // `undefined` is every account; a defined empty list is NO accounts,
  // never the whole book.
  const scope = accountScopeAndSql(accountIds, "t.account_id");

  const totals = db
    .prepare(
      `WITH ${incomePairingCtes()}
       SELECT
         COALESCE(SUM(${DIVIDEND_INCOME_SQL}), 0) AS total_dividends,
         COALESCE(SUM(${INTEREST_EARNED_SQL}), 0) AS total_interest,
         COALESCE(SUM(${INTEREST_PAID_SQL}), 0) AS total_interest_paid,
         COALESCE(SUM(${FEES_SQL}), 0) AS total_fees
       FROM transactions t
       ${INCOME_PAIRED_JOIN}
       WHERE t.trade_date >= ? AND t.trade_date <= ?
         AND ${INCOME_TYPES_SQL}
         ${scope.sql}`,
    )
    .get(startDate, endDate, ...scope.params) as TotalRow;

  const byAccount = db
    .prepare(
      `WITH ${incomePairingCtes()}
       SELECT
         a.id AS account_id,
         a.name AS account_name,
         COALESCE(SUM(${DIVIDEND_INCOME_SQL}), 0) AS dividends,
         COALESCE(SUM(${INTEREST_EARNED_SQL}), 0) AS interest,
         COALESCE(SUM(${INTEREST_PAID_SQL}), 0) AS interest_paid,
         COALESCE(SUM(${FEES_SQL}), 0) AS fees
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       ${INCOME_PAIRED_JOIN}
       WHERE t.trade_date >= ? AND t.trade_date <= ?
         AND ${INCOME_TYPES_SQL}
         ${scope.sql}
       GROUP BY a.id, a.name
       ORDER BY (dividends + interest) DESC`,
    )
    .all(startDate, endDate, ...scope.params) as AccountRow[];

  const topPayers = db
    .prepare(
      `WITH ${incomePairingCtes()}
       SELECT
         COALESCE(s.symbol, 'CASH') AS symbol,
         s.name AS security_name,
         COALESCE(SUM(${DIVIDEND_INCOME_SQL}), 0) AS dividends,
         COALESCE(SUM(${INTEREST_EARNED_SQL}), 0) AS interest
       FROM transactions t
       LEFT JOIN securities s ON s.id = t.security_id
       ${INCOME_PAIRED_JOIN}
       WHERE t.trade_date >= ? AND t.trade_date <= ?
         AND UPPER(t.type) IN ('DIVIDEND', 'REINVESTMENT', 'INTEREST')
         ${scope.sql}
       GROUP BY symbol, security_name
       HAVING (dividends + interest) > 0
       ORDER BY (dividends + interest) DESC
       LIMIT 10`,
    )
    .all(startDate, endDate, ...scope.params) as SymbolRow[];

  return {
    totalDividends: totals.total_dividends,
    totalInterest: totals.total_interest,
    totalInterestPaid: totals.total_interest_paid,
    totalFees: totals.total_fees,
    netIncome:
      totals.total_dividends + totals.total_interest - totals.total_interest_paid - totals.total_fees,
    startDate,
    endDate,
    byAccount: byAccount.map((r) => ({
      accountId: r.account_id,
      accountName: r.account_name,
      dividends: r.dividends,
      interest: r.interest,
      interestPaid: r.interest_paid,
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

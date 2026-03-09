/**
 * XIRR (Extended Internal Rate of Return) computation engine.
 *
 * Unlike TWR which measures portfolio manager skill (time-weighted),
 * XIRR measures the investor's actual experience (money-weighted).
 * It accounts for the timing and size of deposits/withdrawals.
 *
 * Algorithm: Newton-Raphson solver to find the discount rate r such that
 * NPV(r) = Σ CF_i / (1+r)^(t_i/365) = 0
 *
 * Convention:
 * - Deposits (money IN) are NEGATIVE cash flows (investor pays)
 * - Withdrawals (money OUT) are POSITIVE cash flows (investor receives)
 * - Final portfolio value is a POSITIVE cash flow (as if liquidated)
 */

import type Database from "better-sqlite3";

// ─── Types ──────────────────────────────────────────────────────

export interface XirrResult {
  accountId: number;
  accountName: string;
  startDate: string;
  endDate: string;
  xirr: number; // annualized rate as decimal (0.10 = 10%)
  totalInvested: number; // total deposits
  totalWithdrawn: number; // total withdrawals
  currentValue: number; // ending portfolio value
  cashFlowCount: number;
}

export interface PortfolioXirrResult {
  startDate: string;
  endDate: string;
  xirr: number;
  totalInvested: number;
  totalWithdrawn: number;
  currentValue: number;
  cashFlowCount: number;
  perAccount: XirrResult[];
}

export interface XirrOptions {
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD, defaults to latest snapshot
  accountId?: number; // if omitted, compute for all + portfolio-wide
}

// ─── Internal types ─────────────────────────────────────────────

interface CashFlow {
  date: string; // YYYY-MM-DD
  amount: number; // negative = deposit, positive = withdrawal
}

interface TransactionRow {
  trade_date: string;
  amount: number;
}

interface AccountRow {
  id: number;
  name: string;
}

// ─── Newton-Raphson Solver ──────────────────────────────────────

/**
 * Compute the Net Present Value for a set of cash flows at discount rate r.
 * NPV(r) = Σ CF_i / (1+r)^(t_i/365)
 */
function npv(cashFlows: CashFlow[], rate: number, baseDate: string): number {
  const base = new Date(baseDate + "T00:00:00Z").getTime();
  let total = 0;

  for (const cf of cashFlows) {
    const cfDate = new Date(cf.date + "T00:00:00Z").getTime();
    const years = (cfDate - base) / (365.25 * 24 * 3600 * 1000);
    total += cf.amount / Math.pow(1 + rate, years);
  }

  return total;
}

/**
 * Compute the derivative of NPV with respect to rate.
 * NPV'(r) = Σ -t_i/365 × CF_i / (1+r)^(t_i/365 + 1)
 */
function npvDerivative(
  cashFlows: CashFlow[],
  rate: number,
  baseDate: string
): number {
  const base = new Date(baseDate + "T00:00:00Z").getTime();
  let total = 0;

  for (const cf of cashFlows) {
    const cfDate = new Date(cf.date + "T00:00:00Z").getTime();
    const years = (cfDate - base) / (365.25 * 24 * 3600 * 1000);
    total += (-years * cf.amount) / Math.pow(1 + rate, years + 1);
  }

  return total;
}

const MAX_ITERATIONS = 100;
const TOLERANCE = 1e-7;

/**
 * Solve for XIRR using Newton-Raphson method.
 * Returns the annualized rate as a decimal, or null if no convergence.
 */
function solveXirr(cashFlows: CashFlow[]): number | null {
  if (cashFlows.length < 2) return null;

  // Need at least one positive and one negative cash flow
  const hasPositive = cashFlows.some((cf) => cf.amount > 0);
  const hasNegative = cashFlows.some((cf) => cf.amount < 0);
  if (!hasPositive || !hasNegative) return null;

  const baseDate = cashFlows[0].date;

  // Start with initial guess of 10%
  let rate = 0.1;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const fVal = npv(cashFlows, rate, baseDate);
    const fDeriv = npvDerivative(cashFlows, rate, baseDate);

    if (Math.abs(fDeriv) < 1e-12) {
      // Derivative too small — try a different starting point
      rate = rate > 0 ? -0.1 : 0.5;
      continue;
    }

    const newRate = rate - fVal / fDeriv;

    // Guard against divergence
    if (newRate < -0.999) {
      // Rate can't go below -100% (total loss)
      rate = -0.99;
      continue;
    }

    if (Math.abs(newRate - rate) < TOLERANCE) {
      return newRate;
    }

    rate = newRate;
  }

  // If Newton-Raphson didn't converge, try bisection as fallback
  return bisectionFallback(cashFlows, baseDate);
}

/**
 * Bisection method fallback when Newton-Raphson fails to converge.
 * Searches for rate in [-0.99, 10.0] (i.e., -99% to +1000%).
 */
function bisectionFallback(
  cashFlows: CashFlow[],
  baseDate: string
): number | null {
  let lo = -0.99;
  let hi = 10.0;

  const fLo = npv(cashFlows, lo, baseDate);
  const fHi = npv(cashFlows, hi, baseDate);

  // If same sign, no root in this interval
  if (fLo * fHi > 0) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(cashFlows, mid, baseDate);

    if (Math.abs(fMid) < TOLERANCE || (hi - lo) / 2 < TOLERANCE) {
      return mid;
    }

    if (fMid * fLo < 0) {
      hi = mid;
    } else {
      lo = mid;
      // fLo doesn't need updating since we only check sign
    }
  }

  return null;
}

// ─── Helpers ────────────────────────────────────────────────────

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00Z");
  const b = new Date(dateB + "T00:00:00Z");
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── Main Compute Function ──────────────────────────────────────

export function computeXirr(
  db: Database.Database,
  options: XirrOptions = {}
): PortfolioXirrResult | null {
  const { startDate, endDate, accountId } = options;

  // Get accounts
  let accounts: AccountRow[];
  if (accountId) {
    accounts = db
      .prepare("SELECT id, name FROM accounts WHERE id = ?")
      .all(accountId) as AccountRow[];
  } else {
    accounts = db
      .prepare("SELECT id, name FROM accounts ORDER BY id")
      .all() as AccountRow[];
  }

  if (accounts.length === 0) return null;

  // Determine date bounds from snapshots
  const boundsRow = db
    .prepare(
      `SELECT MIN(month_end_date) AS min_date, MAX(month_end_date) AS max_date
       FROM monthly_snapshots`
    )
    .get() as { min_date: string | null; max_date: string | null };

  if (!boundsRow.min_date || !boundsRow.max_date) return null;

  const effectiveEnd = endDate ?? boundsRow.max_date;

  // For start date: use the earliest external flow or snapshot date
  const effectiveStart = startDate ?? boundsRow.min_date;

  // Prepare statements
  const externalFlowStmt = db.prepare(
    `SELECT trade_date, amount
     FROM transactions
     WHERE account_id = ?
       AND is_external_flow = 1
       AND trade_date >= ? AND trade_date <= ?
     ORDER BY trade_date ASC`
  );

  const latestValueStmt = db.prepare(
    `SELECT total_value
     FROM monthly_snapshots
     WHERE account_id = ?
       AND month_end_date <= ?
     ORDER BY month_end_date DESC
     LIMIT 1`
  );

  // Also get starting value (value just before the start date)
  const startValueStmt = db.prepare(
    `SELECT total_value, month_end_date
     FROM monthly_snapshots
     WHERE account_id = ?
       AND month_end_date < ?
     ORDER BY month_end_date DESC
     LIMIT 1`
  );

  // ─── Per-account XIRR ────────────────────────────────────────

  const perAccount: XirrResult[] = [];

  for (const account of accounts) {
    const cashFlows: CashFlow[] = [];

    // Starting value as a negative cash flow (initial investment)
    const startRow = startValueStmt.get(account.id, effectiveStart) as
      | { total_value: number; month_end_date: string }
      | undefined;

    if (startRow && startRow.total_value > 0) {
      // Existing portfolio value at start = negative (as if we bought in)
      cashFlows.push({
        date: startRow.month_end_date,
        amount: -startRow.total_value,
      });
    }

    // External flows: deposits are negative (money in), withdrawals are positive (money out)
    const flows = externalFlowStmt.all(
      account.id,
      effectiveStart,
      effectiveEnd
    ) as TransactionRow[];

    let totalInvested = 0;
    let totalWithdrawn = 0;

    for (const flow of flows) {
      // In the DB, deposits are positive amounts, withdrawals are negative
      // For XIRR: deposits = money IN = negative cash flow
      cashFlows.push({
        date: flow.trade_date,
        amount: -flow.amount, // flip sign: deposit (positive DB) → negative XIRR
      });

      if (flow.amount > 0) {
        totalInvested += flow.amount;
      } else {
        totalWithdrawn += Math.abs(flow.amount);
      }
    }

    // Ending portfolio value as positive cash flow (as if we sell everything)
    const endRow = latestValueStmt.get(account.id, effectiveEnd) as
      | { total_value: number }
      | undefined;

    const currentValue = endRow?.total_value ?? 0;

    if (currentValue > 0) {
      cashFlows.push({
        date: effectiveEnd,
        amount: currentValue,
      });
    }

    // Need at least 2 cash flows to compute XIRR
    if (cashFlows.length < 2) continue;

    // If no starting value and no flows, the initial investment is implied
    // by the first deposit
    if (!startRow && cashFlows.length >= 2) {
      // First flow should be a deposit (negative)
      // This is fine — the solver handles it
    }

    const xirr = solveXirr(cashFlows);
    if (xirr === null) continue;

    perAccount.push({
      accountId: account.id,
      accountName: account.name,
      startDate: cashFlows[0].date,
      endDate: effectiveEnd,
      xirr,
      totalInvested,
      totalWithdrawn,
      currentValue,
      cashFlowCount: cashFlows.length,
    });
  }

  if (perAccount.length === 0) return null;

  // ─── Portfolio-wide XIRR ─────────────────────────────────────

  const portfolioCashFlows: CashFlow[] = [];

  // Aggregated starting value
  const aggStartRow = db
    .prepare(
      `SELECT SUM(total_value) AS total_value
       FROM monthly_snapshots
       WHERE month_end_date = (
         SELECT MAX(month_end_date)
         FROM monthly_snapshots
         WHERE month_end_date < ?
       )`
    )
    .get(effectiveStart) as { total_value: number | null } | undefined;

  const aggStartDate = db
    .prepare(
      `SELECT MAX(month_end_date) AS d
       FROM monthly_snapshots
       WHERE month_end_date < ?`
    )
    .get(effectiveStart) as { d: string | null } | undefined;

  if (aggStartRow?.total_value && aggStartRow.total_value > 0 && aggStartDate?.d) {
    portfolioCashFlows.push({
      date: aggStartDate.d,
      amount: -aggStartRow.total_value,
    });
  }

  // All external flows across all accounts
  const allFlows = db
    .prepare(
      `SELECT trade_date, SUM(amount) AS amount
       FROM transactions
       WHERE is_external_flow = 1
         AND trade_date >= ? AND trade_date <= ?
       GROUP BY trade_date
       ORDER BY trade_date ASC`
    )
    .all(effectiveStart, effectiveEnd) as TransactionRow[];

  let totalInvested = 0;
  let totalWithdrawn = 0;

  for (const flow of allFlows) {
    portfolioCashFlows.push({
      date: flow.trade_date,
      amount: -flow.amount,
    });

    if (flow.amount > 0) {
      totalInvested += flow.amount;
    } else {
      totalWithdrawn += Math.abs(flow.amount);
    }
  }

  // Ending total portfolio value
  const aggEndRow = db
    .prepare(
      `SELECT SUM(total_value) AS total_value
       FROM monthly_snapshots
       WHERE month_end_date = (
         SELECT MAX(month_end_date)
         FROM monthly_snapshots
         WHERE month_end_date <= ?
       )`
    )
    .get(effectiveEnd) as { total_value: number | null } | undefined;

  const currentValue = aggEndRow?.total_value ?? 0;

  if (currentValue > 0) {
    portfolioCashFlows.push({
      date: effectiveEnd,
      amount: currentValue,
    });
  }

  const portfolioXirr = solveXirr(portfolioCashFlows);

  return {
    startDate: portfolioCashFlows[0]?.date || effectiveStart,
    endDate: effectiveEnd,
    xirr: portfolioXirr ?? 0,
    totalInvested,
    totalWithdrawn,
    currentValue,
    cashFlowCount: portfolioCashFlows.length,
    perAccount,
  };
}

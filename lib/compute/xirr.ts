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
import { excludeLiveSnapshotsSql } from "@/lib/db/live-sources";

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

/** Pick whichever row has the more recent date (handles mixed monthly/daily sources) */
function pickMostRecent<T extends Record<string, unknown>>(
  a: T | undefined,
  b: T | undefined
): T | undefined {
  if (!a) return b;
  if (!b) return a;
  // Compare by whichever date field exists (month_end_date or value_date)
  const dateA = (a as Record<string, string>).month_end_date ?? (a as Record<string, string>).value_date;
  const dateB = (b as Record<string, string>).month_end_date ?? (b as Record<string, string>).value_date;
  return dateA >= dateB ? a : b;
}

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
       FROM monthly_snapshots
       WHERE ${excludeLiveSnapshotsSql("source")}`
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
    `SELECT total_value, month_end_date AS value_date
     FROM monthly_snapshots
     WHERE account_id = ?
       AND month_end_date <= ?
       AND ${excludeLiveSnapshotsSql("source")}
     ORDER BY month_end_date DESC
     LIMIT 1`
  );

  // Daily valuations for finer-grained custom date ranges
  const latestDailyValueStmt = db.prepare(
    `SELECT total_value, valuation_date AS value_date
     FROM daily_valuations
     WHERE account_id = ?
       AND valuation_date <= ?
     ORDER BY valuation_date DESC
     LIMIT 1`
  );

  // Also get starting value (value just before the start date)
  const startValueStmt = db.prepare(
    `SELECT total_value, month_end_date
     FROM monthly_snapshots
     WHERE account_id = ?
       AND month_end_date < ?
       AND ${excludeLiveSnapshotsSql("source")}
     ORDER BY month_end_date DESC
     LIMIT 1`
  );

  const startDailyValueStmt = db.prepare(
    `SELECT total_value, valuation_date AS month_end_date
     FROM daily_valuations
     WHERE account_id = ?
       AND valuation_date < ?
     ORDER BY valuation_date DESC
     LIMIT 1`
  );

  // ─── Per-account XIRR ────────────────────────────────────────

  const perAccount: XirrResult[] = [];

  for (const account of accounts) {
    const cashFlows: CashFlow[] = [];

    // Starting value as a negative cash flow (initial investment)
    // Pick whichever source (monthly or daily) has the most recent date
    const monthlyStart = startValueStmt.get(account.id, effectiveStart) as
      | { total_value: number; month_end_date: string } | undefined;
    const dailyStart = startDailyValueStmt.get(account.id, effectiveStart) as
      | { total_value: number; month_end_date: string } | undefined;
    const startRow = pickMostRecent(monthlyStart, dailyStart);

    if (startRow && startRow.total_value > 0) {
      // Existing portfolio value at start = negative (as if we bought in)
      cashFlows.push({
        date: startRow.month_end_date,
        amount: -startRow.total_value,
      });
    }

    // External flows: deposits are negative (money in), withdrawals are positive (money out)
    // Primary: use deposits_withdrawals from monthly_snapshots (always available)
    // Fallback: transaction-level flows (often have NULL amounts for Vanguard)
    let totalInvested = 0;
    let totalWithdrawn = 0;

    const snapshotFlows = db
      .prepare(
        `SELECT ms.month_end_date, ms.deposits_withdrawals, ms.starting_value,
                prev.total_value AS prev_total
         FROM monthly_snapshots ms
         LEFT JOIN monthly_snapshots prev
           ON prev.account_id = ms.account_id
           AND prev.month_end_date = (
             SELECT MAX(p2.month_end_date)
             FROM monthly_snapshots p2
             WHERE p2.account_id = ms.account_id
               AND p2.month_end_date < ms.month_end_date
               AND ${excludeLiveSnapshotsSql("p2.source")}
           )
         WHERE ms.account_id = ?
           AND ms.month_end_date >= ? AND ms.month_end_date <= ?
           AND ${excludeLiveSnapshotsSql("ms.source")}
           AND ms.deposits_withdrawals IS NOT NULL AND ms.deposits_withdrawals != 0
         ORDER BY ms.month_end_date ASC`
      )
      .all(account.id, effectiveStart, effectiveEnd) as {
        month_end_date: string;
        deposits_withdrawals: number;
        starting_value: number | null;
        prev_total: number | null;
      }[];

    if (snapshotFlows.length > 0) {
      for (const sf of snapshotFlows) {
        // Detect December annual summary rows
        const isAnnual =
          sf.month_end_date.slice(5, 7) === "12" &&
          sf.prev_total != null &&
          sf.starting_value != null &&
          Math.abs(sf.starting_value - sf.prev_total) >
            sf.prev_total * 0.10;

        let depositAmount = sf.deposits_withdrawals;
        if (isAnnual) {
          // Compute December-only deposits
          const year = sf.month_end_date.slice(0, 4);
          const janNovDeps = db
            .prepare(
              `SELECT COALESCE(SUM(deposits_withdrawals), 0) AS total
               FROM monthly_snapshots
               WHERE account_id = ?
                 AND month_end_date >= ? AND month_end_date < ?
                 AND ${excludeLiveSnapshotsSql("source")}`
            )
            .get(account.id, `${year}-01-01`, `${year}-12-01`) as {
            total: number;
          };
          depositAmount = sf.deposits_withdrawals - janNovDeps.total;
          if (depositAmount === 0) continue; // no December-specific deposits
        }

        const midMonth = sf.month_end_date.slice(0, 8) + "15";
        cashFlows.push({
          date: midMonth,
          amount: -depositAmount,
        });

        if (depositAmount > 0) {
          totalInvested += depositAmount;
        } else {
          totalWithdrawn += Math.abs(depositAmount);
        }
      }
    } else {
      // Fallback to transaction-level flows
      const flows = externalFlowStmt.all(
        account.id,
        effectiveStart,
        effectiveEnd
      ) as TransactionRow[];

      for (const flow of flows) {
        if (flow.amount == null) continue;
        cashFlows.push({
          date: flow.trade_date,
          amount: -flow.amount,
        });

        if (flow.amount > 0) {
          totalInvested += flow.amount;
        } else {
          totalWithdrawn += Math.abs(flow.amount);
        }
      }
    }

    // Ending portfolio value as positive cash flow (as if we sell everything)
    // Pick whichever source has the most recent date
    const monthlyEnd = latestValueStmt.get(account.id, effectiveEnd) as
      | { total_value: number; value_date: string } | undefined;
    const dailyEnd = latestDailyValueStmt.get(account.id, effectiveEnd) as
      | { total_value: number; value_date: string } | undefined;
    const endRow = pickMostRecent(monthlyEnd, dailyEnd);

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

  // ─── Single-account scope: headline IS that account's XIRR ─────
  // The portfolio-wide aggregation below intentionally sums across ALL
  // accounts (no account filter), so returning it for a scoped call would
  // show the combined portfolio number for every scope — the 2026-06-10
  // Performance MWR-headline bug.
  if (accountId && perAccount.length === 1) {
    const acct = perAccount[0];
    return {
      startDate: acct.startDate,
      endDate: acct.endDate,
      xirr: acct.xirr,
      totalInvested: acct.totalInvested,
      totalWithdrawn: acct.totalWithdrawn,
      currentValue: acct.currentValue,
      cashFlowCount: acct.cashFlowCount,
      perAccount,
    };
  }

  // ─── Portfolio-wide XIRR ─────────────────────────────────────

  const portfolioCashFlows: CashFlow[] = [];

  // Aggregated starting value — try monthly snapshots, fall back to daily valuations
  let aggStartValue: number | null = null;
  let aggStartDateStr: string | null = null;

  const monthlyAggStart = db
    .prepare(
      `SELECT SUM(total_value) AS total_value
       FROM monthly_snapshots
       WHERE month_end_date = (
         SELECT MAX(month_end_date)
         FROM monthly_snapshots
         WHERE month_end_date < ?
           AND ${excludeLiveSnapshotsSql("source")}
       )
         AND ${excludeLiveSnapshotsSql("source")}`
    )
    .get(effectiveStart) as { total_value: number | null } | undefined;

  const monthlyAggStartDate = db
    .prepare(
      `SELECT MAX(month_end_date) AS d
       FROM monthly_snapshots
       WHERE month_end_date < ?
         AND ${excludeLiveSnapshotsSql("source")}`
    )
    .get(effectiveStart) as { d: string | null } | undefined;

  if (monthlyAggStart?.total_value && monthlyAggStart.total_value > 0 && monthlyAggStartDate?.d) {
    aggStartValue = monthlyAggStart.total_value;
    aggStartDateStr = monthlyAggStartDate.d;
  } else {
    // Fallback to daily valuations
    const dailyAggStart = db
      .prepare(
        `SELECT SUM(total_value) AS total_value, valuation_date AS d
         FROM daily_valuations
         WHERE valuation_date = (
           SELECT MAX(valuation_date)
           FROM daily_valuations
           WHERE valuation_date < ?
         )`
      )
      .get(effectiveStart) as { total_value: number | null; d: string | null } | undefined;

    if (dailyAggStart?.total_value && dailyAggStart.total_value > 0 && dailyAggStart.d) {
      aggStartValue = dailyAggStart.total_value;
      aggStartDateStr = dailyAggStart.d;
    }
  }

  if (aggStartValue && aggStartValue > 0 && aggStartDateStr) {
    portfolioCashFlows.push({
      date: aggStartDateStr,
      amount: -aggStartValue,
    });
  }

  // All external flows — prefer snapshot deposits_withdrawals (always has amounts)
  // over transaction-level flows (Vanguard/Roth have NULL amounts)
  const aggSnapshotFlows = db
    .prepare(
      `SELECT month_end_date, SUM(deposits_withdrawals) AS total_deps
       FROM monthly_snapshots
       WHERE month_end_date >= ? AND month_end_date <= ?
         AND ${excludeLiveSnapshotsSql("source")}
         AND deposits_withdrawals IS NOT NULL AND deposits_withdrawals != 0
       GROUP BY month_end_date
       ORDER BY month_end_date ASC`
    )
    .all(effectiveStart, effectiveEnd) as {
      month_end_date: string;
      total_deps: number;
    }[];

  // Pre-compute December annual deposit corrections (same logic as TWR)
  const xirrDecCorrections = new Map<string, number>();
  const xirrDecSnaps = db
    .prepare(
      `SELECT ms.account_id, ms.month_end_date, ms.starting_value,
              ms.deposits_withdrawals,
              prev.total_value AS prev_total
       FROM monthly_snapshots ms
       LEFT JOIN monthly_snapshots prev
         ON prev.account_id = ms.account_id
         AND prev.month_end_date = (
           SELECT MAX(p2.month_end_date)
           FROM monthly_snapshots p2
           WHERE p2.account_id = ms.account_id
             AND p2.month_end_date < ms.month_end_date
             AND ${excludeLiveSnapshotsSql("p2.source")}
         )
       WHERE ms.month_end_date >= ? AND ms.month_end_date <= ?
         AND ${excludeLiveSnapshotsSql("ms.source")}
         AND SUBSTR(ms.month_end_date, 6, 2) = '12'
         AND ms.starting_value IS NOT NULL`
    )
    .all(effectiveStart, effectiveEnd) as {
    account_id: number;
    month_end_date: string;
    starting_value: number;
    deposits_withdrawals: number | null;
    prev_total: number | null;
  }[];

  for (const ds of xirrDecSnaps) {
    if (ds.prev_total == null || ds.deposits_withdrawals == null) continue;
    const gap = Math.abs(ds.starting_value - ds.prev_total);
    if (gap <= ds.prev_total * 0.10) continue;
    const year = ds.month_end_date.slice(0, 4);
    const janNovDeps = db
      .prepare(
        `SELECT COALESCE(SUM(deposits_withdrawals), 0) AS total
         FROM monthly_snapshots
         WHERE account_id = ?
           AND month_end_date >= ? AND month_end_date < ?
           AND ${excludeLiveSnapshotsSql("source")}`
      )
      .get(ds.account_id, `${year}-01-01`, `${year}-12-01`) as {
      total: number;
    };
    const decOnlyDeposits = ds.deposits_withdrawals - janNovDeps.total;
    const correction = ds.deposits_withdrawals - decOnlyDeposits;
    const existing = xirrDecCorrections.get(ds.month_end_date) ?? 0;
    xirrDecCorrections.set(ds.month_end_date, existing + correction);
  }

  let totalInvested = 0;
  let totalWithdrawn = 0;

  for (const sf of aggSnapshotFlows) {
    const correction = xirrDecCorrections.get(sf.month_end_date) ?? 0;
    const effectiveDeps = sf.total_deps - correction;
    if (effectiveDeps === 0) continue;

    const midMonth = sf.month_end_date.slice(0, 8) + "15";
    portfolioCashFlows.push({
      date: midMonth,
      amount: -effectiveDeps,
    });

    if (effectiveDeps > 0) {
      totalInvested += effectiveDeps;
    } else {
      totalWithdrawn += Math.abs(effectiveDeps);
    }
  }

  // Ending total portfolio value — try monthly snapshots, fall back to daily valuations
  let currentValue = 0;

  const aggEndRow = db
    .prepare(
      `SELECT SUM(total_value) AS total_value
       FROM monthly_snapshots
       WHERE month_end_date = (
         SELECT MAX(month_end_date)
         FROM monthly_snapshots
         WHERE month_end_date <= ?
           AND ${excludeLiveSnapshotsSql("source")}
       )
         AND ${excludeLiveSnapshotsSql("source")}`
    )
    .get(effectiveEnd) as { total_value: number | null } | undefined;

  if (aggEndRow?.total_value && aggEndRow.total_value > 0) {
    currentValue = aggEndRow.total_value;
  } else {
    const dailyAggEnd = db
      .prepare(
        `SELECT SUM(total_value) AS total_value
         FROM daily_valuations
         WHERE valuation_date = (
           SELECT MAX(valuation_date)
           FROM daily_valuations
           WHERE valuation_date <= ?
         )`
      )
      .get(effectiveEnd) as { total_value: number | null } | undefined;

    currentValue = dailyAggEnd?.total_value ?? 0;
  }

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

import type Database from "better-sqlite3";
import { excludeLiveSnapshotsSql } from "@/lib/db/live-sources";

// ─── Types ──────────────────────────────────────────────────────────

export interface TwrResult {
  accountId: number;
  accountName: string;
  startDate: string;
  endDate: string;
  totalReturn: number; // decimal, e.g. 0.123 = 12.3%
  annualizedReturn: number | null; // null if period too short (<30 days)
  totalDays: number;
  monthsIncluded: number;
  isPartial: boolean; // true if some months had to be skipped
}

export interface PortfolioTwrResult {
  startDate: string;
  endDate: string;
  totalReturn: number;
  annualizedReturn: number | null;
  totalDays: number;
  perAccount: TwrResult[];
}

export interface TwrOptions {
  startDate?: string; // YYYY-MM-DD, defaults to earliest snapshot
  endDate?: string; // YYYY-MM-DD, defaults to latest snapshot
  accountId?: number; // if omitted, compute for all + portfolio-wide
}

// ─── Internal types ─────────────────────────────────────────────────

interface SnapshotRow {
  account_id: number;
  month_end_date: string;
  total_value: number;
  starting_value: number | null;
  twr: number | null;
  deposits_withdrawals: number | null;
  source: string;
}

interface CashFlowRow {
  trade_date: string;
  amount: number;
}

interface AccountRow {
  id: number;
  name: string;
}

interface AggregatedSnapshotRow {
  month_end_date: string;
  total_value: number;
  total_deposits_withdrawals: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00Z");
  const b = new Date(dateB + "T00:00:00Z");
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function daysInMonth(monthEndDate: string): number {
  // monthEndDate is always the last day of the month (YYYY-MM-DD)
  const d = new Date(monthEndDate + "T00:00:00Z");
  return d.getUTCDate(); // last day of month = number of days in that month
}

function monthStartDate(monthEndDate: string): string {
  // Given "2025-01-31", return "2025-01-01"
  return monthEndDate.slice(0, 8) + "01";
}

function annualize(
  totalReturn: number,
  totalDays: number
): number | null {
  if (totalDays < 30) return null; // too short to annualize meaningfully
  return Math.pow(1 + totalReturn, 365.25 / totalDays) - 1;
}

/**
 * Compute Modified Dietz return for a single sub-period.
 *
 * r = (V_end - V_start - CF) / (V_start + Σ(CF_i × W_i))
 *
 * Where W_i = days_remaining / total_days for each cash flow.
 */
function modifiedDietzReturn(
  vStart: number,
  vEnd: number,
  cashFlows: { amount: number; weight: number }[]
): number | null {
  const totalCF = cashFlows.reduce((sum, f) => sum + f.amount, 0);
  const weightedCF = cashFlows.reduce(
    (sum, f) => sum + f.amount * f.weight,
    0
  );
  const denominator = vStart + weightedCF;

  // Can't compute if denominator is zero or near-zero
  if (Math.abs(denominator) < 0.01) return null;

  return (vEnd - vStart - totalCF) / denominator;
}

// ─── Main compute function ──────────────────────────────────────────

export function computeTwr(
  db: Database.Database,
  options: TwrOptions = {}
): PortfolioTwrResult | null {
  const { startDate, endDate, accountId } = options;

  // Get accounts to process
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

  // Determine date bounds
  const boundsRow = db
    .prepare(
      `SELECT MIN(month_end_date) AS min_date, MAX(month_end_date) AS max_date
       FROM monthly_snapshots
       WHERE ${excludeLiveSnapshotsSql("source")}`
    )
    .get() as { min_date: string | null; max_date: string | null };

  if (!boundsRow.min_date || !boundsRow.max_date) return null;

  const effectiveStart = startDate ?? boundsRow.min_date;
  const effectiveEnd = endDate ?? boundsRow.max_date;

  // Prepare statements
  const snapshotStmt = db.prepare(
    `SELECT account_id, month_end_date, total_value, starting_value, twr, deposits_withdrawals, source
     FROM monthly_snapshots
     WHERE account_id = ?
       AND month_end_date >= ? AND month_end_date <= ?
       AND ${excludeLiveSnapshotsSql("source")}
     ORDER BY month_end_date ASC`
  );

  const cashFlowStmt = db.prepare(
    `SELECT trade_date, amount
     FROM transactions
     WHERE account_id = ?
       AND is_external_flow = 1
       AND trade_date >= ? AND trade_date <= ?
     ORDER BY trade_date ASC`
  );

  // Also get the snapshot just before our range for V_start of first month
  const priorSnapshotStmt = db.prepare(
    `SELECT total_value
     FROM monthly_snapshots
     WHERE account_id = ?
       AND month_end_date < ?
       AND ${excludeLiveSnapshotsSql("source")}
     ORDER BY month_end_date DESC
     LIMIT 1`
  );

  // ─── Per-account TWR ───────────────────────────────────────────

  const perAccount: TwrResult[] = [];

  for (const account of accounts) {
    const snapshots = snapshotStmt.all(
      account.id,
      effectiveStart,
      effectiveEnd
    ) as SnapshotRow[];

    if (snapshots.length === 0) continue;

    // Get prior snapshot for V_start of first month
    const priorRow = priorSnapshotStmt.get(account.id, effectiveStart) as
      | { total_value: number }
      | undefined;

    const subPeriodReturns: number[] = [];
    let isPartial = false;

    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i];

      // Detect December annual summary rows.
      // These have starting_value = year-start (not prior month) and
      // twr = annual TWR (not monthly). They must not be used directly.
      const priorMonthTotal =
        i > 0 ? snapshots[i - 1].total_value : priorRow?.total_value;
      const isAnnualSummary =
        snap.month_end_date.slice(5, 7) === "12" &&
        priorMonthTotal != null &&
        snap.starting_value != null &&
        Math.abs(snap.starting_value - priorMonthTotal) >
          priorMonthTotal * 0.10;

      // Use pre-computed TWR if available and NOT an annual summary
      if (snap.twr !== null && !isAnnualSummary) {
        if (snap.source === 'ibkr-activity') {
          // IBKR stores TWR as percentage (e.g. 14.545 = 14.545%)
          subPeriodReturns.push(snap.twr / 100);
        } else {
          // Canonical and other sources store TWR as decimal (e.g. -0.109699 = -10.97%)
          subPeriodReturns.push(snap.twr);
        }
        continue;
      }

      // Compute Modified Dietz for this month
      // Always prefer prior month's total_value as vStart (avoids annual starting_value)
      let vStart: number | null = null;

      if (i > 0) {
        vStart = snapshots[i - 1].total_value;
      } else if (priorRow) {
        vStart = priorRow.total_value;
      } else if (snap.starting_value !== null && !isAnnualSummary) {
        // Only use starting_value as last resort for non-annual rows
        vStart = snap.starting_value;
      }

      if (vStart === null || vStart === 0) {
        // Can't compute this period — mark as partial
        isPartial = true;
        continue;
      }

      const vEnd = snap.total_value;
      const mStart = monthStartDate(snap.month_end_date);
      const mEnd = snap.month_end_date;
      const totalDaysInMonth = daysInMonth(snap.month_end_date);

      // Get external cash flows for this month
      // Prefer deposits_withdrawals from snapshot (always available)
      // over transaction-level flows (often have NULL amounts)
      let weightedFlows: { amount: number; weight: number }[];

      if (isAnnualSummary && snap.deposits_withdrawals != null) {
        // December annual row: deposits_withdrawals is cumulative for the year.
        // Compute December-only deposits by subtracting Jan-Nov.
        const year = snap.month_end_date.slice(0, 4);
        const janNovDeps = db
          .prepare(
            `SELECT COALESCE(SUM(deposits_withdrawals), 0) AS total
             FROM monthly_snapshots
             WHERE account_id = ?
               AND month_end_date >= ? AND month_end_date < ?
               AND ${excludeLiveSnapshotsSql("source")}`
          )
          .get(snap.account_id, `${year}-01-01`, `${year}-12-01`) as {
          total: number;
        };
        const decemberDeposits =
          snap.deposits_withdrawals - janNovDeps.total;
        weightedFlows =
          decemberDeposits !== 0
            ? [{ amount: decemberDeposits, weight: 0.5 }]
            : [];
      } else if (snap.deposits_withdrawals != null && snap.deposits_withdrawals !== 0) {
        // Single mid-month flow approximation (weight = 0.5)
        weightedFlows = [{ amount: snap.deposits_withdrawals, weight: 0.5 }];
      } else {
        // Fall back to transaction-level flows
        const flows = cashFlowStmt.all(
          account.id,
          mStart,
          mEnd
        ) as CashFlowRow[];

        weightedFlows = flows
          .filter((f) => f.amount != null)
          .map((f) => {
            const daysRemaining = daysBetween(f.trade_date, mEnd);
            const weight =
              totalDaysInMonth > 0 ? daysRemaining / totalDaysInMonth : 0;
            return { amount: f.amount, weight };
          });
      }

      const r = modifiedDietzReturn(vStart, vEnd, weightedFlows);
      if (r === null) {
        isPartial = true;
        continue;
      }

      subPeriodReturns.push(r);
    }

    if (subPeriodReturns.length === 0) continue;

    // Chain-link: TWR = Π(1 + r_i) - 1
    const totalReturn =
      subPeriodReturns.reduce((prod, r) => prod * (1 + r), 1) - 1;

    const firstDate =
      snapshots[0].month_end_date;
    const lastDate = snapshots[snapshots.length - 1].month_end_date;
    const totalDays = daysBetween(
      priorRow ? monthStartDate(firstDate) : firstDate,
      lastDate
    );

    perAccount.push({
      accountId: account.id,
      accountName: account.name,
      startDate: firstDate,
      endDate: lastDate,
      totalReturn,
      annualizedReturn: annualize(totalReturn, totalDays),
      totalDays,
      monthsIncluded: subPeriodReturns.length,
      isPartial,
    });
  }

  if (perAccount.length === 0) return null;

  // ─── Single-account scope: headline IS that account's chained TWR ──
  // The portfolio-wide aggregation below intentionally sums across ALL
  // accounts (it has no account filter), so returning it for a scoped call
  // would silently show the combined portfolio number for every scope —
  // exactly the 2026-06-10 Performance-headline bug. The per-account path is
  // also the more accurate one for a single account: it uses the statement's
  // pre-computed monthly TWR (percent/decimal source-aware) instead of a
  // Modified Dietz approximation.
  if (accountId && perAccount.length === 1) {
    const acct = perAccount[0];
    return {
      startDate: acct.startDate,
      endDate: acct.endDate,
      totalReturn: acct.totalReturn,
      annualizedReturn: acct.annualizedReturn,
      totalDays: acct.totalDays,
      perAccount,
    };
  }

  // ─── Portfolio-wide TWR ────────────────────────────────────────

  // Aggregate snapshots across accounts per month
  const aggSnapshots = db
    .prepare(
      `SELECT month_end_date,
              SUM(total_value) AS total_value,
              SUM(COALESCE(deposits_withdrawals, 0)) AS total_deposits_withdrawals
       FROM monthly_snapshots
       WHERE month_end_date >= ? AND month_end_date <= ?
         AND ${excludeLiveSnapshotsSql("source")}
       GROUP BY month_end_date
       ORDER BY month_end_date ASC`
    )
    .all(effectiveStart, effectiveEnd) as AggregatedSnapshotRow[];

  // Get aggregated prior snapshot
  const aggPriorRow = db
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

  // All external flows across all accounts for the range
  const allFlowStmt = db.prepare(
    `SELECT trade_date, SUM(amount) AS amount
     FROM transactions
     WHERE is_external_flow = 1
       AND trade_date >= ? AND trade_date <= ?
     GROUP BY trade_date
     ORDER BY trade_date ASC`
  );

  // Pre-compute December annual deposit corrections.
  // Some December rows have cumulative annual deposits_withdrawals instead of monthly.
  // The aggregated SUM includes these inflated values, so we correct them here.
  const decemberCorrections = new Map<string, number>(); // month_end_date → correction amount

  const decemberSnaps = db
    .prepare(
      `SELECT ms.account_id, ms.month_end_date, ms.starting_value, ms.total_value,
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
    total_value: number;
    deposits_withdrawals: number | null;
    prev_total: number | null;
  }[];

  for (const ds of decemberSnaps) {
    if (ds.prev_total == null || ds.deposits_withdrawals == null) continue;
    const gap = Math.abs(ds.starting_value - ds.prev_total);
    if (gap <= ds.prev_total * 0.10) continue; // not annual

    // This is an annual summary row — compute correction
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
    // Correction = what was in the aggregate - what should be (December only)
    const decOnlyDeposits = ds.deposits_withdrawals - janNovDeps.total;
    const correction = ds.deposits_withdrawals - decOnlyDeposits;
    const existing = decemberCorrections.get(ds.month_end_date) ?? 0;
    decemberCorrections.set(ds.month_end_date, existing + correction);
  }

  const portfolioReturns: number[] = [];
  let portfolioPartial = false;

  for (let i = 0; i < aggSnapshots.length; i++) {
    const snap = aggSnapshots[i];

    let vStart: number | null = null;
    if (i > 0) {
      vStart = aggSnapshots[i - 1].total_value;
    } else if (aggPriorRow?.total_value) {
      vStart = aggPriorRow.total_value;
    }

    if (vStart === null || vStart === 0) {
      portfolioPartial = true;
      continue;
    }

    const vEnd = snap.total_value;

    // Use aggregated deposits_withdrawals, corrected for December annual rows
    const correction = decemberCorrections.get(snap.month_end_date) ?? 0;
    const effectiveDeposits = snap.total_deposits_withdrawals - correction;

    let weightedFlows: { amount: number; weight: number }[];

    if (effectiveDeposits !== 0) {
      weightedFlows = [{ amount: effectiveDeposits, weight: 0.5 }];
    } else {
      const mStart = monthStartDate(snap.month_end_date);
      const mEnd = snap.month_end_date;
      const totalDaysInMonth = daysInMonth(snap.month_end_date);
      const flows = allFlowStmt.all(mStart, mEnd) as CashFlowRow[];
      weightedFlows = flows
        .filter((f) => f.amount != null)
        .map((f) => {
          const daysRemaining = daysBetween(f.trade_date, mEnd);
          const weight =
            totalDaysInMonth > 0 ? daysRemaining / totalDaysInMonth : 0;
          return { amount: f.amount, weight };
        });
    }

    const r = modifiedDietzReturn(vStart, vEnd, weightedFlows);
    if (r === null) {
      portfolioPartial = true;
      continue;
    }

    portfolioReturns.push(r);
  }

  // Portfolio chain-link
  const portfolioTotalReturn =
    portfolioReturns.length > 0
      ? portfolioReturns.reduce((prod, r) => prod * (1 + r), 1) - 1
      : 0;

  const portfolioFirstDate =
    aggSnapshots.length > 0 ? aggSnapshots[0].month_end_date : effectiveStart;
  const portfolioLastDate =
    aggSnapshots.length > 0
      ? aggSnapshots[aggSnapshots.length - 1].month_end_date
      : effectiveEnd;
  const portfolioTotalDays = daysBetween(
    aggPriorRow?.total_value
      ? monthStartDate(portfolioFirstDate)
      : portfolioFirstDate,
    portfolioLastDate
  );

  return {
    startDate: portfolioFirstDate,
    endDate: portfolioLastDate,
    totalReturn: portfolioTotalReturn,
    annualizedReturn: annualize(portfolioTotalReturn, portfolioTotalDays),
    totalDays: portfolioTotalDays,
    perAccount,
  };
}

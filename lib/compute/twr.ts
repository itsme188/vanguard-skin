import type Database from "better-sqlite3";

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
       FROM monthly_snapshots`
    )
    .get() as { min_date: string | null; max_date: string | null };

  if (!boundsRow.min_date || !boundsRow.max_date) return null;

  const effectiveStart = startDate ?? boundsRow.min_date;
  const effectiveEnd = endDate ?? boundsRow.max_date;

  // Prepare statements
  const snapshotStmt = db.prepare(
    `SELECT account_id, month_end_date, total_value, starting_value, twr, deposits_withdrawals
     FROM monthly_snapshots
     WHERE account_id = ?
       AND month_end_date >= ? AND month_end_date <= ?
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

      // Use IBKR-provided TWR if available
      if (snap.twr !== null) {
        // IBKR stores TWR as percentage (e.g. 14.545 = 14.545%)
        subPeriodReturns.push(snap.twr / 100);
        continue;
      }

      // Compute Modified Dietz for this month
      let vStart: number | null = null;

      if (snap.starting_value !== null) {
        // Use IBKR's starting_value if populated
        vStart = snap.starting_value;
      } else if (i > 0) {
        // Use previous month's ending value
        vStart = snapshots[i - 1].total_value;
      } else if (priorRow) {
        // Use prior-to-range snapshot
        vStart = priorRow.total_value;
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
      const flows = cashFlowStmt.all(
        account.id,
        mStart,
        mEnd
      ) as CashFlowRow[];

      const weightedFlows = flows.map((f) => {
        const daysRemaining = daysBetween(f.trade_date, mEnd);
        const weight =
          totalDaysInMonth > 0 ? daysRemaining / totalDaysInMonth : 0;
        return { amount: f.amount, weight };
      });

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

  // ─── Portfolio-wide TWR ────────────────────────────────────────

  // Aggregate snapshots across accounts per month
  const aggSnapshots = db
    .prepare(
      `SELECT month_end_date,
              SUM(total_value) AS total_value,
              SUM(COALESCE(deposits_withdrawals, 0)) AS total_deposits_withdrawals
       FROM monthly_snapshots
       WHERE month_end_date >= ? AND month_end_date <= ?
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
       )`
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
    const mStart = monthStartDate(snap.month_end_date);
    const mEnd = snap.month_end_date;
    const totalDaysInMonth = daysInMonth(snap.month_end_date);

    const flows = allFlowStmt.all(mStart, mEnd) as CashFlowRow[];

    const weightedFlows = flows.map((f) => {
      const daysRemaining = daysBetween(f.trade_date, mEnd);
      const weight =
        totalDaysInMonth > 0 ? daysRemaining / totalDaysInMonth : 0;
      return { amount: f.amount, weight };
    });

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

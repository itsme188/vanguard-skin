import type Database from "better-sqlite3";
import { excludeLiveSnapshotsSql } from "@/lib/db/live-sources";
import { addDays } from "@/lib/calendar/date-utils";
import {
  SIGNED_EXTERNAL_FLOW_SQL,
  IN_KIND_LEG_SQL,
  fetchInKindFlowsByDate,
} from "@/lib/compute/flow-adjusted";
import { isAnnualSummaryRow, snapshotTwrFraction } from "@/lib/compute/monthly-snapshot-utils";
import {
  SNAPSHOT_FIRSTS_CTE,
  EXPECTED_ACCOUNTS_SQL,
} from "@/lib/compute/snapshot-coverage";

// ─── Types ──────────────────────────────────────────────────────────

export interface TwrResult {
  accountId: number;
  accountName: string;
  /** First snapshot INSIDE the requested window. Not the date the return
   *  chain opens on — see `measurementStartDate`, which is what any surface
   *  showing a window beside an annualized figure must use. */
  startDate: string;
  /** The date the chained return actually OPENS on: the anchor behind the
   *  first sub-period that made it into the chain. Usually EARLIER than
   *  `startDate` — a bounded window (YTD/6M/1Y/…) chains its first month
   *  off the prior month-end close, so the return covers ~30 days that
   *  `startDate` never shows.
   *
   *  `measurementStartDate → endDate` spans exactly `totalDays`, and that is
   *  the window `totalReturn` and `annualizedReturn` describe. Report all
   *  four together or none of them: showing `startDate` next to
   *  `annualizedReturn` is the 2026-09-02 QA defect (card said 181 days,
   *  the annualized figure implied 211). */
  measurementStartDate: string;
  endDate: string;
  totalReturn: number; // decimal, e.g. 0.123 = 12.3%
  annualizedReturn: number | null; // null if period too short (<30 days)
  /** `measurementStartDate → endDate` in days — the window `totalReturn`
   *  was actually earned over, and the only correct annualization
   *  denominator: feeding a shorter one into `annualize()` inflates the
   *  headline figure (2026-08-31 regression, ~15.6% reported for a true
   *  ~12.8%). */
  totalDays: number;
  monthsIncluded: number;
  isPartial: boolean; // true if some months had to be skipped
}

export interface PortfolioTwrResult {
  /** First snapshot inside the window — see TwrResult.startDate. */
  startDate: string;
  /** Where the chained return opens — see TwrResult.measurementStartDate. */
  measurementStartDate: string;
  endDate: string;
  totalReturn: number;
  annualizedReturn: number | null;
  /** measurementStartDate → endDate — see TwrResult.totalDays. */
  totalDays: number;
  perAccount: TwrResult[];
  isPartial: boolean; // true if some months had to be skipped from the chain (mirrors TwrResult.isPartial)
}

export interface TwrOptions {
  startDate?: string; // YYYY-MM-DD, defaults to earliest snapshot
  endDate?: string; // YYYY-MM-DD, defaults to latest snapshot
  accountId?: number; // if omitted, compute for all + portfolio-wide
  // Multi-account scope (e.g. a named scope that resolves to 2+ accounts).
  // A single-id array behaves identically to `accountId`. Ignored when
  // `accountId` is also given. Never collapse a multi-id scope to one id —
  // that silently drops accounts from the aggregate (the first-id helper
  // that did so has been deleted).
  accountIds?: number[];
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
  present_accounts: number;
  expected_accounts: number;
}

/** AggregatedSnapshotRow that survived the full-coverage filter, carrying
 *  any skipped months' deposits forward so Dietz flows aren't lost.
 *  carried_inkind carries skipped months' in-kind transfer FMV the same way
 *  (spec §6.5 — a donation/journal leg in a statement-lag month must not
 *  vanish just because that month got dropped from the aggregate). */
interface CoveredSnapshotRow extends AggregatedSnapshotRow {
  carried_deposits: number;
  carried_inkind: number;
  /** Month-ends of the skipped months whose flows rode into this row's
   *  carried_deposits / carried_inkind (read by aggregateGapFlows). */
  carried_months: string[];
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

/** The calendar day before monthStart (its month's own last day), e.g.
 *  "2025-01-01" → "2024-12-31". Used to pass an inclusive month-start bound
 *  through fetchInKindFlowsByDate's half-open (startDate, endDate] window
 *  without changing which rows match — `date > dayBefore(x)` is equivalent
 *  to `date >= x` for day-granularity ISO date strings. */
function dayBeforeMonthStart(monthStart: string): string {
  const d = new Date(monthStart + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The calendar day after `iso`. */
function nextDay(iso: string): string {
  return addDays(iso, 1);
}

/**
 * GAP PERIODS (2026-11-24). A Modified Dietz month whose opening value is
 * dated before the day before the month's start opens across one or more
 * months with no statement: the value change covers the whole span
 * (vStartDate, mEnd], so it is measured as ONE Dietz period over that span.
 * Returns the span's opening date, or null when the month opens on the
 * previous month-end (the normal case, which this never touches).
 *
 * Inside a gap period:
 *  - the month's OWN flows are read exactly as for any month (snapshot
 *    figure at weight 0.5, else the ledger), except that a dated flow's
 *    weight is its days remaining over the SPAN's days, not the month's;
 *  - flows dated inside the missing months come from the ledger (cash and
 *    in-kind legs alike: the cash-flow statements carry no type filter),
 *    day-weighted over the span. In the aggregate chain a ledger row is left
 *    out when it is already inside carriedDeposits / carried_inkind (see
 *    aggregateGapFlows), so no flow is counted twice;
 *  - the result is flagged partial (a month had no statement).
 * Before this, only the month's own flows were read and a deposit dated in
 * a missing month read as investment gain.
 */
function gapOpening(vStartDate: string | null, mStart: string): string | null {
  return vStartDate !== null && vStartDate < dayBeforeMonthStart(mStart) ? vStartDate : null;
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

  // Can't compute if the average capital is zero, near zero or NEGATIVE
  // (review 2026-11-24: a large withdrawal weighted over a gap span drove it
  // below zero and printed a return under -100%). The caller drops the
  // period and marks the result partial.
  if (denominator < 0.01) return null;

  return (vEnd - vStart - totalCF) / denominator;
}

// ─── Main compute function ──────────────────────────────────────────

export function computeTwr(
  db: Database.Database,
  options: TwrOptions = {}
): PortfolioTwrResult | null {
  const { startDate, endDate, accountId, accountIds } = options;

  // A single-id accountIds array behaves exactly like accountId (§2 of the
  // task brief). accountId wins if both happen to be given.
  const singleAccountId: number | undefined =
    accountId ?? (accountIds && accountIds.length === 1 ? accountIds[0] : undefined);
  // A 2+-id accountIds array scopes the whole aggregate path (snapshot +
  // flow queries, expected_accounts) to just those accounts.
  const scopeIds: number[] | undefined =
    !singleAccountId && accountIds && accountIds.length > 1 ? accountIds : undefined;
  // An explicitly empty accountIds array is a real "zero accounts in
  // scope" signal — it must NEVER widen to the unscoped/all-accounts path.
  // A caller that resolved a named scope to no accounts (e.g. resolveScope
  // returning []) wants "no data for this scope," not "show me the whole
  // portfolio." Mirrors the existing accounts.length === 0 → null result
  // just below (same shape as "no data").
  const emptyScope =
    !singleAccountId && accountIds !== undefined && accountIds.length === 0;

  // Get accounts to process
  let accounts: AccountRow[];
  if (emptyScope) {
    accounts = [];
  } else if (singleAccountId) {
    accounts = db
      .prepare("SELECT id, name FROM accounts WHERE id = ?")
      .all(singleAccountId) as AccountRow[];
  } else if (scopeIds) {
    const placeholders = scopeIds.map(() => "?").join(",");
    accounts = db
      .prepare(`SELECT id, name FROM accounts WHERE id IN (${placeholders}) ORDER BY id`)
      .all(...scopeIds) as AccountRow[];
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
    `SELECT trade_date, ${SIGNED_EXTERNAL_FLOW_SQL} AS amount
     FROM transactions
     WHERE account_id = ?
       AND is_external_flow = 1
       AND trade_date >= ? AND trade_date <= ?
     ORDER BY trade_date ASC`
  );

  // Also get the snapshot just before our range for V_start of first month.
  // month_end_date comes back too: when this row anchors the chain it is the
  // date the measured period actually OPENS on (see totalDays).
  const priorSnapshotStmt = db.prepare(
    `SELECT month_end_date, total_value
     FROM monthly_snapshots
     WHERE account_id = ?
       AND month_end_date < ?
       AND ${excludeLiveSnapshotsSql("source")}
     ORDER BY month_end_date DESC
     LIMIT 1`
  );

  // ─── Per-account TWR ───────────────────────────────────────────

  // Appends day-weighted in-kind transfer rows (weight = daysRemaining /
  // totalDaysInMonth, matching the transaction-fallback branch's own
  // per-flow weighting) to an existing weightedFlows array. Called ONLY
  // from the two snapshot-preferred branches below — never from the
  // fallback branch, which already includes these rows unfiltered.
  //
  // Uses the shared fetchInKindFlowsByDate primitive (flow-adjusted.ts),
  // which is half-open (startDate, endDate]; dayBeforeMonthStart(mStart)
  // preserves the original inclusive->=mStart bound exactly.
  function appendInKindFlows(
    accountId: number,
    mStart: string,
    mEnd: string,
    totalDaysInMonth: number,
    weightedFlows: { amount: number; weight: number }[]
  ): void {
    const inKindRows = fetchInKindFlowsByDate(
      db,
      [accountId],
      dayBeforeMonthStart(mStart),
      mEnd
    );
    for (const row of inKindRows) {
      const daysRemaining = daysBetween(row.date, mEnd);
      const weight = totalDaysInMonth > 0 ? daysRemaining / totalDaysInMonth : 0;
      weightedFlows.push({ amount: row.net, weight });
    }
  }

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
      | { month_end_date: string; total_value: number }
      | undefined;

    const subPeriodReturns: number[] = [];
    let isPartial = false;
    // Date the FIRST sub-period that made it into the chain opens on — the
    // start of the window `totalReturn` is actually measured over. Stays
    // null until a sub-period is pushed, because leading months can be
    // skipped (no usable V_start), which moves the real opening later.
    let measurementStart: string | null = null;

    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i];

      // Detect December annual summary rows.
      // These have starting_value = year-start (not prior month) and
      // twr = annual TWR (not monthly). They must not be used directly.
      const priorMonthTotal =
        i > 0 ? snapshots[i - 1].total_value : priorRow?.total_value;
      const isAnnualSummary = isAnnualSummaryRow(
        snap,
        priorMonthTotal ?? null
      );

      // Use pre-computed TWR if available and NOT an annual summary
      if (snap.twr !== null && !isAnnualSummary) {
        // A month inside the window with no stored return (no statement at
        // all) is silently missing from the chain: say so. The figure is
        // unchanged. For the first row only a missing month on or after the
        // window start counts (an older hole is outside the window).
        const prevAnchor = i > 0 ? snapshots[i - 1].month_end_date : priorRow?.month_end_date;
        const lastMissing = dayBeforeMonthStart(monthStartDate(snap.month_end_date));
        if (prevAnchor !== undefined && prevAnchor < lastMissing && (i > 0 || lastMissing >= effectiveStart)) {
          isPartial = true;
        }
        // A stored monthly TWR covers its whole calendar month, so this
        // sub-period opens on that month's first day.
        measurementStart ??= monthStartDate(snap.month_end_date);
        // The stored column is mixed-unit (ibkr-activity writes a percent,
        // every other source a fraction); the one reader normalises it.
        subPeriodReturns.push(snapshotTwrFraction(snap) as number);
        continue;
      }

      // Compute Modified Dietz for this month
      // Always prefer prior month's total_value as vStart (avoids annual starting_value)
      let vStart: number | null = null;
      // The date vStart is valued AS OF — i.e. where this sub-period opens.
      let vStartDate: string | null = null;

      if (i > 0) {
        vStart = snapshots[i - 1].total_value;
        vStartDate = snapshots[i - 1].month_end_date;
      } else if (priorRow) {
        vStart = priorRow.total_value;
        vStartDate = priorRow.month_end_date;
      } else if (snap.starting_value !== null && !isAnnualSummary) {
        // Only use starting_value as last resort for non-annual rows
        vStart = snap.starting_value;
        // starting_value is the month's opening balance.
        vStartDate = monthStartDate(snap.month_end_date);
      }

      if (vStart === null || vStart === 0) {
        // Can't compute this period — mark as partial
        isPartial = true;
        continue;
      }

      const vEnd = snap.total_value;
      const mStart = monthStartDate(snap.month_end_date);
      const mEnd = snap.month_end_date;
      // A gap period (see gapOpening) weights dated flows over the whole
      // span; every other month keeps its own day count, byte for byte.
      const gapStart = gapOpening(vStartDate, mStart);
      const totalDaysInMonth = gapStart !== null ? daysBetween(gapStart, mEnd) : daysInMonth(snap.month_end_date);

      // Get external cash flows for this month
      // Prefer deposits_withdrawals from snapshot (always available)
      // over transaction-level flows (often have NULL amounts)
      let weightedFlows: { amount: number; weight: number }[];
      // A gap ending on a December ANNUAL row: the row's cumulative figure
      // minus the Jan-Nov statements still holds every missing month's
      // deposits, which the gap block would read again from the ledger. So
      // the whole span's flows come from the ledger alone (cash and in-kind,
      // dated, over the span) and the cumulative residual is not used.
      const annualAcrossGap = gapStart !== null && isAnnualSummary;

      if (annualAcrossGap) {
        weightedFlows = (cashFlowStmt.all(account.id, nextDay(gapStart), mEnd) as CashFlowRow[])
          .filter((f) => f.amount != null)
          .map((f) => ({ amount: f.amount, weight: daysBetween(f.trade_date, mEnd) / totalDaysInMonth }));
      } else if (isAnnualSummary && snap.deposits_withdrawals != null) {
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
        // Union in this December's in-kind transfer legs (spec §6.5) — the
        // snapshot's cumulative deposits_withdrawals never carries them.
        appendInKindFlows(account.id, mStart, mEnd, totalDaysInMonth, weightedFlows);
      } else if (snap.deposits_withdrawals != null && snap.deposits_withdrawals !== 0) {
        // Single mid-month flow approximation (weight = 0.5)
        weightedFlows = [{ amount: snap.deposits_withdrawals, weight: 0.5 }];
        // Union in this month's in-kind transfer legs (spec §6.5) — the
        // snapshot's cash deposits_withdrawals never carries them.
        appendInKindFlows(account.id, mStart, mEnd, totalDaysInMonth, weightedFlows);
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

      if (gapStart !== null) isPartial = true;
      if (gapStart !== null && !annualAcrossGap) {
        // Flows dated inside the missing months: no snapshot of this account
        // exists for them, so only the ledger knows them. cashFlowStmt has no
        // type filter, so in-kind legs come with it (never added twice).
        const gapFlows = cashFlowStmt.all(
          account.id,
          nextDay(gapStart),
          dayBeforeMonthStart(mStart)
        ) as CashFlowRow[];
        for (const f of gapFlows) {
          if (f.amount == null) continue;
          weightedFlows.push({ amount: f.amount, weight: daysBetween(f.trade_date, mEnd) / totalDaysInMonth });
        }
      }

      const r = modifiedDietzReturn(vStart, vEnd, weightedFlows);
      if (r === null) {
        isPartial = true;
        continue;
      }

      measurementStart ??= vStartDate;
      subPeriodReturns.push(r);
    }

    if (subPeriodReturns.length === 0) continue;

    // Chain-link: TWR = Π(1 + r_i) - 1
    const totalReturn =
      subPeriodReturns.reduce((prod, r) => prod * (1 + r), 1) - 1;

    const firstDate =
      snapshots[0].month_end_date;
    const lastDate = snapshots[snapshots.length - 1].month_end_date;
    // Where the chained return actually opens. Whenever the first
    // sub-period was chained off a value from BEFORE firstDate (a
    // prior-window snapshot, or the month's own opening balance), that is
    // ~30 days earlier than firstDate — and it, not firstDate, is the date
    // every window label sitting beside an annualized figure must show
    // (2026-09-02 QA ruling: START / DAYS / annualized describe ONE window).
    const measurementStartDate = measurementStart ?? firstDate;
    const totalDays = daysBetween(measurementStartDate, lastDate);

    perAccount.push({
      accountId: account.id,
      accountName: account.name,
      startDate: firstDate,
      measurementStartDate,
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
  if (singleAccountId && perAccount.length === 1) {
    const acct = perAccount[0];
    return {
      startDate: acct.startDate,
      measurementStartDate: acct.measurementStartDate,
      endDate: acct.endDate,
      totalReturn: acct.totalReturn,
      annualizedReturn: acct.annualizedReturn,
      totalDays: acct.totalDays,
      perAccount,
      isPartial: acct.isPartial,
    };
  }

  // ─── Portfolio-wide TWR ────────────────────────────────────────

  // When scopeIds is set (a named scope resolving to 2+ accounts), every
  // aggregate query below must filter to just those accounts — including
  // the "expected accounts" coverage count, which otherwise would compare
  // scoped present_accounts against the WHOLE portfolio's expected count
  // and permanently read as partial. scopePlaceholders/scopeAnd are reused
  // across all four queries; scopeParams supplies the bind values for
  // whichever clause(s) each query references.
  const scopePlaceholders = scopeIds ? scopeIds.map(() => "?").join(",") : "";
  const scopeAnd = (col: string) =>
    scopeIds ? ` AND ${col} IN (${scopePlaceholders})` : "";
  const scopeParams = scopeIds ?? [];
  const firstsCte = scopeIds
    ? `snapshot_firsts AS (
         SELECT account_id, MIN(month_end_date) AS first_date
         FROM monthly_snapshots
         WHERE ${excludeLiveSnapshotsSql("source")}${scopeAnd("account_id")}
         GROUP BY account_id
       )`
    : SNAPSHOT_FIRSTS_CTE;

  // Aggregate snapshots across accounts per month
  const aggSnapshots = db
    .prepare(
      `WITH ${firstsCte}
       SELECT ms.month_end_date,
              SUM(ms.total_value) AS total_value,
              SUM(COALESCE(ms.deposits_withdrawals, 0)) AS total_deposits_withdrawals,
              COUNT(*) AS present_accounts,
              ${EXPECTED_ACCOUNTS_SQL} AS expected_accounts
       FROM monthly_snapshots ms
       WHERE ms.month_end_date >= ? AND ms.month_end_date <= ?
         AND ${excludeLiveSnapshotsSql("ms.source")}${scopeAnd("ms.account_id")}
       GROUP BY ms.month_end_date
       ORDER BY ms.month_end_date ASC`
    )
    .all(...scopeParams, effectiveStart, effectiveEnd, ...scopeParams) as AggregatedSnapshotRow[];

  // Get aggregated prior snapshot
  const aggPriorRow = db
    .prepare(
      `WITH ${firstsCte},
       agg AS (
         SELECT ms.month_end_date,
                SUM(ms.total_value) AS total_value,
                COUNT(*) AS present_accounts,
                ${EXPECTED_ACCOUNTS_SQL} AS expected_accounts
         FROM monthly_snapshots ms
         WHERE ms.month_end_date < ?
           AND ${excludeLiveSnapshotsSql("ms.source")}${scopeAnd("ms.account_id")}
         GROUP BY ms.month_end_date
       )
       SELECT month_end_date, total_value FROM agg
       WHERE present_accounts >= expected_accounts
       ORDER BY month_end_date DESC
       LIMIT 1`
    )
    .get(...scopeParams, effectiveStart, ...scopeParams) as
    | { month_end_date: string; total_value: number | null }
    | undefined;

  // All external flows for the range — scoped to just the named accounts
  // when a multi-account scope is active, otherwise every account.
  const allFlowStmt = db.prepare(
    `SELECT trade_date, SUM(${SIGNED_EXTERNAL_FLOW_SQL}) AS amount
     FROM transactions
     WHERE is_external_flow = 1
       AND trade_date >= ? AND trade_date <= ?${scopeAnd("account_id")}
     GROUP BY trade_date
     ORDER BY trade_date ASC`
  );

  // In-kind mirror of allFlowStmt (spec §6.5) — used two ways below: (1)
  // day-weighted per-flow rows appended inside the effectiveDeposits !== 0
  // branch for the CURRENT covered month, and (2) summed to a per-month
  // total when accumulating a SKIPPED month's carry (mirrors how
  // carriedDeposits already accumulates that month's cash
  // deposits_withdrawals). Never used inside the transaction-fallback
  // branch — allFlowStmt (no type filter) already includes these rows.
  const allInKindFlowStmt = db.prepare(
    `SELECT trade_date, SUM(${SIGNED_EXTERNAL_FLOW_SQL}) AS amount
     FROM transactions
     WHERE is_external_flow = 1
       AND trade_date >= ? AND trade_date <= ?
       AND ${IN_KIND_LEG_SQL}${scopeAnd("account_id")}
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
         AND ms.starting_value IS NOT NULL${scopeAnd("ms.account_id")}`
    )
    .all(effectiveStart, effectiveEnd, ...scopeParams) as {
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
  // Portfolio twin of the per-account `measurementStart` above: the date the
  // first chained aggregate sub-period opens on.
  let portfolioMeasurementStart: string | null = null;

  // Full-coverage filter: a month missing an already-born account's row is
  // statement lag — summing it would read the absent account's whole value
  // as a return. Skipped months' deposits carry into the next covered month
  // so multi-month Dietz periods keep their flows.
  const coveredSnapshots: CoveredSnapshotRow[] = [];
  let carriedDeposits = 0;
  let carriedInKind = 0;
  let carriedMonths: string[] = [];
  for (const snap of aggSnapshots) {
    if (snap.present_accounts < snap.expected_accounts) {
      portfolioPartial = true;
      const correction = decemberCorrections.get(snap.month_end_date) ?? 0;
      carriedDeposits += snap.total_deposits_withdrawals - correction;
      // Carry this skipped month's in-kind FMV flows too — same treatment
      // as carriedDeposits, so a donation/journal leg dated inside a
      // statement-lag month rides forward into the next covered month
      // instead of vanishing (spec §6.5).
      const skippedMonthStart = monthStartDate(snap.month_end_date);
      const skippedInKindRows = allInKindFlowStmt.all(
        skippedMonthStart,
        snap.month_end_date,
        ...scopeParams
      ) as CashFlowRow[];
      carriedInKind += skippedInKindRows.reduce((sum, row) => sum + (row.amount ?? 0), 0);
      carriedMonths.push(snap.month_end_date);
      continue;
    }
    coveredSnapshots.push({
      ...snap,
      carried_deposits: carriedDeposits,
      carried_inkind: carriedInKind,
      carried_months: carriedMonths,
    });
    carriedDeposits = 0;
    carriedInKind = 0;
    carriedMonths = [];
  }

  // Ledger flows dated inside a gap period's missing months (see gapOpening),
  // day-weighted over the span. A row is left out when the aggregate already
  // holds it, so nothing is counted twice:
  //  - an in-kind leg dated in a SKIPPED month (one in carried_months) is
  //    already in carried_inkind;
  //  - a cash row dated in a skipped month is already in carried_deposits
  //    when ITS account's statement for that month states a non-zero
  //    deposits_withdrawals (carriedDeposits sums exactly those figures).
  // Everything else is read: cash of an account that has no statement for
  // the month (or one stating nothing), and every flow in a month no account
  // reported (no aggregate row, so nothing was carried).
  const gapLedgerStmt = db.prepare(
    `SELECT account_id, trade_date, ${SIGNED_EXTERNAL_FLOW_SQL} AS amount,
            CASE WHEN ${IN_KIND_LEG_SQL} THEN 1 ELSE 0 END AS in_kind
     FROM transactions
     WHERE is_external_flow = 1
       AND trade_date >= ? AND trade_date <= ?${scopeAnd("account_id")}
     ORDER BY trade_date ASC`
  );
  const gapStatedStmt = db.prepare(
    `SELECT account_id, month_end_date
     FROM monthly_snapshots
     WHERE month_end_date >= ? AND month_end_date <= ?
       AND deposits_withdrawals IS NOT NULL AND deposits_withdrawals != 0
       AND ${excludeLiveSnapshotsSql("source")}${scopeAnd("account_id")}`
  );
  function aggregateGapFlows(
    gapStart: string,
    mStart: string,
    mEnd: string,
    periodDays: number,
    carried: string[]
  ): { amount: number; weight: number }[] {
    const gapEnd = dayBeforeMonthStart(mStart);
    const from = nextDay(gapStart);
    const carriedMonth = new Set(carried.map((d) => d.slice(0, 7)));
    const stated = new Set(
      (gapStatedStmt.all(from, gapEnd, ...scopeParams) as { account_id: number; month_end_date: string }[])
        .filter((r) => carriedMonth.has(r.month_end_date.slice(0, 7)))
        .map((r) => `${r.account_id}:${r.month_end_date.slice(0, 7)}`)
    );
    const rows = gapLedgerStmt.all(from, gapEnd, ...scopeParams) as {
      account_id: number;
      trade_date: string;
      amount: number | null;
      in_kind: number;
    }[];
    const out: { amount: number; weight: number }[] = [];
    for (const row of rows) {
      if (row.amount == null) continue;
      const month = row.trade_date.slice(0, 7);
      if (row.in_kind === 1 ? carriedMonth.has(month) : stated.has(`${row.account_id}:${month}`)) continue;
      out.push({ amount: row.amount, weight: daysBetween(row.trade_date, mEnd) / periodDays });
    }
    return out;
  }

  for (let i = 0; i < coveredSnapshots.length; i++) {
    const snap = coveredSnapshots[i];

    let vStart: number | null = null;
    let vStartDate: string | null = null;
    if (i > 0) {
      vStart = coveredSnapshots[i - 1].total_value;
      vStartDate = coveredSnapshots[i - 1].month_end_date;
    } else if (aggPriorRow?.total_value) {
      vStart = aggPriorRow.total_value;
      vStartDate = aggPriorRow.month_end_date;
    }

    if (vStart === null || vStart === 0) {
      portfolioPartial = true;
      continue;
    }

    const vEnd = snap.total_value;
    // A gap period (see gapOpening) weights dated flows over the whole span;
    // every other month keeps its own day count, byte for byte.
    const gapStart = gapOpening(vStartDate, monthStartDate(snap.month_end_date));
    const periodDays = (mEnd: string) =>
      gapStart !== null ? daysBetween(gapStart, mEnd) : daysInMonth(mEnd);

    // Use aggregated deposits_withdrawals, corrected for December annual rows
    const correction = decemberCorrections.get(snap.month_end_date) ?? 0;
    const effectiveDeposits =
      snap.total_deposits_withdrawals - correction + snap.carried_deposits + snap.carried_inkind;

    let weightedFlows: { amount: number; weight: number }[];
    // A gap ending on a month that holds a December ANNUAL row (one with a
    // December correction): the corrected figure still holds the missing
    // months' deposits, so — as in the per-account chain — the whole span's
    // flows come from the ledger alone and neither the snapshot figure nor
    // the carry is used.
    const annualAcrossGap = gapStart !== null && decemberCorrections.has(snap.month_end_date);

    if (annualAcrossGap) {
      const mEnd = snap.month_end_date;
      const span = periodDays(mEnd);
      weightedFlows = (allFlowStmt.all(nextDay(gapStart), mEnd, ...scopeParams) as CashFlowRow[])
        .filter((f) => f.amount != null)
        .map((f) => ({ amount: f.amount, weight: daysBetween(f.trade_date, mEnd) / span }));
    } else if (effectiveDeposits !== 0) {
      weightedFlows = [{ amount: effectiveDeposits, weight: 0.5 }];
      // Union in THIS month's own in-kind transfer legs (spec §6.5) —
      // distinct from carried_inkind above (a PRIOR skipped month's carry).
      // Day-weighted by their own trade_date, matching the fallback
      // branch's per-flow weighting below.
      const mStart = monthStartDate(snap.month_end_date);
      const mEnd = snap.month_end_date;
      const totalDaysInMonth = periodDays(mEnd);
      const inKindFlows = allInKindFlowStmt.all(mStart, mEnd, ...scopeParams) as CashFlowRow[];
      for (const flow of inKindFlows) {
        if (flow.amount == null) continue;
        const daysRemaining = daysBetween(flow.trade_date, mEnd);
        const weight = totalDaysInMonth > 0 ? daysRemaining / totalDaysInMonth : 0;
        weightedFlows.push({ amount: flow.amount, weight });
      }
    } else {
      const mStart = monthStartDate(snap.month_end_date);
      const mEnd = snap.month_end_date;
      const totalDaysInMonth = periodDays(mEnd);
      const flows = allFlowStmt.all(mStart, mEnd, ...scopeParams) as CashFlowRow[];
      weightedFlows = flows
        .filter((f) => f.amount != null)
        .map((f) => {
          const daysRemaining = daysBetween(f.trade_date, mEnd);
          const weight =
            totalDaysInMonth > 0 ? daysRemaining / totalDaysInMonth : 0;
          return { amount: f.amount, weight };
        });
    }

    if (gapStart !== null) portfolioPartial = true;
    if (gapStart !== null && !annualAcrossGap) {
      weightedFlows.push(
        ...aggregateGapFlows(
          gapStart,
          monthStartDate(snap.month_end_date),
          snap.month_end_date,
          periodDays(snap.month_end_date),
          snap.carried_months
        )
      );
    }

    const r = modifiedDietzReturn(vStart, vEnd, weightedFlows);
    if (r === null) {
      portfolioPartial = true;
      continue;
    }

    portfolioMeasurementStart ??= vStartDate;
    portfolioReturns.push(r);
  }

  // Portfolio chain-link
  const portfolioTotalReturn =
    portfolioReturns.length > 0
      ? portfolioReturns.reduce((prod, r) => prod * (1 + r), 1) - 1
      : 0;

  const portfolioFirstDate =
    coveredSnapshots.length > 0
      ? coveredSnapshots[0].month_end_date
      : effectiveStart;
  const portfolioLastDate =
    coveredSnapshots.length > 0
      ? coveredSnapshots[coveredSnapshots.length - 1].month_end_date
      : effectiveEnd;
  // Same measurement anchor as the per-account counts above.
  const portfolioMeasurementStartDate =
    portfolioMeasurementStart ?? portfolioFirstDate;
  const portfolioTotalDays = daysBetween(
    portfolioMeasurementStartDate,
    portfolioLastDate
  );

  return {
    startDate: portfolioFirstDate,
    measurementStartDate: portfolioMeasurementStartDate,
    endDate: portfolioLastDate,
    totalReturn: portfolioTotalReturn,
    annualizedReturn: annualize(portfolioTotalReturn, portfolioTotalDays),
    totalDays: portfolioTotalDays,
    perAccount,
    isPartial: portfolioPartial,
  };
}

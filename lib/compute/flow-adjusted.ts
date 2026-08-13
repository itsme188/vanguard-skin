/**
 * External cash-flow adjustment for return-series math — shared by
 * computeRiskMetrics (drawdown/vol/Sharpe) and computeMarketRegression
 * (beta/alpha). Lives in its own module because risk.ts already imports from
 * factors.ts (normalizeAccountIds) — factors importing these back from
 * risk.ts would create an import cycle.
 *
 * Convention (see CLAUDE.md "risk metrics are flow-adjusted"): a deposit or
 * withdrawal changes account value without being a market move. Any metric
 * computed on raw daily_valuations values reads a $100k withdrawal as a
 * -19% "day" (the 2026-06-10 IBKR drawdown bug; the same mechanism drove the
 * degenerate beta-0.05 multi-account regression, 2026-07-26).
 */

import type Database from "better-sqlite3";

export interface SeriesPoint {
  date: string;
  value: number;
}

/**
 * Signed external-flow amount expression. Security transfers store the
 * transfer-date market value as a positive magnitude — the TYPE carries the
 * direction (same convention as quantity-always-positive) — so TRANSFER_OUT
 * must be signed negative here or a paired internal journal (equal
 * TRANSFER_IN + TRANSFER_OUT legs) reads as double inflow and every
 * flow-consuming metric (TWR, XIRR, flow-adjusted index, attribution)
 * drifts. -ABS keeps an already-negative row negative.
 */
export const SIGNED_EXTERNAL_FLOW_SQL =
  "CASE WHEN type = 'TRANSFER_OUT' THEN -ABS(amount) ELSE amount END";

/**
 * Net external flows (deposits positive, withdrawals negative) per trade_date
 * for the scoped accounts, bounded to (startDate, endDate]. Flows on/before
 * the first valuation date are already baked into the starting value; flows
 * after the last valuation date haven't hit the series yet.
 *
 * Gracefully returns [] when the transactions table doesn't exist (minimal
 * in-memory test DBs) — same precedent as getRiskFreeRate's settings guard.
 */
export function fetchNetFlowsByDate(
  db: Database.Database,
  accountIds: number[] | undefined,
  startDate: string,
  endDate: string
): { date: string; net: number }[] {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transactions'")
    .get();
  if (!hasTable) return [];

  const accountFilter =
    accountIds && accountIds.length > 0
      ? `AND account_id IN (${accountIds.map(() => "?").join(",")})`
      : "";

  return db
    .prepare(
      `SELECT trade_date AS date, SUM(${SIGNED_EXTERNAL_FLOW_SQL}) AS net
       FROM transactions
       WHERE is_external_flow = 1
         AND trade_date > ? AND trade_date <= ?
         ${accountFilter}
       GROUP BY trade_date
       HAVING SUM(${SIGNED_EXTERNAL_FLOW_SQL}) != 0
       ORDER BY trade_date ASC`
    )
    .all(startDate, endDate, ...(accountIds ?? [])) as { date: string; net: number }[];
}

/**
 * Build a growth-of-$1 index from daily valuations with external flows
 * stripped out: r_t = (V_t − F_t) / V_{t−1}, where F_t is the net flow that
 * landed in (date_{t−1}, date_t] (end-of-day convention — a flow dated on a
 * valuation date adjusts that date's return, matching statement EOD values).
 * Drawdowns computed on this index reflect market movement only; the raw
 * series would read every withdrawal as a crash and every deposit as a rally.
 *
 * `returns` carries each log return with the date it lands on (series[t]) so
 * consumers that pair returns with another series (the market regression's
 * benchmark alignment) can match by date; a skipped pair (non-positive prev
 * or adjusted value) simply has no entry.
 */
export function buildFlowAdjustedIndex(
  series: SeriesPoint[],
  flows: { date: string; net: number }[]
): { index: SeriesPoint[]; returns: { date: string; logReturn: number }[] } {
  if (series.length === 0) return { index: [], returns: [] };

  const index: SeriesPoint[] = [{ date: series[0].date, value: 1 }];
  const returns: { date: string; logReturn: number }[] = [];
  let fi = 0;
  while (fi < flows.length && flows[fi].date <= series[0].date) fi++;

  for (let t = 1; t < series.length; t++) {
    let net = 0;
    while (fi < flows.length && flows[fi].date <= series[t].date) {
      net += flows[fi].net;
      fi++;
    }
    const prev = series[t - 1].value;
    const adjusted = series[t].value - net;
    let indexValue = index[t - 1].value;
    if (prev > 0 && adjusted > 0) {
      const growth = adjusted / prev;
      returns.push({ date: series[t].date, logReturn: Math.log(growth) });
      indexValue = index[t - 1].value * growth;
    }
    index.push({ date: series[t].date, value: indexValue });
  }

  return { index, returns };
}

/**
 * Anchor-source seam dates for the scoped accounts, bounded to
 * (startDate, endDate] — the same half-open convention as
 * fetchNetFlowsByDate (a seam on/before the series' first date is already
 * inside the starting value).
 *
 * A "seam" is the month_end_date of any monthly_snapshots anchor whose
 * `source` differs from the SAME account's previous anchor. Phase 2 of
 * computeDailyValuations snaps total_value to each anchor's total on the
 * anchor date, so a source change between adjacent anchors injects the two
 * sources' measurement-basis difference into the daily series as if it were
 * a market move (the 2026-07-11 Plaid go-live read as a fake ~+4% day; every
 * daily-source ↔ statement month-end handoff repeats this at ~±1-3%).
 * buildFlowAdjustedIndex bridges these days: zero information, not a return.
 *
 * The scan starts from each account's FIRST anchor (not startDate) so the
 * first in-window anchor is compared against its true predecessor. NULL and
 * unrecognized sources are distinct values — a transition to/from unknown
 * provenance bridges (conservative by construction). An account's first
 * anchor has no predecessor and is never a seam.
 *
 * Gracefully returns [] when monthly_snapshots doesn't exist (minimal
 * in-memory test DBs) — same precedent as fetchNetFlowsByDate.
 */
export function fetchAnchorSourceSeamDates(
  db: Database.Database,
  accountIds: number[] | undefined,
  startDate: string,
  endDate: string
): string[] {
  const hasTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'monthly_snapshots'"
    )
    .get();
  if (!hasTable) return [];

  const accountFilter =
    accountIds && accountIds.length > 0
      ? `AND account_id IN (${accountIds.map(() => "?").join(",")})`
      : "";

  const rows = db
    .prepare(
      `SELECT account_id, month_end_date, source
       FROM monthly_snapshots
       WHERE month_end_date <= ?
         ${accountFilter}
       ORDER BY account_id ASC, month_end_date ASC`
    )
    .all(endDate, ...(accountIds ?? [])) as {
    account_id: number;
    month_end_date: string;
    source: string | null;
  }[];

  const seams = new Set<string>();
  let prevAccount: number | null = null;
  let prevSource: string | null | undefined;
  for (const row of rows) {
    const isNewAccount = row.account_id !== prevAccount;
    if (!isNewAccount && row.source !== prevSource && row.month_end_date > startDate) {
      seams.add(row.month_end_date);
    }
    prevAccount = row.account_id;
    prevSource = row.source;
  }

  return [...seams].sort();
}

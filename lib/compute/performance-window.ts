/**
 * The Performance window rule — ONE place that decides what dates a selected
 * period covers, so the TWR, XIRR, risk metrics, equity curve, benchmark rows
 * and attribution on one screen all describe one window.
 *
 * Owner ruling (2026-10-08): a FIXED period (1Y / 3Y / 5Y) is a full span
 * ENDING at the last statement anchor: end = the latest statement-grade
 * month-end for the scope, start = that anchor shifted back the period.
 * Before, the start rolled with today while the monthly chain could only
 * reach the last statement, so "1Y" covered about eleven months.
 * YTD (Jan 1 to today) and All (everything, to today) are unchanged.
 */

import type Database from "better-sqlite3";
import { excludeLiveSnapshotsSql } from "@/lib/db/live-sources";
import { SNAPSHOT_FIRSTS_CTE, EXPECTED_ACCOUNTS_SQL } from "@/lib/compute/snapshot-coverage";

export type PerformancePeriod = "ytd" | "1y" | "3y" | "5y" | "all";

const FIXED_PERIOD_YEARS: Partial<Record<PerformancePeriod, number>> = { "1y": 1, "3y": 3, "5y": 5 };

const PERIOD_LABEL: Record<PerformancePeriod, string> = {
  ytd: "YTD",
  "1y": "1Y",
  "3y": "3Y",
  "5y": "5Y",
  all: "All",
};

export interface PerformanceWindow {
  /** The date the window OPENS on. For a statement-anchored period this is
   *  the opening month-end anchor (its close is the starting value), and it
   *  is the inclusive start for daily series (risk, curve, benchmark,
   *  attribution). `undefined` for "All". */
  startDate: string | undefined;
  /** The date the window closes on: the statement anchor for a fixed period
   *  that has one, otherwise today. */
  endDate: string;
  /** True only for a fixed period resolved against a statement anchor. */
  endsAtStatement: boolean;
  /** The start to hand `computeTwr` / `computeXirr`. Both read `startDate`
   *  as "first day INSIDE the window" and take the opening value from the
   *  last statement strictly BEFORE it. For a statement-anchored period the
   *  opening statement is dated `startDate` itself, so the chain starts the
   *  day after — passing `startDate` would pull the opening month in as a
   *  thirteenth link. Equal to `startDate` in every other case. */
  chainStartDate: string | undefined;
}

function isoUtc(y: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(y, monthIndex, day)).toISOString().slice(0, 10);
}

function lastDayOfMonth(y: number, monthIndex: number): number {
  return new Date(Date.UTC(y, monthIndex + 1, 0)).getUTCDate();
}

function isMonthEnd(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  return d === lastDayOfMonth(y, m - 1);
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return isoUtc(y, m - 1, d + 1);
}

/**
 * `date` shifted back `years` calendar years, month-end aware:
 * a month-end stays a month-end (a year before 2025-02-28 is 2024-02-29,
 * the day that month's statement is dated; a year before 2024-02-29 is
 * 2023-02-28); any other day keeps its day of the month.
 */
export function shiftYearsMonthEndAware(date: string, years: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const targetYear = y - years;
  const targetLast = lastDayOfMonth(targetYear, m - 1);
  const day = isMonthEnd(date) ? targetLast : Math.min(d, targetLast);
  return isoUtc(targetYear, m - 1, day);
}

/**
 * Resolve the window for a selected period. Pure: `today` must be an ET
 * calendar day (todayET()), `lastStatementAnchor` comes from
 * `latestStatementAnchor` (null when the scope has no statement).
 */
export function resolvePerformanceWindow(
  period: PerformancePeriod,
  { today, lastStatementAnchor }: { today: string; lastStatementAnchor: string | null },
): PerformanceWindow {
  const years = FIXED_PERIOD_YEARS[period];
  if (years === undefined) {
    const startDate = period === "ytd" ? `${today.slice(0, 4)}-01-01` : undefined;
    return { startDate, endDate: today, endsAtStatement: false, chainStartDate: startDate };
  }
  if (lastStatementAnchor) {
    const startDate = shiftYearsMonthEndAware(lastStatementAnchor, years);
    return {
      startDate,
      endDate: lastStatementAnchor,
      endsAtStatement: true,
      chainStartDate: nextDay(startDate),
    };
  }
  // No statement for this scope: the period rolls with today, as it did
  // before the ruling. Same calendar day N years back (no month-end snapping
  // — today is not an anchor), clamped for a leap day.
  const [y, m, d] = today.split("-").map(Number);
  const startDate = isoUtc(y - years, m - 1, Math.min(d, lastDayOfMonth(y - years, m - 1)));
  return { startDate, endDate: today, endsAtStatement: false, chainStartDate: startDate };
}

/**
 * The latest statement-grade month-end anchor for a scope, on or before
 * `today`, or null when there is none.
 *
 * - Statement-grade = not a live (Plaid / TWS) current-value row
 *   (`excludeLiveSnapshotsSql`, the same test computeTwr / computeXirr use).
 * - Full coverage: for a multi-account scope the anchor is the latest month
 *   for which EVERY account already born by then has a statement — the same
 *   rule computeTwr's aggregate chain applies, so the window end is always a
 *   month that chain can reach.
 * - `accountIds` undefined = every account; an empty array = no accounts
 *   (null — never widened to the whole portfolio).
 */
export function latestStatementAnchor(
  db: Database.Database,
  accountIds: number[] | undefined,
  today: string,
): string | null {
  if (accountIds !== undefined && accountIds.length === 0) return null;
  const placeholders = accountIds ? accountIds.map(() => "?").join(",") : "";
  const scopeAnd = (col: string) => (accountIds ? ` AND ${col} IN (${placeholders})` : "");
  const scopeParams = accountIds ?? [];
  const firstsCte = accountIds
    ? `snapshot_firsts AS (
         SELECT account_id, MIN(month_end_date) AS first_date
         FROM monthly_snapshots
         WHERE ${excludeLiveSnapshotsSql("source")}${scopeAnd("account_id")}
         GROUP BY account_id
       )`
    : SNAPSHOT_FIRSTS_CTE;
  const rows = db
    .prepare(
      `WITH ${firstsCte},
       agg AS (
         SELECT ms.month_end_date AS d,
                COUNT(*) AS present_accounts,
                ${EXPECTED_ACCOUNTS_SQL} AS expected_accounts
         FROM monthly_snapshots ms
         WHERE ms.month_end_date <= ?
           AND ${excludeLiveSnapshotsSql("ms.source")}${scopeAnd("ms.account_id")}
         GROUP BY ms.month_end_date
       )
       SELECT d FROM agg
       WHERE present_accounts >= expected_accounts
       ORDER BY d DESC`,
    )
    .all(...scopeParams, today, ...scopeParams) as { d: string }[];
  // A statement anchor is a month-end; a hand-entered mid-month value is not
  // one, so it never becomes the end of a "full year".
  return rows.find((r) => isMonthEnd(r.d))?.d ?? null;
}

function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${d}, ${y}`;
}

/**
 * One-line caption naming a fixed period's end date. Null for YTD and All
 * (their window is unchanged and needs no explanation).
 */
export function performanceWindowCaption(
  period: PerformancePeriod,
  window: PerformanceWindow,
): string | null {
  if (FIXED_PERIOD_YEARS[period] === undefined) return null;
  const label = PERIOD_LABEL[period];
  if (window.endsAtStatement && window.startDate) {
    return `${label} to ${formatDay(window.endDate)} (last statement) — the full span from ${formatDay(window.startDate)}.`;
  }
  return `${label} to ${formatDay(window.endDate)} (today) — this scope has no statement yet, so the period rolls with today.`;
}

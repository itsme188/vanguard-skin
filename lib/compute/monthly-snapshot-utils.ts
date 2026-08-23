/**
 * Shared `monthly_snapshots` read primitives — extracted from twr.ts so the
 * independent Modified Dietz module (a later task) can consume the same
 * annual-summary detection and month lookups without re-deriving them (a
 * durable, independently-verifiable performance lane — see CLAUDE.md "TWR
 * 'reconciliation' is statement-self-referential").
 */

import type Database from "better-sqlite3";
import { excludeLiveSnapshotsSql } from "@/lib/db/live-sources";

export interface MonthSnapshotRow {
  month_end_date: string;
  total_value: number;
  starting_value: number | null;
  twr: number | null;
  deposits_withdrawals: number | null;
  source: string;
}

/**
 * Detects a December "annual summary" monthly_snapshots row: some sources
 * (statement-derived) report December with `starting_value` set to the
 * YEAR-start value (not the prior month's total) and `twr`/
 * `deposits_withdrawals` as annual (cumulative), not monthly, figures. Using
 * either directly would silently corrupt a monthly Dietz/TWR chain.
 *
 * Mirrors the threshold at twr.ts:296-301 exactly: December-only, and a
 * >10% divergence between `starting_value` and the prior month's actual
 * total. The `month_end_date` check is the guard — a non-December row must
 * never be flagged regardless of how far starting_value diverges (Codex plan
 * review #7): a legitimate large deposit/withdrawal in any other month is
 * real activity, not an annual-summary artifact.
 */
export function isAnnualSummaryRow(
  snap: { month_end_date: string; starting_value: number | null },
  priorMonthTotal: number | null
): boolean {
  return (
    snap.month_end_date.slice(5, 7) === "12" &&
    priorMonthTotal != null &&
    snap.starting_value != null &&
    Math.abs(snap.starting_value - priorMonthTotal) > priorMonthTotal * 0.1
  );
}

/**
 * The monthly_snapshots row for one account + exact month-end date, or null
 * if none exists. Excludes live broker snapshots (tws/plaid) via
 * excludeLiveSnapshotsSql — those are current-value pulls, not month-end
 * statements, and must never stand in for one here.
 */
export function fetchMonthSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string
): MonthSnapshotRow | null {
  const row = db
    .prepare(
      `SELECT month_end_date, total_value, starting_value, twr, deposits_withdrawals, source
       FROM monthly_snapshots
       WHERE account_id = ?
         AND month_end_date = ?
         AND ${excludeLiveSnapshotsSql("source")}`
    )
    .get(accountId, monthEndDate) as MonthSnapshotRow | undefined;
  return row ?? null;
}

/** The last calendar day of the month BEFORE monthEndDate's month, e.g.
 *  "2026-02-28" → "2026-01-31", "2026-01-31" → "2025-12-31". */
function priorMonthEndDate(monthEndDate: string): string {
  const d = new Date(monthEndDate + "T00:00:00Z");
  // Day 0 of the current month = the last day of the previous month.
  const prior = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  return prior.toISOString().slice(0, 10);
}

/**
 * The total_value of the EXACT adjacent prior calendar month-end's
 * monthly_snapshots row (excluding live tws/plaid snapshots), or null if
 * that exact month is missing.
 *
 * Deliberately NOT "the latest earlier row" — a missing intervening month
 * (statement lag, a gap) must surface as null, never silently bridge to an
 * older row and understate the elapsed period (mirrors the full-coverage
 * guard twr.ts already applies at the portfolio-aggregate level).
 */
export function fetchPriorMonthTotal(
  db: Database.Database,
  accountId: number,
  monthEndDate: string
): number | null {
  const priorDate = priorMonthEndDate(monthEndDate);
  const row = db
    .prepare(
      `SELECT total_value
       FROM monthly_snapshots
       WHERE account_id = ?
         AND month_end_date = ?
         AND ${excludeLiveSnapshotsSql("source")}`
    )
    .get(accountId, priorDate) as { total_value: number } | undefined;
  return row?.total_value ?? null;
}

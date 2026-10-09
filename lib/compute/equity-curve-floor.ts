/**
 * Where the Performance equity curve may start: the first statement anchor.
 *
 * Ruling 2026-09-02 (docs/DECISIONS.md, "Pre-first-resolvable-anchor daily
 * rows are an engine boundary"): a daily value dated before an account's
 * first statement has no statement to tie it to, so it is an estimate. Used
 * as the curve's base day it put a fake step on the first statement day. The
 * curve is floored at the first statement instead; no stored row changes.
 *
 * For a scope of several accounts the floor is the LATEST of their first
 * statements: before that date at least one account in the summed series is
 * still an estimate. Only accounts that have a daily value inside the window
 * count (an account with statements but no daily history is not in the
 * series, so it cannot hold the curve back), and an account with no statement
 * at all sets no floor (a live-only account still plots).
 */

import type Database from "better-sqlite3";
import { excludeLiveSnapshotsSql } from "@/lib/db/live-sources";

/**
 * The first statement anchor for the curve of a scope, or null when no
 * account in the series has a statement.
 *
 * - Statement-grade = not a live (Plaid / TWS) current-value row
 *   (`excludeLiveSnapshotsSql`, the same test the window rule in
 *   performance-window.ts uses).
 * - `accountIds` undefined = every account; an empty array = no accounts
 *   (null — never widened to the whole portfolio).
 * - `startDate` / `endDate` bound which accounts have a daily value in the
 *   plotted window (both inclusive).
 */
export function firstStatementAnchorForCurve(
  db: Database.Database,
  accountIds: number[] | undefined,
  startDate: string,
  endDate: string,
): string | null {
  if (accountIds !== undefined && accountIds.length === 0) return null;
  const scopeAnd = accountIds ? ` AND account_id IN (${accountIds.map(() => "?").join(",")})` : "";
  const row = db
    .prepare(
      `SELECT MAX(first_date) AS floor FROM (
         SELECT MIN(month_end_date) AS first_date
         FROM monthly_snapshots
         WHERE ${excludeLiveSnapshotsSql("source")}${scopeAnd}
           AND account_id IN (
             SELECT DISTINCT account_id FROM daily_valuations
             WHERE valuation_date >= ? AND valuation_date <= ?
           )
         GROUP BY account_id
       )`,
    )
    .get(...(accountIds ?? []), startDate, endDate) as { floor: string | null } | undefined;
  return row?.floor ?? null;
}

/**
 * The date the curve's daily series starts on: the later of the selected
 * window's start and the first statement anchor.
 */
export function curveFloorDate(windowStart: string, firstAnchor: string | null): string {
  return firstAnchor !== null && firstAnchor > windowStart ? firstAnchor : windowStart;
}

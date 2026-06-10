import type Database from "better-sqlite3";

export interface RemoveStaleSameDayTwsHoldingsOptions {
  accountId: number;
  /** The sync date (YYYY-MM-DD) whose tws rows should be reconciled. */
  asOfDate: string;
  /** Security IDs present in the sync that just committed. */
  syncedSecurityIds: number[];
  /**
   * Refuse to clean up when the sync returned fewer than this fraction of the
   * date's existing tws rows — a partial/failed TWS capture must not wipe the
   * day's book. Default 0.5 (same rationale as reconcileClosedEquityHoldings).
   */
  shrinkFloor?: number;
}

export interface RemoveStaleSameDayTwsHoldingsResult {
  deleted: number;
  /** True when the shrink guard (or an empty sync) suppressed the cleanup. */
  skipped: boolean;
}

/**
 * Delete same-day ghost holdings rows left behind by earlier intraday TWS
 * syncs.
 *
 * `syncPortfolio` runs every ~30 minutes and `INSERT OR REPLACE`s each
 * reported position keyed (account, security, as_of=today) — but it skips
 * zero-quantity positions and never deletes rows for positions that
 * disappeared between syncs. On active trading days (intraday short
 * round-trips, same-day closes) the date accumulates rows describing positions
 * that no longer exist, inflating/deflating that day's reconstructed holdings
 * value by tens of thousands of dollars (the 2026-04-23/24 IBKR ±$50-90k
 * valuation spikes).
 *
 * This removes tws-sourced rows (`source_key LIKE 'tws-%'`) for the sync date
 * that are absent from the just-committed position set. Statement-sourced rows
 * on the same date are never touched (statement wins, as with the upsert
 * priority rules). Unlike `reconcileClosedEquityHoldings` (cross-date, writes
 * zero-rows to preserve statement history), hard deletion is correct here:
 * these rows are our own superseded intraday writes, not durable records —
 * the position's history lives in earlier dates and the trade ledger.
 */
export function removeStaleSameDayTwsHoldings(
  db: Database.Database,
  opts: RemoveStaleSameDayTwsHoldingsOptions
): RemoveStaleSameDayTwsHoldingsResult {
  const shrinkFloor = opts.shrinkFloor ?? 0.5;

  const existing = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM holdings
         WHERE account_id = ? AND as_of_date = ? AND source_key LIKE 'tws-%'`
      )
      .get(opts.accountId, opts.asOfDate) as { c: number }
  ).c;

  if (existing === 0) return { deleted: 0, skipped: false };

  if (
    opts.syncedSecurityIds.length === 0 ||
    opts.syncedSecurityIds.length < existing * shrinkFloor
  ) {
    return { deleted: 0, skipped: true };
  }

  const placeholders = opts.syncedSecurityIds.map(() => "?").join(",");
  const result = db
    .prepare(
      `DELETE FROM holdings
       WHERE account_id = ? AND as_of_date = ? AND source_key LIKE 'tws-%'
         AND security_id NOT IN (${placeholders})`
    )
    .run(opts.accountId, opts.asOfDate, ...opts.syncedSecurityIds);

  return { deleted: result.changes, skipped: false };
}

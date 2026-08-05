/**
 * Full-coverage guard for portfolio-wide monthly_snapshots aggregation —
 * the monthly sibling of getDailyValuationsForAccounts' fullCoverageOnly
 * flag (see CLAUDE.md "Coverage-jump guard").
 *
 * A month is usable for a summed cross-account series only when every
 * account that has ANY snapshot on/before that month has a row FOR that
 * month. A statement-lag month (one broker's statement imported before the
 * others') otherwise drops a whole account's value out of the sum and reads
 * as a catastrophic fake return — the 2026-08-04 scope-all TWR/MWR collapse
 * (IBKR's July row landed via the ledger rebuild while Vanguard's July
 * statements weren't in yet). Accounts legitimately START at different
 * dates, so "expected" counts only accounts already born by that month.
 */

import { excludeLiveSnapshotsSql } from "@/lib/db/live-sources";

/**
 * CTE body listing each account's first statement-sourced snapshot month.
 * Compose as: `WITH ${SNAPSHOT_FIRSTS_CTE} SELECT ... FROM monthly_snapshots ms ...`
 */
export const SNAPSHOT_FIRSTS_CTE = `snapshot_firsts AS (
  SELECT account_id, MIN(month_end_date) AS first_date
  FROM monthly_snapshots
  WHERE ${excludeLiveSnapshotsSql("source")}
  GROUP BY account_id
)`;

/**
 * Scalar subquery: number of accounts expected to have a row for the month
 * being grouped (alias the outer table `ms`). Compare against COUNT(*) of
 * the month's group — present < expected means statement lag; skip.
 */
export const EXPECTED_ACCOUNTS_SQL =
  "(SELECT COUNT(*) FROM snapshot_firsts f WHERE f.first_date <= ms.month_end_date)";

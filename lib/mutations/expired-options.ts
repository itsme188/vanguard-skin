import type Database from "better-sqlite3";
import { liveOriginHoldingSql, statementSourcedHoldingSql } from "@/lib/db/holding-sources";
import { todayET } from "@/lib/calendar/date-utils";
import { optionExpirationDaySql } from "@/lib/compute/option-expiry";

/**
 * The stored expiration as a SQLite day. Legacy rows carry the compact
 * `YYYYMMDD` spelling, which `date()` reads as NULL (the row was never
 * purged), so the dashed form is rebuilt first, exactly as
 * `liveOptionExpirationSql` (lib/compute/option-expiry.ts) does for readers.
 * Anything else that `date()` cannot read stays NULL and is never deleted.
 */
const EXPIRATION_DAY_SQL = optionExpirationDaySql("expiration_date");

/**
 * A holdings row is a claim "on `as_of_date`, this account held Q of X". For a
 * contract that expired AFTER the snapshot date that claim is TRUE HISTORY, and
 * an imported statement is its audit trail, so this purge must never delete it
 * — the same principle scripts/retire-expired-option-holdings.ts states:
 * "statement rows stay as the audit trail — unlike purgeExpiredOptionHoldings,
 * an unscoped delete".
 *
 * The delete is not what keeps an expired contract out of live views: every
 * held-universe reader filters it at read time through the shared
 * `liveOptionExpirationSql` (lib/queries/holdings.ts, lib/queries/today-holdings.ts,
 * lib/compute/hedging.ts, lib/compute/scenarios.ts), precisely because the app
 * supports a no-TWS import path where nothing purges. Those readers also
 * already draw this distinction in prose: an explicit as-of-date query "is a
 * point-in-time snapshot and legitimately shows a contract that had not yet
 * expired as of that date."
 *
 * Statement PREFIXES only, so tombstone cleanup is unchanged: a recon row is
 * quantity 0 and carries no history to protect.
 *
 * Regression this fixes: a monthly statement import run after one of its
 * month-end option positions had expired inserted that position and the
 * post-commit purge then deleted it back out of the month-end snapshot,
 * shifting its value from holdings into inferred cash (October 2026 IBKR
 * import, run four days after month-end).
 */
// COALESCE because statementSourcedHoldingSql interpolates the column into bare
// LIKEs: on a NULL source_key every LIKE is NULL, so `NOT (...)` is NULL and the
// row matches nothing. A row with no source_key is not statement-sourced, so it
// stays purgeable. (statementGradeHoldingSql coalesces internally for the same
// reason; this helper leaves it to the caller.)
const NOT_STATEMENT_SOURCED_SQL = `NOT ${statementSourcedHoldingSql("COALESCE(source_key, '')")}`;

export interface PurgeExpiredOptionHoldingsOptions {
  accountId?: number;
  liveOnly?: boolean;
  today?: string;
}

/**
 * Delete holdings rows for option securities whose `expiration_date` is more
 * than `graceDays` days in the past. Statement imports never zero-out rows
 * for positions that simply disappear from a later snapshot, so expired
 * options can linger in `holdings` indefinitely and surface in briefings /
 * cross-account rollups.
 *
 * The 1-day default grace tolerates end-of-day expiration reporting that may
 * settle the morning after expiry.
 *
 * Returns the count of rows deleted.
 */
export function purgeExpiredOptionHoldings(
  db: Database.Database,
  graceDays = 1,
  options?: PurgeExpiredOptionHoldingsOptions,
): number {
  if (!options) {
    const result = db
      .prepare(
        `DELETE FROM holdings
         WHERE security_id IN (
           SELECT id FROM securities
           WHERE LOWER(security_type) = 'option'
             AND expiration_date IS NOT NULL
             AND ${EXPIRATION_DAY_SQL} < date(?, ?)
         )
           AND ${NOT_STATEMENT_SOURCED_SQL}`,
      )
      // The grace day counts from the Eastern day, bound: SQLite's
      // date('now') is the UTC day, which after 20:00 Eastern is already
      // tomorrow and shortened the one-day grace to none.
      .run(todayET(), `-${graceDays} day`);
    return result.changes;
  }

  const predicates = [
    `security_id IN (
       SELECT id FROM securities
       WHERE LOWER(security_type) = 'option'
         AND expiration_date IS NOT NULL
         AND ${EXPIRATION_DAY_SQL} < date(@today, @grace)
     )`,
  ];
  predicates.push(NOT_STATEMENT_SOURCED_SQL);
  if (options.accountId != null) predicates.push("account_id = @accountId");
  if (options.liveOnly) {
    // Expired options need no closure tombstone, so live-origin tombstones are
    // removed with the stale live position rows.
    predicates.push(liveOriginHoldingSql("holdings"));
  }

  const result = db
    .prepare(
      `DELETE FROM holdings
       WHERE ${predicates.join(" AND ")}`,
    )
    .run({
      accountId: options.accountId,
      grace: `-${graceDays} day`,
      today: options.today ?? todayET(),
    });
  return result.changes;
}

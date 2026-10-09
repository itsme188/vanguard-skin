import type Database from "better-sqlite3";
import { liveOriginHoldingSql } from "@/lib/db/holding-sources";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * The stored expiration as a SQLite day. Legacy rows carry the compact
 * `YYYYMMDD` spelling, which `date()` reads as NULL (the row was never
 * purged), so the dashed form is rebuilt first, exactly as
 * `liveOptionExpirationSql` (lib/compute/option-expiry.ts) does for readers.
 * Anything else that `date()` cannot read stays NULL and is never deleted.
 */
const EXPIRATION_DAY_SQL = `date(CASE WHEN expiration_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' THEN substr(expiration_date,1,4) || '-' || substr(expiration_date,5,2) || '-' || substr(expiration_date,7,2) ELSE expiration_date END)`;

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
         )`,
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

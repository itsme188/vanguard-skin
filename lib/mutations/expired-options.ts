import type Database from "better-sqlite3";
import { liveOriginHoldingSql } from "@/lib/db/holding-sources";

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
             AND date(expiration_date) < date('now', ?)
         )`,
      )
      .run(`-${graceDays} day`);
    return result.changes;
  }

  const predicates = [
    `security_id IN (
       SELECT id FROM securities
       WHERE LOWER(security_type) = 'option'
         AND expiration_date IS NOT NULL
         AND date(expiration_date) < ${
           options.today ? "date(@today, @grace)" : "date('now', @grace)"
         }
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
      today: options.today,
    });
  return result.changes;
}

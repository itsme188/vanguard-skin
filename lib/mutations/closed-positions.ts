import type Database from "better-sqlite3";

/**
 * Delete holdings rows for option securities whose cumulative transaction
 * history nets to zero — i.e. the position was opened and fully closed
 * (BTO/STC for longs, STO/BTC for shorts) but the holdings table still
 * shows a non-zero quantity from the most recent statement snapshot.
 *
 * Statement imports never zero-out positions that simply disappear from a
 * later snapshot, and TWS auto-refresh only writes rows for ACTIVE
 * positions (TWS doesn't return zero-quantity entries). So a long option
 * sold via SELL_TO_CLOSE before its expiry can linger in `holdings`
 * indefinitely until either the next statement zeroes it OR
 * `purgeExpiredOptionHoldings` runs after expiration. Sister to that
 * mutation — handles closed-but-not-expired options.
 *
 * Companion to `purgeExpiredOptionHoldings` — runs on the same trigger
 * (Step 1.5 of TWS auto-refresh).
 *
 * Returns the count of holdings rows deleted.
 */
export function purgeClosedOptionHoldings(db: Database.Database): number {
  // Opens are positive (BTO adds long contracts; BTC closes shorts which is
  // adding back); closes are negative. Net = 0 means the position is fully
  // closed regardless of direction (long-then-sold OR short-then-covered).
  // COUNT(*) > 0 guards against empty histories triggering a delete.
  const result = db
    .prepare(
      `DELETE FROM holdings
       WHERE security_id IN (
         SELECT id FROM securities WHERE LOWER(security_type) = 'option'
       )
         AND (account_id, security_id) IN (
           SELECT t.account_id, t.security_id
             FROM transactions t
             JOIN securities s ON s.id = t.security_id
            WHERE LOWER(s.security_type) = 'option'
            GROUP BY t.account_id, t.security_id
           HAVING COUNT(*) > 0
              AND SUM(
                    CASE
                      WHEN t.type IN ('BUY_TO_OPEN', 'BUY_TO_CLOSE') THEN t.quantity
                      WHEN t.type IN ('SELL_TO_OPEN', 'SELL_TO_CLOSE') THEN -t.quantity
                      ELSE 0
                    END
                  ) = 0
         )`,
    )
    .run();
  return result.changes;
}

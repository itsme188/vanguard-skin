/**
 * One-shot run of purgeClosedOptionHoldings against the live DB.
 *
 * Going forward, this runs automatically on every TWS auto-refresh as Step 1.6
 * (see lib/tws/auto-refresh.ts). This script exists so the first cleanup
 * doesn't wait for the next TWS connection.
 *
 * Usage:
 *   npx tsx scripts/purge-closed-options-once.ts            # actually delete
 *   npx tsx scripts/purge-closed-options-once.ts --dry-run  # preview only
 */

import { db } from "../lib/db";
import { purgeClosedOptionHoldings } from "../lib/mutations/closed-positions";

const dryRun = process.argv.includes("--dry-run");

interface CandidateRow {
  symbol: string;
  expiration_date: string | null;
  quantity: number;
  account: string;
  net_qty: number;
  txn_count: number;
}

const candidates = db
  .prepare(
    `SELECT s.symbol,
            s.expiration_date,
            h.quantity,
            a.name AS account,
            (
              SELECT SUM(
                       CASE
                         WHEN t.type IN ('BUY_TO_OPEN','BUY_TO_CLOSE') THEN t.quantity
                         WHEN t.type IN ('SELL_TO_OPEN','SELL_TO_CLOSE') THEN -t.quantity
                         ELSE 0
                       END
                     )
                FROM transactions t
               WHERE t.account_id = h.account_id
                 AND t.security_id = h.security_id
            ) AS net_qty,
            (
              SELECT COUNT(*) FROM transactions t
               WHERE t.account_id = h.account_id
                 AND t.security_id = h.security_id
            ) AS txn_count
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       JOIN accounts a ON a.id = h.account_id
      WHERE LOWER(s.security_type) = 'option'`,
  )
  .all() as CandidateRow[];

const closed = candidates.filter((c) => c.txn_count > 0 && c.net_qty === 0);

if (closed.length === 0) {
  console.log("No closed option holdings to purge.");
  process.exit(0);
}

console.log(`Found ${closed.length} closed option holdings:`);
for (const c of closed) {
  console.log(
    `  - ${c.symbol} expires ${c.expiration_date ?? "?"} qty ${c.quantity} in ${c.account} (net 0 across ${c.txn_count} txns)`,
  );
}

if (dryRun) {
  console.log("\n--dry-run: skipping delete");
  process.exit(0);
}

const purged = purgeClosedOptionHoldings(db);
console.log(`\nPurged ${purged} rows.`);

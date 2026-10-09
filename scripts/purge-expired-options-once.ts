/**
 * One-shot run of purgeExpiredOptionHoldings against the live DB.
 *
 * Going forward, this runs automatically on every TWS auto-refresh as Step 1.5
 * (see lib/tws/auto-refresh.ts). This script exists so the first cleanup
 * doesn't wait for the next TWS connection.
 *
 * Usage:
 *   npx tsx scripts/purge-expired-options-once.ts            # actually delete
 *   npx tsx scripts/purge-expired-options-once.ts --dry-run  # preview only
 */

import { db } from "../lib/db";
import { purgeExpiredOptionHoldings } from "../lib/mutations/expired-options";
import { todayET } from "../lib/calendar/date-utils";

const dryRun = process.argv.includes("--dry-run");

const candidates = db
  .prepare(
    `SELECT s.symbol, s.expiration_date, h.quantity, a.name AS account
     FROM holdings h
     JOIN securities s ON s.id = h.security_id
     JOIN accounts a ON a.id = h.account_id
     WHERE LOWER(s.security_type) = 'option'
       AND s.expiration_date IS NOT NULL
       AND date(s.expiration_date) < date(?, '-1 day')`,
  )
  // The Eastern day, bound: the same cut the purge itself applies.
  .all(todayET()) as Array<{ symbol: string; expiration_date: string; quantity: number; account: string }>;

if (candidates.length === 0) {
  console.log("No expired option holdings to purge.");
  process.exit(0);
}

console.log(`Found ${candidates.length} expired option holdings:`);
for (const c of candidates) {
  console.log(`  - ${c.symbol} expires ${c.expiration_date} qty ${c.quantity} in ${c.account}`);
}

if (dryRun) {
  console.log("\n--dry-run: skipping delete");
  process.exit(0);
}

const purged = purgeExpiredOptionHoldings(db);
console.log(`\nPurged ${purged} rows.`);

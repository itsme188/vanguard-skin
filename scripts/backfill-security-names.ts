/**
 * One-shot backfill for `securities.name` via TWS contractDetails.longName.
 *
 * Why: `lib/tws/positions.ts` historically wrote `name = contract.localSymbol`
 * which for stocks just echoes the symbol ("AMZN" → "AMZN"). The Today + Risk
 * tables guard against the duplicate-symbol render but the secondary span ends
 * up empty for those holdings. Round 4's enrichSecurities() change makes new
 * imports populate longName automatically; this script catches the existing
 * 295-of-429 held securities still on the old shape.
 *
 * Reuses lib/tws/contracts.ts::enrichSecurities, which now (a) selects rows
 * where name IS NULL OR name = symbol, (b) reads detail.longName, (c) writes
 * back via CASE-guarded UPDATE that only fills empty/echoed names. Manually
 * curated names are preserved.
 *
 * Idempotent. Safe to re-run after each TWS sync.
 *
 * Requires:
 *   - TWS / IB Gateway running on port 7496
 *   - clientId 1 free (project convention; Stock Contest uses 2)
 *   - IBKR_ACCOUNT_CODE env var if you have multiple linked accounts
 *
 * Usage:
 *   npx tsx scripts/backfill-security-names.ts          # run
 *   npx tsx scripts/backfill-security-names.ts --dry-run # preview only
 */

import "dotenv/config";
import { db } from "../lib/db";

const dryRun = process.argv.includes("--dry-run");

interface CandidateRow {
  id: number;
  symbol: string;
  security_type: string | null;
  account_names: string;
}

const candidates = db
  .prepare(
    `SELECT s.id, s.symbol, s.security_type,
            GROUP_CONCAT(DISTINCT a.name) AS account_names
     FROM securities s
     JOIN holdings h ON h.security_id = s.id
     JOIN accounts a ON a.id = h.account_id
     WHERE (s.name IS NULL OR s.name = s.symbol)
       AND s.symbol NOT LIKE 'CUSIP:%'
       AND LOWER(s.security_type) NOT IN ('cash', 'money_market', 'money market')
       AND (
         (LOWER(s.security_type) NOT IN ('option') AND s.symbol NOT LIKE '% %')
         OR (LOWER(s.security_type) = 'option' AND s.symbol GLOB '*[0-9][0-9][0-9]')
       )
     GROUP BY s.id, s.symbol, s.security_type
     ORDER BY s.symbol`,
  )
  .all() as CandidateRow[];

if (candidates.length === 0) {
  console.log("No held securities need name backfill. Done.");
  process.exit(0);
}

console.log(
  `${candidates.length} held securities need name backfill${dryRun ? " (dry-run)" : ""}:\n`,
);
const byAccount = new Map<string, number>();
for (const c of candidates) {
  for (const acct of c.account_names.split(",")) {
    byAccount.set(acct, (byAccount.get(acct) ?? 0) + 1);
  }
}
for (const [acct, n] of [...byAccount.entries()].sort()) {
  console.log(`  ${acct}: ${n}`);
}
console.log();

if (dryRun) {
  console.log("Dry run — no TWS calls. First 10 candidates:");
  for (const c of candidates.slice(0, 10)) {
    console.log(`  ${c.symbol} (${c.security_type})`);
  }
  process.exit(0);
}

async function run() {
  const { getIbApi, connectTws } = await import("../lib/tws/client");
  let tws = getIbApi();
  if (!tws) {
    console.log("Connecting to TWS...");
    await connectTws();
    tws = getIbApi();
  }
  if (!tws) {
    console.error(
      "Could not connect to TWS. Is Trader Workstation running on port 7496?",
    );
    process.exit(2);
  }
  console.log("TWS connected. Running enrichSecurities()...\n");

  const { enrichSecurities } = await import("../lib/tws/contracts");
  const results = await enrichSecurities(db);

  const enriched = results.filter((r) => r.enriched).length;
  const failed = results.filter((r) => !r.enriched);
  console.log(
    `\nDone. ${enriched}/${results.length} securities enriched.`,
  );
  if (failed.length > 0) {
    console.log(`\n${failed.length} failures:`);
    for (const f of failed.slice(0, 20)) {
      console.log(`  ${f.symbol}: ${f.error ?? "no contract details returned"}`);
    }
    if (failed.length > 20) console.log(`  ... and ${failed.length - 20} more`);
  }

  const stillNeeding = db
    .prepare(
      `SELECT COUNT(*) AS n FROM securities s
       JOIN holdings h ON h.security_id = s.id
       WHERE (s.name IS NULL OR s.name = s.symbol)
         AND s.symbol NOT LIKE 'CUSIP:%'`,
    )
    .get() as { n: number };
  console.log(
    `\n${stillNeeding.n} held securities still have name IS NULL OR name = symbol.`,
  );
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * Audit script: compare computeTwr output against statement-reported TWR
 * for every (account, month) pair that has a statement TWR value.
 *
 * Exit 0: ≤20% of pairs are out of tolerance (5bp) — gate PASS
 * Exit 1: >20% of pairs are out of tolerance — gate FAIL
 */
import { db } from "@/lib/db";
import { reconcileTwrAgainstStatements } from "@/lib/compute/twr-reconcile";

const accounts = db
  .prepare("SELECT id, name FROM accounts ORDER BY name")
  .all() as { id: number; name: string }[];

let totalChecked = 0,
  totalWithin = 0,
  totalOut = 0;
const outOfTolerance: {
  account: string;
  periodEnd: string;
  divergenceBp: number;
}[] = [];

for (const acct of accounts) {
  const months = db
    .prepare(
      `
    SELECT month_end_date FROM monthly_snapshots
    WHERE account_id = ? AND source IN ('ibkr-activity', 'canonical', 'vanguard-pdf')
      AND twr IS NOT NULL
    ORDER BY month_end_date
  `,
    )
    .all(acct.id) as { month_end_date: string }[];

  for (const m of months) {
    const r = reconcileTwrAgainstStatements(db, acct.id, m.month_end_date);
    if (!r) continue;
    totalChecked++;
    if (r.withinTolerance) {
      totalWithin++;
    } else {
      totalOut++;
      outOfTolerance.push({
        account: acct.name,
        periodEnd: m.month_end_date,
        divergenceBp: r.divergenceBp,
      });
    }
  }
}

console.log(`\nReconciled ${totalChecked} period-account pairs`);
console.log(`  Within tolerance (5bp): ${totalWithin}`);
console.log(`  Out of tolerance:       ${totalOut}`);

if (outOfTolerance.length > 0) {
  console.log("\nOut-of-tolerance details:");
  for (const o of outOfTolerance) {
    console.log(
      `  ${o.account.padEnd(25)} ${o.periodEnd}  ${o.divergenceBp >= 0 ? "+" : ""}${o.divergenceBp}bp`,
    );
  }
}

if (totalChecked === 0) {
  console.log(
    "\nGATE: SKIP (no statement TWR data found — verify DB has monthly_snapshots with TWR populated)",
  );
  process.exit(0);
}

const failRate = totalOut / totalChecked;
const exitCode = failRate > 0.2 ? 1 : 0;

if (exitCode === 0) {
  console.log(
    `\nGATE: PASS (${(failRate * 100).toFixed(1)}% out-of-tolerance ≤ 20% threshold)`,
  );
} else {
  console.log(
    `\nGATE: FAIL (${(failRate * 100).toFixed(1)}% out-of-tolerance > 20% threshold)`,
  );
}

process.exit(exitCode);

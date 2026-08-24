#!/usr/bin/env tsx
/**
 * Audit CLI: compares the independent Modified Dietz return against
 * statement-reported TWR for every (account, month) pair that has a
 * statement row, via `reconcileTwrAgainstStatements` (Task 14,
 * lib/compute/twr-reconcile.ts). Read-only — never mutates any DB.
 *
 * stdout is DIRECTION-ONLY, always: the per-row table prints only
 * `band` and `rule` (no divergenceBp/statementTwr/dietzReturn — those
 * are the user's real return figures). The summary line references the
 * classification threshold by its exported name (`DIETZ_CONSISTENT_BP`,
 * lib/compute/dietz.ts) rather than a hardcoded number, so it can never
 * go stale the way the old "Within tolerance (5bp)" label did (the
 * actual threshold is 125bp, fixed and public in that file — this is a
 * code constant, not a per-account figure, so printing its value here
 * discloses nothing about anyone's portfolio).
 *
 * Numeric detail (statementTwr, dietzReturn, divergenceBp per row) is
 * written ONLY when `--detail-out <path>` is passed, and only after
 * confirming the path is gitignored (`git check-ignore -q`) — this
 * mirrors the acceptance-script convention (Task 7,
 * scripts/reconcile-tax-report-vs-broker.ts) so a real-figure detail
 * file can never land in the (public) repo by accident.
 *
 * Exit code: 0 unless at least one (account, month) pair bands
 * "investigate" — then 1. (0 also covers the "nothing to check" case:
 * no accounts have any statement TWR rows yet.)
 *
 * Usage (run from the repo root — the "@/" alias needs it):
 *   /opt/homebrew/opt/node@24/bin/npx tsx scripts/audit-twr-vs-statements.ts \
 *     [--detail-out docs/private/twr-audit-detail.json]
 *
 * DB: opens the default DB (DATABASE_PATH / VANGUARD_DB_DIR env,
 * resolveDbPath()) read-only. This script never writes to the DB, so
 * there is no REPAIR_DB_PATH-style override — point DATABASE_PATH at a
 * scratch copy directly if you need to audit something other than the
 * live DB.
 */
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { resolveDbPath } from "@/lib/db/db-path";
import {
  reconcileTwrAgainstStatements,
  type TwrReconcileResult,
} from "@/lib/compute/twr-reconcile";
import { DIETZ_CONSISTENT_BP, type DietzBand } from "@/lib/compute/dietz";

interface Row extends TwrReconcileResult {
  account: string;
}

function parseDetailOutArg(argv: string[]): string | undefined {
  const idx = argv.indexOf("--detail-out");
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value) {
    console.error("--detail-out requires a path argument");
    process.exit(1);
  }
  return value;
}

/**
 * Refuses (exit 1) unless `filePath` is covered by .gitignore. Numeric
 * TWR/Dietz detail must never be reachable from a committed file in
 * this PUBLIC repo — see CLAUDE.md "No sensitive data in public assets".
 */
function assertGitignored(filePath: string): string {
  const resolved = path.resolve(filePath);
  const result = spawnSync("git", ["check-ignore", "-q", resolved], {
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    console.error(
      `Refusing to write --detail-out to ${filePath}: it is not covered by ` +
        ".gitignore. This file will hold real TWR/Dietz figures and must " +
        "never be committable — point it at an already-ignored location " +
        "(e.g. under docs/private/ or data/) or add a .gitignore rule for it.",
    );
    process.exit(1);
  }
  return resolved;
}

function bandLabel(band: DietzBand): string {
  switch (band) {
    case "not_comparable":
      return "not comparable";
    default:
      return band;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const detailOutArg = parseDetailOutArg(argv);
  const resolvedDetailOut =
    detailOutArg !== undefined ? assertGitignored(detailOutArg) : undefined;

  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}`);
    process.exit(1);
  }

  // Read-only — this script only ever audits, never mutates.
  const db: Database.Database = new BetterSqlite3(dbPath, { readonly: true });

  const accounts = db
    .prepare("SELECT id, name FROM accounts ORDER BY name")
    .all() as { id: number; name: string }[];

  const results: Row[] = [];

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
      results.push({ ...r, account: acct.name });
    }
  }

  db.close();

  // ---- stdout: direction-only, always ----
  console.log(`\nReconciled ${results.length} account-month pair(s) against statement TWR`);

  if (results.length > 0) {
    const header = `${"ACCOUNT".padEnd(25)} ${"PERIOD END".padEnd(12)} ${"BAND".padEnd(15)} RULE`;
    console.log(`\n${header}`);
    console.log("-".repeat(header.length));
    for (const r of results) {
      console.log(
        `${r.account.padEnd(25)} ${r.monthEndDate.padEnd(12)} ${bandLabel(r.band).padEnd(15)} ${r.rule}`,
      );
    }
  }

  const bandCounts: Record<DietzBand, number> = {
    consistent: 0,
    investigate: 0,
    not_comparable: 0,
    insufficient: 0,
  };
  for (const r of results) bandCounts[r.band]++;

  console.log("\nBand summary:");
  console.log(`  Consistent (within ${DIETZ_CONSISTENT_BP}bp): ${bandCounts.consistent}`);
  console.log(`  Investigate:                       ${bandCounts.investigate}`);
  console.log(`  Not comparable:                    ${bandCounts.not_comparable}`);
  console.log(`  Insufficient:                       ${bandCounts.insufficient}`);

  const anyInvestigate = results.some((r) => r.band === "investigate");

  if (results.length === 0) {
    console.log(
      "\nGATE: SKIP (no statement TWR data found — verify DB has monthly_snapshots with TWR populated)",
    );
  } else if (anyInvestigate) {
    console.log(
      "\nGATE: FAIL (at least one account-month bands 'investigate' — needs a human look)",
    );
  } else {
    console.log("\nGATE: PASS (no account-month bands 'investigate')");
  }

  if (resolvedDetailOut) {
    fs.mkdirSync(path.dirname(resolvedDetailOut), { recursive: true });
    fs.writeFileSync(resolvedDetailOut, JSON.stringify(results, null, 2) + "\n", "utf8");
    console.log(`\nWrote numeric detail for ${results.length} row(s) to ${detailOutArg}`);
  }

  process.exit(anyInvestigate ? 1 : 0);
}

main();

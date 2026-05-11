/**
 * Refresh the per-(security, benchmark) regression cache for every security
 * the user holds. Idempotent — safe to re-run.
 *
 * Run via: npx tsx scripts/backfill-security-regressions.ts
 *
 * Backed by lib/compute/security-regression-backfill.ts — the same function
 * the Sunday briefing pipeline calls. Per-security failures are isolated and
 * logged via console.warn; the script itself only exits non-zero on a
 * hard top-level crash (DB open failure, etc.).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { backfillSecurityRegressions } from "../lib/compute/security-regression-backfill";

function main() {
  try {
    const startedAt = Date.now();
    const summary = backfillSecurityRegressions(db);
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `Regression backfill complete in ${(elapsedMs / 1000).toFixed(1)}s — ` +
        `processed=${summary.processed} succeeded=${summary.succeeded} ` +
        `skipped=${summary.skipped} failed=${summary.failed}`
    );
  } catch (err) {
    console.error(
      "Backfill failed:",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  }
}

main();

/**
 * Manual trigger for the 7:45 ET morning earnings debrief — the recovery path
 * for a morning the automated sweep missed entirely (Mac asleep through the
 * whole 07:45–08:20 ET window; the weekday pmset wake lands at 08:40 and
 * there is no weekend wake).
 *
 * `force: true` bypasses the ET window but NOT the once-per-ET-day
 * `last_debrief_date` key, so re-running after a successful debrief is a
 * safe no-op rather than a duplicate email.
 *
 * Usage:
 *   npx tsx scripts/send-morning-debrief.ts
 *
 * Reads .env.local for ANTHROPIC_API_KEY, RESEND_*, BRIEFING_EMAIL_TO, etc.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { runMorningDebrief } from "../lib/earnings/debrief-send";

async function main() {
  const result = await runMorningDebrief(db, { force: true });

  if (result.sent) {
    console.log(
      `${new Date().toISOString()} — debrief sent, covering ${result.covered.length} name(s): ${result.covered.join(", ")}`,
    );
    return;
  }

  console.log(
    `${new Date().toISOString()} — no debrief sent${result.skippedReason ? ` (${result.skippedReason})` : ""}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

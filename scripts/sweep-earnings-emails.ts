/**
 * Standalone fallback for the email sweep when the running Next.js server
 * isn't reachable. Mirrors the in-process logic of /api/cron/earnings-sweep
 * but operates against the local DB directly. Used by
 * scripts/enrich-calendar-events.sh as the second-tier fallback.
 *
 * Usage:
 *   npx tsx scripts/sweep-earnings-emails.ts
 *
 * Reads .env.local for ANTHROPIC_API_KEY, GMAIL_*, BRIEFING_EMAIL_TO,
 * FINNHUB_API_KEY (for any post-release press-release pulls), etc.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { runEarningsEmailSweep } from "../lib/calendar/email-sweep";

async function main() {
  const summary = await runEarningsEmailSweep(db);
  if (summary.swept === 0) {
    console.log(`${new Date().toISOString()} — no email candidates`);
    return;
  }
  for (const r of summary.results) {
    const dt = (r.durationMs / 1000).toFixed(1);
    const state = r.skipped ? "SKIP (cloud sent)" : r.ok ? "OK" : `FAILED: ${r.message}`;
    console.log(`  [${r.symbol}] ${r.phase} ${state} (${dt}s)`);
  }
  console.log(`Done — sent ${summary.sent}, skipped ${summary.skipped}, failed ${summary.failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

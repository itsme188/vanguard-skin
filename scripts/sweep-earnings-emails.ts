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
import { findEmailCandidates } from "../lib/calendar/enrichment-runner";
import {
  sendEarningsPreview,
  sendEarningsRecap,
} from "../lib/digest/send-earnings-email";

async function main() {
  const candidates = findEmailCandidates(db);
  if (candidates.length === 0) {
    console.log(`${new Date().toISOString()} — no email candidates`);
    return;
  }

  console.log(
    `${new Date().toISOString()} — ${candidates.length} candidate(s):`,
  );
  for (const c of candidates) {
    console.log(`  • ${c.symbol} ${c.phase} (event_id=${c.eventId})`);
  }

  let sent = 0;
  let failed = 0;
  for (const cand of candidates) {
    const t0 = Date.now();
    try {
      if (cand.phase === "preview") {
        await sendEarningsPreview(db, cand.eventId);
      } else {
        await sendEarningsRecap(db, cand.eventId);
      }
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${cand.symbol}] ${cand.phase} OK (${dt}s)`);
      sent++;
    } catch (err) {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [${cand.symbol}] ${cand.phase} FAILED (${dt}s): ${msg}`);
      failed++;
    }
  }

  console.log(`Done — sent ${sent}, failed ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

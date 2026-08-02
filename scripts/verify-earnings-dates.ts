/**
 * Manual driver for the earnings date/slot verification pass.
 *
 * Runs runEarningsDateVerification directly — no daily gate (the once-per-
 * ET-day gate lives in lib/calendar/verify-earnings-dates.ts as
 * maybeRunDailyDateVerification, wired into POST /api/cron/earnings-sweep,
 * which is the automated path; this CLI is for ad-hoc checks/reruns).
 *
 * Usage:
 *   npx tsx scripts/verify-earnings-dates.ts              # dry-run
 *   npx tsx scripts/verify-earnings-dates.ts --apply       # write + stamp
 *   npx tsx scripts/verify-earnings-dates.ts --limit 5     # cap candidates
 *   npx tsx scripts/verify-earnings-dates.ts --apply --limit 5
 *
 * Dry-run by default — prints what WOULD happen without touching the DB or
 * firing a Pushover summary. Pass --apply to actually correct dates/slots.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { runEarningsDateVerification, effectiveSlot } from "../lib/calendar/verify-earnings-dates";

function parseArgs(argv: string[]): { apply: boolean; limit?: number } {
  let apply = false;
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--limit") {
      const raw = argv[i + 1];
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (!raw || Number.isNaN(parsed) || parsed <= 0) {
        console.error(`--limit requires a positive integer argument (got "${raw ?? ""}").`);
        process.exit(1);
      }
      limit = parsed;
      i += 1; // consume the value
      continue;
    }
    console.error(`Unknown argument: "${arg}". Expected --apply and/or --limit N.`);
    process.exit(1);
  }

  return { apply, limit };
}

async function main() {
  const { apply, limit } = parseArgs(process.argv.slice(2));

  console.log(
    `Running earnings date verification (${apply ? "APPLY" : "dry-run"}${
      limit !== undefined ? `, limit ${limit}` : ""
    })...`,
  );

  const result = await runEarningsDateVerification(db, { apply, limit });

  if (result.outcomes.length === 0) {
    console.log(
      "No candidates found (nothing held/watchlisted/read-through-reporter with an unverified date inside the horizon).",
    );
    return;
  }

  for (const outcome of result.outcomes) {
    const slot = effectiveSlot(outcome.candidate) ?? "unknown";
    console.log(
      `${outcome.candidate.symbol} ${outcome.candidate.event_date} ${slot} → ${outcome.action}: ${outcome.detail}`,
    );
  }

  console.log(
    `\n${result.outcomes.length} outcome(s), ${result.corrections} correction(s)${
      apply ? "" : " — dry-run, nothing written"
    }.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

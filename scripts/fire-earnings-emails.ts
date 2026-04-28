/**
 * Fire earnings preview/recap emails for every held-stock event on a given
 * date and release-time slot. Used as the manual driver for the Tier 1 MVP
 * before /api/cron/earnings-{preview,recap} land in Tier 3.
 *
 * Usage:
 *   npx tsx scripts/fire-earnings-emails.ts <phase> <date> [slot] [--dry-run]
 *
 *   phase:     "preview" | "recap"
 *   date:      YYYY-MM-DD
 *   slot:      "bmo" | "amc"   (optional — filters by release_time)
 *   --dry-run: just list what WOULD fire, don't actually send emails
 *
 * Examples:
 *   # Sanity check before firing
 *   npx tsx scripts/fire-earnings-emails.ts preview 2026-04-28 bmo --dry-run
 *
 *   # Tomorrow morning, ~06:00 ET — fire previews for the BMO names
 *   npx tsx scripts/fire-earnings-emails.ts preview 2026-04-28 bmo
 *
 *   # Tomorrow afternoon, ~14:15 ET — fire previews for the AMC names
 *   npx tsx scripts/fire-earnings-emails.ts preview 2026-04-28 amc
 *
 *   # Tomorrow ~10:00 ET — fire recaps for the BMO names
 *   npx tsx scripts/fire-earnings-emails.ts recap 2026-04-28 bmo
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";

const ENDPOINT = process.env.EARNINGS_EMAIL_ENDPOINT
  ?? "http://localhost:3000/api/earnings/email";

interface EventRow {
  id: number;
  symbol: string;
  event_date: string;
  release_time: string | null;
  expected_impact: string | null;
  consensus_estimate: string | null;
  source: string;
}

function eventsForDate(date: string, slot?: "bmo" | "amc"): EventRow[] {
  const rows = db
    .prepare(
      `SELECT ce.id, ce.symbol, ce.event_date, ce.release_time,
              ce.expected_impact, ce.consensus_estimate, ce.source
         FROM calendar_events ce
         WHERE ce.event_type = 'earnings'
           AND ce.event_date = ?
           AND ce.symbol IN (
             SELECT DISTINCT s.symbol
               FROM holdings h
               JOIN securities s ON s.id = h.security_id
              WHERE h.quantity > 0
                AND h.as_of_date = (
                  SELECT MAX(h2.as_of_date) FROM holdings h2
                   WHERE h2.account_id = h.account_id
                     AND h2.security_id = h.security_id
                )
           )
         ORDER BY ce.release_time NULLS LAST, ce.symbol`,
    )
    .all(date) as EventRow[];
  if (!slot) return rows;
  return rows.filter((r) => {
    if (!r.release_time) return false;
    const hour = parseInt(r.release_time.split(":")[0], 10);
    if (Number.isNaN(hour)) return false;
    if (slot === "bmo") return hour < 12;
    return hour >= 12;
  });
}

async function fireOne(eventId: number, phase: "preview" | "recap"): Promise<{
  ok: boolean;
  status: number;
  body: string;
}> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId, phase }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [phase, date, slot] = positional;
  if (
    (phase !== "preview" && phase !== "recap") ||
    !date ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    console.error("usage: npx tsx scripts/fire-earnings-emails.ts <preview|recap> <YYYY-MM-DD> [bmo|amc] [--dry-run]");
    process.exit(1);
  }
  if (slot && slot !== "bmo" && slot !== "amc") {
    console.error("slot must be 'bmo' or 'amc' if provided");
    process.exit(1);
  }

  const events = eventsForDate(date, slot as "bmo" | "amc" | undefined);
  if (events.length === 0) {
    console.log(`No held-stock earnings events on ${date}${slot ? ` (${slot})` : ""}.`);
    process.exit(0);
  }

  const action = dryRun ? "Would fire" : "Firing";
  console.log(`${action} ${phase}s for ${events.length} held-stock earnings event(s) on ${date}${slot ? ` (${slot})` : ""}:`);
  for (const e of events) {
    console.log(`  • ${e.symbol} (id=${e.id}, ${e.release_time ?? "no time"}, source=${e.source})`);
  }
  console.log("");

  if (dryRun) {
    console.log("(dry run — no emails sent)");
    return;
  }

  for (const e of events) {
    process.stdout.write(`[${e.symbol}] firing ${phase}... `);
    const t0 = Date.now();
    try {
      const result = await fireOne(e.id, phase as "preview" | "recap");
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      if (result.ok) {
        console.log(`OK (${dt}s)`);
      } else {
        console.log(`FAILED (HTTP ${result.status}, ${dt}s)`);
        console.log(`  ${result.body.slice(0, 400)}`);
      }
    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

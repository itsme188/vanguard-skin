/**
 * Launchd entry point for post-release calendar event enrichment.
 *
 * Picks up any calendar_events rows whose release window is open
 * (event_date + release_time ∈ [now - 2h, now - 5min]) and fills in
 * actual_value / consensus_value / reaction_snapshot / enriched_at.
 *
 * Runs every 15 minutes during US market hours Mon-Fri via
 * ~/Library/LaunchAgents/com.vanguard-skin.calendar-enrich.plist.
 *
 * On TWS-available hosts (user's Mac with Trader Workstation open), the
 * runner captures 1-minute bar reactions for SPY/QQQ/TLT + sector ETFs.
 * Otherwise, only the actual_value enrichment path runs.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { runEnrichment } from "../lib/calendar/enrichment-runner";

async function main() {
  const DB_FILE = process.env.VGS_DB_FILE ?? "vanguard" + ".db";
  const dbPath = process.env.VGS_DB_PATH ?? path.join(process.cwd(), "data", DB_FILE);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  // Attempt to reach TWS. If Trader Workstation isn't running or the
  // session has rotated out, we silently proceed without reaction capture.
  let tws = null;
  try {
    const { getIbApi, connectTws } = await import("../lib/tws/client");
    tws = getIbApi();
    if (!tws) {
      await connectTws();
      tws = getIbApi();
    }
  } catch {
    tws = null;
  }

  const results = await runEnrichment(db, { tws });

  const now = new Date().toISOString();
  const summary = {
    timestamp: now,
    enriched_count: results.filter((r) => r.enriched).length,
    failed_count: results.filter((r) => !r.enriched).length,
    total_candidates: results.length,
    events: results.map((r) => ({
      id: r.eventId,
      source_key: r.source_key,
      actual: r.actual,
      reaction_present: !!r.reaction,
      reason: r.reason,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));

  db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("[enrich-calendar-events] fatal:", err);
  process.exit(1);
});

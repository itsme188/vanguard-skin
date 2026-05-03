/**
 * Backfill reaction_snapshot for calendar_events using Yahoo Finance 1-min bars.
 *
 * Use when the TWS path failed to capture (e.g., TWS was down during the
 * 12h earnings enrichment window) but the event is still within Yahoo's
 * ~10-day 1-min bar retention.
 *
 * Usage:
 *   npx tsx scripts/backfill-reaction-from-yahoo.ts <eventId> [<eventId> ...]
 *   npx tsx scripts/backfill-reaction-from-yahoo.ts --dry-run <eventId>
 *
 * Imports the same captureReactionFromYahoo helper the Worker uses, so the
 * resulting JSON shape (source: "yahoo") is byte-identical to cloud-fallback
 * output.
 */

import { db } from "../lib/db";
import { captureReactionFromYahoo } from "../workers/cron/src/yahoo";
import {
  composeReleaseInstant,
  resolveSectorEtf,
} from "../workers/cron/src/reaction-matcher";

interface EventRow {
  id: number;
  symbol: string | null;
  event_date: string;
  event_type: string;
  release_time: string | null;
  security_id: number | null;
  reaction_snapshot: string | null;
}

function resolveSectorForEvent(row: EventRow): string | null {
  if (row.event_type === "earnings" && row.security_id) {
    const sec = db
      .prepare("SELECT sector FROM securities WHERE id = ?")
      .get(row.security_id) as { sector: string | null } | undefined;
    return resolveSectorEtf("earnings", sec?.sector ?? null);
  }
  return resolveSectorEtf(row.event_type, null);
}

async function backfillEvent(eventId: number, dryRun: boolean): Promise<boolean> {
  const row = db
    .prepare(
      `SELECT id, symbol, event_date, event_type, release_time, security_id, reaction_snapshot
       FROM calendar_events WHERE id = ?`,
    )
    .get(eventId) as EventRow | undefined;
  if (!row) {
    console.error(`[${eventId}] not found`);
    return false;
  }
  if (!row.release_time) {
    console.error(`[${eventId}] ${row.symbol} ${row.event_date} — release_time is null, cannot compose`);
    return false;
  }
  if (row.reaction_snapshot) {
    console.warn(`[${eventId}] ${row.symbol} ${row.event_date} — reaction_snapshot already present, will overwrite`);
  }

  const releaseInstant = composeReleaseInstant(row.event_date, row.release_time);
  if (!releaseInstant) {
    console.error(`[${eventId}] malformed event_date/release_time: ${row.event_date} ${row.release_time}`);
    return false;
  }

  const sectorEtf = resolveSectorForEvent(row);
  console.log(
    `[${eventId}] ${row.symbol} ${row.event_date} ${row.release_time} ET → ${releaseInstant.toISOString()} UTC` +
      (sectorEtf ? ` (sector ETF: ${sectorEtf})` : ""),
  );

  const snapshot = await captureReactionFromYahoo(releaseInstant, sectorEtf, {
    eventSymbol: row.event_type === "earnings" ? row.symbol : null,
  });

  if (!snapshot) {
    console.error(`[${eventId}] Yahoo returned no usable bars (off-hours release? outage?)`);
    return false;
  }

  console.log(
    `[${eventId}] reaction: SPY ${snapshot.spy.delta_pct.toFixed(2)}% · QQQ ${snapshot.qqq.delta_pct.toFixed(2)}% · TLT ${snapshot.tlt.delta_pct.toFixed(2)}%` +
      (snapshot.symbol ? ` · ${snapshot.symbol.symbol} ${snapshot.symbol.delta_pct.toFixed(2)}%` : "") +
      (snapshot.sector ? ` · ${snapshot.sector.symbol} ${snapshot.sector.delta_pct.toFixed(2)}%` : ""),
  );

  if (dryRun) {
    console.log(`[${eventId}] --dry-run: skipping DB write`);
    return true;
  }

  db.prepare("UPDATE calendar_events SET reaction_snapshot = ? WHERE id = ?").run(
    JSON.stringify(snapshot),
    eventId,
  );
  console.log(`[${eventId}] wrote reaction_snapshot (source: yahoo)`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const ids = args.filter((a) => !a.startsWith("--")).map((a) => Number(a));
  if (ids.length === 0 || ids.some(Number.isNaN)) {
    console.error("Usage: npx tsx scripts/backfill-reaction-from-yahoo.ts [--dry-run] <eventId> [<eventId> ...]");
    process.exit(1);
  }

  let ok = 0;
  for (const id of ids) {
    const success = await backfillEvent(id, dryRun);
    if (success) ok++;
    if (id !== ids[ids.length - 1]) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`\nDone: ${ok}/${ids.length} events ${dryRun ? "previewed" : "backfilled"}`);
  process.exit(ok === ids.length ? 0 : 1);
}

main();

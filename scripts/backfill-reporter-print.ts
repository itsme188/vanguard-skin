/**
 * Backfill a missed earnings print for a read-through REPORTER symbol.
 *
 * Recovery path for the 2026-08-02 PRLB case: a read-through pair carried a
 * wrong reporter ticker (PRTO instead of PRLB), so the calendar sweep never
 * ingested the reporter's print and the target's preview had no read-through
 * block to render. This script repairs a single (symbol, date) after the
 * fact:
 *
 *   1. Fetches the print from Finnhub's earnings calendar (authoritative —
 *      never hand-typed figures, per the data-integrity rule).
 *   2. Inserts a manual calendar_events row if none exists (BMO/AMC slot
 *      taken from Finnhub's `hour` field).
 *   3. Writes actual_value + consensus_estimate/value in the exact
 *      "EPS X.XX · Rev N,NNN" shape the enrichment runner produces.
 *   4. Captures the reaction snapshot from Yahoo 1-min bars (works up to
 *      ~10 days back — Yahoo's intraday retention). buildReadThroughEntries
 *      requires BOTH actual_value AND reaction_snapshot, so without step 4
 *      the target's preview still skips the reporter.
 *   5. Stamps enriched_at so the row reads as complete.
 *
 * Usage:
 *   npx tsx scripts/backfill-reporter-print.ts PRLB 2026-07-31           # dry-run
 *   npx tsx scripts/backfill-reporter-print.ts PRLB 2026-07-31 --apply   # write
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { db } from "../lib/db";
import { getCurrentMonday } from "../lib/calendar/date-utils";
import { insertCalendarEvent } from "../lib/mutations/calendar";
import { composeReleaseInstant } from "../lib/calendar/reaction-snapshot";
import { captureReactionFromYahoo } from "../workers/cron/src/yahoo";

interface FinnhubEntry {
  symbol: string;
  date: string;
  hour: string;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
}

function finnhubShape(eps: number | null, rev: number | null): string | null {
  const parts: string[] = [];
  if (eps != null) parts.push(`EPS ${eps.toFixed(2)}`);
  if (rev != null) parts.push(`Rev ${rev.toLocaleString("en-US")}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

async function main() {
  const [symbolArg, dateArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const apply = process.argv.includes("--apply");

  if (!symbolArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg ?? "")) {
    console.error("Usage: npx tsx scripts/backfill-reporter-print.ts <SYMBOL> <YYYY-MM-DD> [--apply]");
    process.exit(1);
  }
  const symbol = symbolArg.toUpperCase();
  const date = dateArg;

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    console.error("FINNHUB_API_KEY missing from .env.local");
    process.exit(1);
  }

  // ── 1. Authoritative print data from Finnhub ─────────────────────────
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${date}&to=${date}&symbol=${symbol}&token=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Finnhub HTTP ${res.status}`);
    process.exit(1);
  }
  const data = (await res.json()) as { earningsCalendar?: FinnhubEntry[] };
  // Strict symbol echo-match — a foreign-listing echo (TSM → 2330.TW) has
  // local-currency figures that must never be stored as USD.
  const entry = data.earningsCalendar?.find((e) => e.symbol === symbol && e.date === date);
  if (!entry) {
    console.error(`Finnhub has no ${symbol} print on ${date} — check the symbol and date.`);
    process.exit(1);
  }

  const actual = finnhubShape(entry.epsActual, entry.revenueActual);
  const consensus = finnhubShape(entry.epsEstimate, entry.revenueEstimate);
  const eventTime = entry.hour === "bmo" ? "BMO" : entry.hour === "amc" ? "AMC" : "AMC";
  console.log(`[backfill] ${symbol} ${date} (${eventTime}): actual="${actual}" consensus="${consensus}"`);

  if (!actual) {
    console.error("Finnhub has no actuals yet for this print — nothing to backfill.");
    process.exit(1);
  }

  // ── 2. Find or create the calendar row ───────────────────────────────
  const existing = db
    .prepare(
      `SELECT id, release_time, actual_value, reaction_snapshot FROM calendar_events
       WHERE UPPER(symbol) = ? AND event_date = ? AND event_type = 'earnings'
         AND COALESCE(superseded, 0) = 0
       ORDER BY id LIMIT 1`,
    )
    .get(symbol, date) as
    | { id: number; release_time: string | null; actual_value: string | null; reaction_snapshot: string | null }
    | undefined;

  if (!apply) {
    console.log(`[backfill] dry-run — event ${existing ? `#${existing.id} exists` : "would be created"}; re-run with --apply`);
    process.exit(0);
  }

  let eventId: number;
  if (existing) {
    eventId = existing.id;
    console.log(`[backfill] using existing event #${eventId}`);
  } else {
    const result = insertCalendarEvent(db, {
      symbol,
      event_date: date,
      event_type: "earnings",
      event_time: eventTime,
      consensus_estimate: consensus ?? undefined,
      week_of: getCurrentMonday(new Date(`${date}T12:00:00`)),
    });
    eventId = result.id;
    console.log(`[backfill] created manual event #${eventId}`);
  }

  // ── 3. Write actuals (add-only: COALESCE keeps any existing values) ──
  db.prepare(
    `UPDATE calendar_events
     SET actual_value = COALESCE(actual_value, ?),
         consensus_value = COALESCE(consensus_value, ?),
         consensus_estimate = COALESCE(consensus_estimate, ?)
     WHERE id = ?`,
  ).run(actual, consensus, consensus, eventId);

  // ── 4. Reaction snapshot from Yahoo (skip if already present) ────────
  const row = db
    .prepare(`SELECT release_time, reaction_snapshot FROM calendar_events WHERE id = ?`)
    .get(eventId) as { release_time: string | null; reaction_snapshot: string | null };

  if (row.reaction_snapshot) {
    console.log("[backfill] reaction_snapshot already present — leaving it");
  } else if (!row.release_time) {
    console.warn("[backfill] no release_time on row — cannot capture reaction");
  } else {
    const instant = composeReleaseInstant(date, row.release_time);
    if (!instant) {
      console.warn("[backfill] could not compose release instant");
    } else {
      const reaction = await captureReactionFromYahoo(instant, null, { eventSymbol: symbol });
      if (reaction) {
        db.prepare(`UPDATE calendar_events SET reaction_snapshot = ? WHERE id = ?`).run(
          JSON.stringify(reaction),
          eventId,
        );
        console.log(
          `[backfill] reaction captured: ${symbol} ${reaction.symbol?.delta_pct ?? "?"}% · SPY ${reaction.spy?.delta_pct ?? "?"}%`,
        );
      } else {
        console.warn("[backfill] Yahoo returned no usable bars (retention ~10 days) — reaction left empty");
      }
    }
  }

  // ── 5. Stamp completion ──────────────────────────────────────────────
  db.prepare(
    `UPDATE calendar_events
     SET enriched_at = COALESCE(enriched_at, datetime('now')),
         enrichment_attempted_at = datetime('now')
     WHERE id = ?`,
  ).run(eventId);

  const final = db
    .prepare(
      `SELECT id, symbol, event_date, release_time, actual_value,
              reaction_snapshot IS NOT NULL AS has_reaction, enriched_at
       FROM calendar_events WHERE id = ?`,
    )
    .get(eventId);
  console.log("[backfill] final row:", final);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

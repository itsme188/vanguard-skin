/**
 * Sunday-briefing bogeys reminder line (#11 A2).
 *
 * Nudges the user to curate earnings bogeys (via PDF upload, manual entry,
 * or the newsletter auto-extraction from Task A1) before the week's prints,
 * but only when the whole week's held/watchlist reporter set is still
 * completely uncovered — a single bogey anywhere in the window (any source)
 * silences the line, since the user has clearly already started.
 *
 * Deterministic, pure DB read — no AI call. Consumed by
 * lib/digest/send-briefing.ts, which appends the result at SEND time
 * (never cached into calendar_briefings.content), wrapped in a try/catch
 * that mirrors the coverage-guard discipline: a throw here must never
 * block the briefing.
 */

import type Database from "better-sqlite3";
import { coveredForEvents } from "@/lib/queries/briefing-symbols";
import { addDays } from "@/lib/calendar/date-utils";

// [weekOf, weekOf + WINDOW_DAYS] — the working week the Sunday briefing
// covers (Mon-Fri).
const WINDOW_DAYS = 4;

// Below this many qualifying reporters, a reminder isn't worth the noise.
const MIN_REPORTERS = 3;

// Cap on symbols named inline in the sentence — the count still reflects
// the full set.
const MAX_SYMBOLS_NAMED = 5;

interface ReporterEventRow {
  event_id: number;
  symbol: string;
}

/**
 * Returns a one-sentence reminder line, or null when the reminder doesn't
 * apply this week (behavioral contract, task-2-brief.md):
 *   1. >=3 held/watchlist reporters in [weekOf, weekOf+4d] with zero
 *      earnings_bogeys rows on those events -> the line.
 *   2. Any bogeys already exist for the week's qualifying events -> null.
 *   3. <3 qualifying reporters -> null.
 */
export function renderBogeysReminderLine(
  db: Database.Database,
  weekOf: string
): string | null {
  const endDate = addDays(weekOf, WINDOW_DAYS);

  const rows = db
    .prepare(
      `SELECT id AS event_id, symbol
       FROM calendar_events
       WHERE event_type = 'earnings'
         AND symbol IS NOT NULL
         AND event_date >= ? AND event_date <= ?
         AND COALESCE(superseded, 0) = 0`
    )
    .all(weekOf, endDate) as ReporterEventRow[];

  if (rows.length === 0) return null;

  const covered = coveredForEvents(db, rows.map((r) => ({ symbol: r.symbol, eventId: r.event_id })));
  const reporters = rows.filter((r) => covered.has(r.event_id));

  const reporterSymbols = Array.from(new Set(reporters.map((r) => r.symbol.toUpperCase())));
  if (reporterSymbols.length < MIN_REPORTERS) return null;

  const eventIds = reporters.map((r) => r.event_id);
  const placeholders = eventIds.map(() => "?").join(",");
  const { n: bogeyCount } = db
    .prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys WHERE event_id IN (${placeholders})`)
    .get(...eventIds) as { n: number };

  if (bogeyCount > 0) return null;

  const shown = reporterSymbols.slice(0, MAX_SYMBOLS_NAMED);
  const remaining = reporterSymbols.length - shown.length;
  const suffix = remaining > 0 ? `, +${remaining} more` : "";
  const plural = reporterSymbols.length === 1 ? "" : "s";

  return (
    `**Bogeys reminder:** ${reporterSymbols.length} held/watchlist name${plural} ` +
    `report${reporterSymbols.length === 1 ? "s" : ""} this week with no bogeys on file yet ` +
    `(${shown.join(", ")}${suffix}) — upload a preview PDF or add numbers manually before the prints.`
  );
}

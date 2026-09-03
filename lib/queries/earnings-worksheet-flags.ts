import type Database from "better-sqlite3";
import { addDays } from "@/lib/calendar/date-utils";

/** Armed / printed state per event for UI chips. */
export function getWorksheetFlagsForEvents(
  db: Database.Database,
  eventIds: number[],
): Map<number, { armed: true; printedAt: string | null }> {
  const out = new Map<number, { armed: true; printedAt: string | null }>();
  if (eventIds.length === 0) return out;
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT event_id, printed_at FROM earnings_worksheet_flags
        WHERE event_id IN (${placeholders})`,
    )
    .all(...eventIds) as { event_id: number; printed_at: string | null }[];
  for (const r of rows) out.set(r.event_id, { armed: true, printedAt: r.printed_at });
  return out;
}

/** One armed event, with everything the print-watcher needs to open a window.
 *  Column names stay snake_case where they mirror `calendar_events` so the
 *  row can be handed straight to `resolveEarningsReleaseTime` (which reads
 *  `event_type` / `event_time` / `raw_json` / `symbol`). */
export interface ArmedWorksheetEventRow {
  eventId: number;
  symbol: string;
  event_date: string;
  event_type: string;
  event_time: string | null;
  raw_json: string | null;
  con_id: number | null;
  /** The `securities.id` the join resolved (null when the symbol has no row).
   *  The watcher needs the ROW, not just its conId: an armed event on an
   *  UNHELD name has `ib_con_id IS NULL` (contract enrichment only ever walks
   *  held securities), and this id is what lets it ask TWS for one. */
  security_id: number | null;
  issuer_name: string | null;
}

/**
 * Every ARMED earnings event on the given dates — deliberately REGARDLESS of
 * `printed_at` (Codex #10). `printed_at` records that the paper worksheet was
 * physically printed; it is not a disarm signal, so the auto-print pass's
 * `printed_at IS NULL` filter (getUnprintedWorksheetEvents, above) is the
 * wrong input for the watcher: an armed event whose worksheet already printed
 * is exactly the event that is about to report.
 *
 * `con_id` prefers the security's IB contract id and falls back to the one
 * denormalized on the event row; `security_id` is the resolved securities row
 * (the watcher's handle for a TWS conId lookup when both are NULL) and
 * `issuer_name` feeds the watcher's document-to-event gate. The securities join resolves through
 * `security_id` first and only then by symbol, via a scalar subquery so a
 * duplicate symbol row can never fan this out into two rows per event.
 */
export function getArmedWorksheetEvents(
  db: Database.Database,
  dates: string[],
): ArmedWorksheetEventRow[] {
  if (dates.length === 0) return [];
  const placeholders = dates.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT f.event_id                              AS eventId,
              ce.symbol                               AS symbol,
              ce.event_date                           AS event_date,
              ce.event_type                           AS event_type,
              ce.event_time                           AS event_time,
              ce.raw_json                             AS raw_json,
              COALESCE(s.ib_con_id, ce.ib_con_id)     AS con_id,
              s.id                                    AS security_id,
              s.name                                  AS issuer_name
         FROM earnings_worksheet_flags f
         JOIN calendar_events ce ON ce.id = f.event_id
         LEFT JOIN securities s
                ON s.id = COALESCE(
                     ce.security_id,
                     (SELECT id FROM securities WHERE UPPER(symbol) = UPPER(ce.symbol) LIMIT 1)
                   )
        WHERE ce.event_date IN (${placeholders})
          AND COALESCE(ce.superseded, 0) = 0
          AND ce.event_type = 'earnings'
          AND ce.symbol IS NOT NULL
        ORDER BY ce.event_date, f.event_id`,
    )
    .all(...dates) as ArmedWorksheetEventRow[];
}

/** Armed, not-yet-printed flags joined to their events (auto-print pass input). */
export function getUnprintedWorksheetEvents(
  db: Database.Database,
): Array<{ eventId: number; symbol: string | null; event_date: string; release_time: string | null }> {
  return db
    .prepare(
      `SELECT f.event_id AS eventId, ce.symbol, ce.event_date, ce.release_time
         FROM earnings_worksheet_flags f
         JOIN calendar_events ce ON ce.id = f.event_id
        WHERE f.printed_at IS NULL
          AND COALESCE(ce.superseded, 0) = 0
          AND ce.event_type = 'earnings'
          AND ce.symbol IS NOT NULL`,
    )
    .all() as Array<{
    eventId: number;
    symbol: string | null;
    event_date: string;
    release_time: string | null;
  }>;
}

/** Event-scoped coverage fact (spec §4.1): a flag row exists for this event id. */
export function isEventArmed(db: Database.Database, eventId: number): boolean {
  return !!db.prepare(`SELECT 1 FROM earnings_worksheet_flags WHERE event_id = ?`).get(eventId);
}

export function getArmedEventIds(db: Database.Database, eventIds: number[]): Set<number> {
  const out = new Set<number>();
  if (eventIds.length === 0) return out;
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT event_id FROM earnings_worksheet_flags WHERE event_id IN (${placeholders})`)
    .all(...eventIds) as { event_id: number }[];
  for (const r of rows) out.add(r.event_id);
  return out;
}

/** Symbol-level display signal only (never an event decision): UPPERCASE symbols
 *  with an unsuperseded earnings event in [today, today + horizonDays] carrying a flag. */
export function getArmedSymbolsInHorizon(
  db: Database.Database,
  opts: { today: string; horizonDays?: number },
): Set<string> {
  const end = addDays(opts.today, opts.horizonDays ?? 14);
  const rows = db
    .prepare(
      `SELECT DISTINCT UPPER(ce.symbol) AS symbol
         FROM earnings_worksheet_flags f
         JOIN calendar_events ce ON ce.id = f.event_id
        WHERE ce.event_type = 'earnings'
          AND ce.symbol IS NOT NULL
          AND COALESCE(ce.superseded, 0) = 0
          AND ce.event_date BETWEEN ? AND ?`,
    )
    .all(opts.today, end) as { symbol: string }[];
  return new Set(rows.map((r) => r.symbol));
}

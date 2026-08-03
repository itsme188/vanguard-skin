import type Database from "better-sqlite3";

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
          AND COALESCE(ce.superseded, 0) = 0`,
    )
    .all() as Array<{
    eventId: number;
    symbol: string | null;
    event_date: string;
    release_time: string | null;
  }>;
}

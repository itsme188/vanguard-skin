import type Database from "better-sqlite3";

/**
 * Per-event worksheet flags (feedback #6): arming auto-prints the monospace
 * worksheet at the preview tick, exactly once (printed_at stamp). Mirrors
 * the earnings_email_skips CRUD shape.
 */

/** Arm the event's worksheet. Idempotent; returns true when newly armed. */
export function armWorksheet(db: Database.Database, eventId: number): boolean {
  const r = db
    .prepare(
      `INSERT INTO earnings_worksheet_flags (event_id) VALUES (?)
       ON CONFLICT(event_id) DO NOTHING`,
    )
    .run(eventId);
  return r.changes > 0;
}

/** Disarm (also clears the printed_at stamp — re-arming re-prints). */
export function disarmWorksheet(db: Database.Database, eventId: number): boolean {
  return db.prepare(`DELETE FROM earnings_worksheet_flags WHERE event_id = ?`).run(eventId)
    .changes > 0;
}

/** Stamp a completed print so the auto-pass never double-prints. */
export function stampWorksheetPrinted(db: Database.Database, eventId: number): void {
  db.prepare(
    `UPDATE earnings_worksheet_flags SET printed_at = datetime('now') WHERE event_id = ?`,
  ).run(eventId);
}

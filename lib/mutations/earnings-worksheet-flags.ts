import type Database from "better-sqlite3";
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";

/**
 * Per-event worksheet flags (feedback #6): arming auto-prints the monospace
 * worksheet at the preview tick, exactly once (printed_at stamp). Mirrors
 * the earnings_email_skips CRUD shape.
 *
 * Live print v2 slice A: arming/disarming is also the ONLY signal the
 * Cloudflare Worker gets about which events it may act on, so each flag change
 * appends the full armed projection to `cloud_outbox` in the SAME transaction
 * (D8 — these stay pure mutations otherwise; prepare-step rows are Task 9).
 */

/** Arm the event's worksheet. Idempotent; returns true when newly armed. */
export function armWorksheet(db: Database.Database, eventId: number): boolean {
  // [C-9] IMMEDIATE: the generation is allocated under the write lock, so two
  // connections (Electron server + a script, or the sweep + a route)
  // serialise on the busy timeout instead of colliding on
  // UNIQUE(kind, generation).
  return db
    .transaction(() => {
      const r = db
        .prepare(
          `INSERT INTO earnings_worksheet_flags (event_id) VALUES (?)
           ON CONFLICT(event_id) DO NOTHING`,
        )
        .run(eventId);
      if (r.changes > 0) writeArmedEventsOutboxRow(db);
      return r.changes > 0;
    })
    .immediate();
}

/** Disarm (also clears the printed_at stamp — re-arming re-prints). */
export function disarmWorksheet(db: Database.Database, eventId: number): boolean {
  return db
    .transaction(() => {
      const r = db
        .prepare(`DELETE FROM earnings_worksheet_flags WHERE event_id = ?`)
        .run(eventId);
      if (r.changes > 0) writeArmedEventsOutboxRow(db);
      return r.changes > 0;
    })
    .immediate();
}

/** Stamp a completed print so the auto-pass never double-prints. */
export function stampWorksheetPrinted(db: Database.Database, eventId: number): void {
  db.prepare(
    `UPDATE earnings_worksheet_flags SET printed_at = datetime('now') WHERE event_id = ?`,
  ).run(eventId);
}

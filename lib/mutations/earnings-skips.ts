import type Database from "better-sqlite3";

export type EarningsEmailPhase = "preview" | "recap";

/**
 * Mark a single (event, phase) pair as skipped. Idempotent: re-skipping the
 * same pair is a no-op (UNIQUE constraint guard via INSERT OR IGNORE).
 *
 * Returns true if a new skip row was inserted, false if it already existed.
 */
export function recordEarningsEmailSkip(
  db: Database.Database,
  eventId: number,
  phase: EarningsEmailPhase,
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO earnings_email_skips (event_id, phase)
       VALUES (?, ?)`,
    )
    .run(eventId, phase);
  return result.changes > 0;
}

/**
 * Undo a skip — used when the user changes their mind before the email
 * window closes. Returns true if a row was deleted.
 */
export function unrecordEarningsEmailSkip(
  db: Database.Database,
  eventId: number,
  phase: EarningsEmailPhase,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM earnings_email_skips
       WHERE event_id = ? AND phase = ?`,
    )
    .run(eventId, phase);
  return result.changes > 0;
}

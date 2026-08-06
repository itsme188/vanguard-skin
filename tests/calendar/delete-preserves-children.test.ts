import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { deleteUnenrichedEventsForWeek } from "@/lib/mutations/calendar";

function insertEvent(db: Database.Database, sourceKey: string): number {
  const r = db
    .prepare(
      `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, symbol)
       VALUES ('finnhub', ?, 'earnings', '2026-07-28', '2026-07-27', 'T earnings', 'T')`,
    )
    .run(sourceKey);
  return Number(r.lastInsertRowid);
}

describe("deleteUnenrichedEventsForWeek preserves rows with children", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("keeps events that have an earnings_emails audit row", () => {
    const kept = insertEvent(db, "finnhub:KEEP:2026-07-28");
    const gone = insertEvent(db, "finnhub:GONE:2026-07-28");
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient) VALUES (?, 'preview', 'x@y.com')`,
    ).run(kept);

    const deleted = deleteUnenrichedEventsForWeek(db, "2026-07-27", "finnhub");

    expect(deleted).toBe(1);
    expect(db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(kept)).toBeTruthy();
    expect(db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(gone)).toBeUndefined();
  });

  it("keeps events that have a skip row", () => {
    const kept = insertEvent(db, "finnhub:SKIP:2026-07-28");
    db.prepare(
      `INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, 'preview')`,
    ).run(kept);

    deleteUnenrichedEventsForWeek(db, "2026-07-27", "finnhub");

    expect(db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(kept)).toBeTruthy();
  });

  it("keeps events that have a bogey row", () => {
    const kept = insertEvent(db, "finnhub:BOGEY:2026-07-28");
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label) VALUES (?, 'manual', 'me')`,
    ).run(kept);

    deleteUnenrichedEventsForWeek(db, "2026-07-27", "finnhub");

    expect(db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(kept)).toBeTruthy();
  });

  it("keeps events with a stamped wire_probe_empty_at (bounding observation)", () => {
    // A stamped empty pre-release probe bounds a future wire-time
    // observation (migration 076). A mid-window manual "Refresh from
    // Finnhub" must not drop that stamp — losing it degrades the symbol's
    // release-time cascade honestly to unbounded, but discards a real probe.
    const kept = insertEvent(db, "finnhub:PROBED:2026-07-28");
    db.prepare(`UPDATE calendar_events SET wire_probe_empty_at = ? WHERE id = ?`).run(
      "2026-07-28T12:00:00.000Z",
      kept,
    );

    const deleted = deleteUnenrichedEventsForWeek(db, "2026-07-27", "finnhub");

    expect(deleted).toBe(0);
    expect(db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(kept)).toBeTruthy();
  });

  it("still deletes unprotected unenriched events", () => {
    const gone = insertEvent(db, "finnhub:UNPROTECTED:2026-07-28");

    const deleted = deleteUnenrichedEventsForWeek(db, "2026-07-27", "finnhub");

    expect(deleted).toBe(1);
    expect(db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(gone)).toBeUndefined();
  });
});

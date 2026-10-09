/**
 * Owner decision 2026-10-08 (qa: today's-releases week-ahead macro card, a
 * hand-saved actual on a pending macro release): actuals can be entered by
 * hand for earnings only. The refusal lives in saveManualActuals so every
 * caller (the actuals route, print-watch accept) gets it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { saveManualActuals } from "@/lib/earnings/actuals";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seed(eventType: string, symbol: string | null): number {
  return (
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, symbol, source_key)
         VALUES ('manual', ?, '2020-01-02', 'BMO', '07:00', 'Release', ?, ?) RETURNING id`,
      )
      .get(eventType, symbol, `k:${eventType}`) as { id: number }
  ).id;
}

describe("saveManualActuals event-type guard", () => {
  it("refuses a macro release with a plain 400 and writes nothing", () => {
    const id = seed("macro", null);
    const r = saveManualActuals(db, { eventId: id, epsActual: 1.2 });
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "Actuals can be entered by hand for earnings only.",
    });
    const row = db.prepare("SELECT actual_value, enriched_at, manual_actuals_at FROM calendar_events WHERE id = ?").get(id);
    expect(row).toEqual({ actual_value: null, enriched_at: null, manual_actuals_at: null });
  });

  it("refuses even with force", () => {
    const id = seed("economic", null);
    const r = saveManualActuals(db, { eventId: id, epsActual: 1.2, force: true });
    expect(r.ok).toBe(false);
  });

  it("still saves for an earnings row", () => {
    const id = seed("earnings", "ZZA");
    const r = saveManualActuals(db, { eventId: id, epsActual: 1.2 });
    expect(r.ok).toBe(true);
  });
});

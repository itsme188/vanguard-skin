/**
 * buildBogeyEventMatchMap — the upload fan-out's candidate set, carrying the
 * event's own symbol and date so the outcome can NAME what it wrote to
 * (qa: upload match-success-unnamed-off-week-invisible).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildBogeyEventMap, buildBogeyEventMatchMap } from "@/lib/queries/bogey-event-match";

let db: Database.Database;

function insertEvent(symbol: string, date: string, superseded = 0, source = "finnhub"): number {
  const info = db
    .prepare(
      `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, symbol, superseded, title)
       VALUES (?, ?, 'earnings', ?, ?, ?, ?, ?)`,
    )
    .run(source, `${source}:${symbol}:${date}`, date, date, symbol, superseded, `${symbol} earnings`);
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("buildBogeyEventMatchMap", () => {
  it("returns the event's own symbol and date with its id", () => {
    const id = insertEvent("aaa", "2026-09-07");
    const map = buildBogeyEventMatchMap(db, "2026-08-28", "2026-09-10");
    expect(map.get("AAA")).toEqual({ eventId: id, symbol: "aaa", eventDate: "2026-09-07" });
  });

  it("skips superseded rows and rows outside the window, exactly like the id map", () => {
    insertEvent("AAA", "2026-09-01", 1);
    const live = insertEvent("AAA", "2026-09-02", 0, "manual");
    insertEvent("ZZZ", "2026-09-20");
    const named = buildBogeyEventMatchMap(db, "2026-08-28", "2026-09-10");
    const ids = buildBogeyEventMap(db, "2026-08-28", "2026-09-10");
    expect([...named.keys()]).toEqual(["AAA"]);
    expect(named.get("AAA")?.eventId).toBe(live);
    expect([...ids.entries()]).toEqual([...named.entries()].map(([k, v]) => [k, v.eventId]));
  });
});

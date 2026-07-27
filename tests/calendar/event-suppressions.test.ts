/**
 * Calendar event suppressions (migration 070) — user correction path for a
 * WRONG sync-sourced earnings date (the NET case: Finnhub carried 2026-07-30,
 * the real date was Aug 6, and the 403-guarded API left no way to remove it —
 * even a raw delete would be re-inserted by the next sweep's deterministic
 * source_key).
 *
 * Deleting a sync-owned earnings row now records a (symbol, event_date,
 * event_type) suppression, and upsertCalendarEvents — the single choke point
 * every sync source (finnhub, nasdaq, wsh, claude_macro) flows through —
 * skips matching non-manual events. Keyed on the semantic tuple, NOT
 * source_key, so Finnhub AND Nasdaq are both blocked from re-inserting the
 * same wrong date.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  upsertCalendarEvents,
  insertCalendarEvent,
  suppressCalendarEvent,
  deleteAndSuppressCalendarEvent,
  type CalendarEventInput,
} from "@/lib/mutations/calendar";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function finnhubEvent(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return {
    source: "finnhub",
    event_type: "earnings",
    event_date: "2026-07-30",
    event_time: "AMC",
    title: "NET Q2 Earnings",
    symbol: "NET",
    source_key: "finnhub:NET:2026-07-30",
    week_of: "2026-07-27",
    ...overrides,
  } as CalendarEventInput;
}

function eventCount(symbol: string, date: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM calendar_events WHERE symbol = ? AND event_date = ?",
      )
      .get(symbol, date) as { n: number }
  ).n;
}

describe("suppressCalendarEvent + upsertCalendarEvents", () => {
  it("skips a suppressed (symbol, date, type) tuple during sync upsert", () => {
    suppressCalendarEvent(db, {
      symbol: "NET",
      event_date: "2026-07-30",
      event_type: "earnings",
    });

    const result = upsertCalendarEvents(db, [finnhubEvent()]);

    expect(result.inserted).toBe(0);
    expect(eventCount("NET", "2026-07-30")).toBe(0);
  });

  it("still inserts the same symbol on a DIFFERENT date (the corrected one)", () => {
    suppressCalendarEvent(db, {
      symbol: "NET",
      event_date: "2026-07-30",
      event_type: "earnings",
    });

    const result = upsertCalendarEvents(db, [
      finnhubEvent({
        event_date: "2026-08-06",
        source_key: "finnhub:NET:2026-08-06",
        week_of: "2026-08-03",
      }),
    ]);

    expect(result.inserted).toBe(1);
    expect(eventCount("NET", "2026-08-06")).toBe(1);
  });

  it("blocks a DIFFERENT sync source re-inserting the same wrong date (nasdaq)", () => {
    suppressCalendarEvent(db, {
      symbol: "NET",
      event_date: "2026-07-30",
      event_type: "earnings",
    });

    const result = upsertCalendarEvents(db, [
      finnhubEvent({ source: "nasdaq", source_key: "nasdaq:NET:2026-07-30" }),
    ]);

    expect(result.inserted).toBe(0);
    expect(eventCount("NET", "2026-07-30")).toBe(0);
  });

  it("matches symbols case-insensitively", () => {
    suppressCalendarEvent(db, {
      symbol: "net",
      event_date: "2026-07-30",
      event_type: "earnings",
    });

    const result = upsertCalendarEvents(db, [finnhubEvent()]);
    expect(result.inserted).toBe(0);
  });

  it("is idempotent — suppressing the same tuple twice does not throw", () => {
    const tuple = { symbol: "NET", event_date: "2026-07-30", event_type: "earnings" };
    suppressCalendarEvent(db, tuple);
    expect(() => suppressCalendarEvent(db, tuple)).not.toThrow();
  });

  it("does NOT block manual insertCalendarEvent (an explicit user action wins)", () => {
    suppressCalendarEvent(db, {
      symbol: "NET",
      event_date: "2026-07-30",
      event_type: "earnings",
    });

    const { id } = insertCalendarEvent(db, {
      symbol: "NET",
      event_date: "2026-07-30",
      event_type: "earnings",
      event_time: "AMC",
      week_of: "2026-07-27",
    });

    expect(id).toBeGreaterThan(0);
    expect(eventCount("NET", "2026-07-30")).toBe(1);
  });

  it("tolerates a DB without the suppressions table (minimal test DBs)", () => {
    db.exec("DROP TABLE calendar_event_suppressions");
    const result = upsertCalendarEvents(db, [finnhubEvent()]);
    expect(result.inserted).toBe(1);
  });
});

describe("deleteAndSuppressCalendarEvent", () => {
  it("deletes the sync-owned row AND blocks the next sync from re-inserting it", () => {
    upsertCalendarEvents(db, [finnhubEvent()]);
    const row = db
      .prepare("SELECT id FROM calendar_events WHERE source_key = ?")
      .get("finnhub:NET:2026-07-30") as { id: number };

    const result = deleteAndSuppressCalendarEvent(db, row.id);

    expect(result.deleted).toBe(true);
    expect(result.suppressed).toEqual({
      symbol: "NET",
      event_date: "2026-07-30",
      event_type: "earnings",
    });
    expect(eventCount("NET", "2026-07-30")).toBe(0);

    // The next sync sweep re-produces the same event — it must NOT come back.
    const resync = upsertCalendarEvents(db, [finnhubEvent()]);
    expect(resync.inserted).toBe(0);
    expect(eventCount("NET", "2026-07-30")).toBe(0);
  });

  it("returns deleted:false for a missing id", () => {
    const result = deleteAndSuppressCalendarEvent(db, 99999);
    expect(result.deleted).toBe(false);
    expect(result.suppressed).toBe(null);
  });

  it("refuses to suppress a symbol-less event (macro rows are not correctable this way)", () => {
    upsertCalendarEvents(db, [
      finnhubEvent({
        source: "claude_macro",
        symbol: null,
        title: "CPI",
        event_type: "cpi",
        source_key: "fred:10:2026-07-30",
      }),
    ]);
    const row = db
      .prepare("SELECT id FROM calendar_events WHERE source_key = ?")
      .get("fred:10:2026-07-30") as { id: number };

    expect(() => deleteAndSuppressCalendarEvent(db, row.id)).toThrow(/symbol/i);
  });
});

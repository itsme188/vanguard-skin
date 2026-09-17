import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  insertCalendarEvent,
  updateCalendarEvent,
  deleteAndSuppressCalendarEvent,
} from "@/lib/mutations/calendar";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { readArmedGeneration } from "@/lib/earnings/armed-events-projection";
import { todayET, addDays, getCurrentMonday } from "@/lib/calendar/date-utils";

// The armed-events projection (lib/earnings/armed-events-projection.ts,
// LIVE_LOOKBACK_DAYS = 14) drops any armed entry whose event_date is older
// than today - 14 ET days. Fixture dates must therefore track the real
// clock, not a hardcoded date — see docs/reference/data-integrity.md on
// wall-clock-stale fixtures.
const TODAY = todayET();
const TOMORROW = addDays(TODAY, 1);
const WEEK_OF = getCurrentMonday();

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const addManual = (symbol: string, date: string) =>
  insertCalendarEvent(db, {
    symbol,
    event_date: date,
    event_time: "AMC",
    release_time: "16:15",
    week_of: WEEK_OF,
  }).id;

const latestEntries = () => {
  const row = db
    .prepare(`SELECT payload_json FROM cloud_outbox ORDER BY generation DESC LIMIT 1`)
    .get() as { payload_json: string } | undefined;
  return row ? (JSON.parse(row.payload_json).entries as Array<Record<string, unknown>>) : [];
};

describe("manual calendar event mutations → armed-events outbox", () => {
  it("inserting a manual event writes no outbox row (a fresh row is never armed)", () => {
    addManual("ACME", TODAY);
    expect(readArmedGeneration(db)).toBe(0);
  });

  it("editing an ARMED manual event's release_time adds one outbox row carrying the new time", () => {
    const id = addManual("ACME", TODAY);
    armWorksheet(db, id); // gen 1
    expect(updateCalendarEvent(db, { id, release_time: "16:45" })).toBe(true);
    expect(readArmedGeneration(db)).toBe(2);
    expect(latestEntries()).toEqual([
      expect.objectContaining({ eventId: id, releaseTime: "16:45" }),
    ]);
  });

  it("editing an UNARMED manual event adds no outbox row", () => {
    const id = addManual("BETA", TOMORROW);
    expect(updateCalendarEvent(db, { id, release_time: "16:45" })).toBe(true);
    expect(readArmedGeneration(db)).toBe(0);
  });

  it("a no-op edit of an armed event adds no outbox row (D10)", () => {
    const id = addManual("ACME", TODAY);
    armWorksheet(db, id); // gen 1
    expect(updateCalendarEvent(db, { id })).toBe(true); // no fields → early return
    expect(updateCalendarEvent(db, { id, release_time: "16:15" })).toBe(true); // same value
    expect(readArmedGeneration(db)).toBe(1);
  });
});

describe("deleteAndSuppressCalendarEvent → armed-events outbox", () => {
  const seedSync = (symbol: string, date: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, source_key, symbol)
           VALUES ('finnhub','earnings',?,'AMC','16:15',?,?,?)`,
        )
        .run(date, `${symbol} earnings`, `finnhub:${symbol}:${date}`, symbol).lastInsertRowid,
    );

  // Armed worksheets mostly sit on SYNC-sourced rows (Finnhub/WSH), and the
  // calendar-events DELETE route sends those down the suppress branch — so
  // this, not deleteCalendarEvent, is the common way an armed event goes away.
  it("[C-7] deleting an ARMED sync-sourced event writes a tombstone generation", () => {
    const id = seedSync("ACME", TODAY);
    armWorksheet(db, id); // gen 1
    const res = deleteAndSuppressCalendarEvent(db, id, { today: TODAY });
    expect(res.deleted).toBe(true);
    expect(readArmedGeneration(db)).toBe(2);
    expect(latestEntries()).toEqual([
      expect.objectContaining({ eventId: id, symbol: "ACME", removed: true }),
    ]);
  });

  it("deleting an UNARMED sync-sourced event writes no outbox row", () => {
    const id = seedSync("BETA", TOMORROW);
    expect(deleteAndSuppressCalendarEvent(db, id, { today: TODAY }).deleted).toBe(true);
    expect(readArmedGeneration(db)).toBe(0);
  });
});

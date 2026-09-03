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
    week_of: "2026-08-31",
  }).id;

const latestEntries = () => {
  const row = db
    .prepare(`SELECT payload_json FROM cloud_outbox ORDER BY generation DESC LIMIT 1`)
    .get() as { payload_json: string } | undefined;
  return row ? (JSON.parse(row.payload_json).entries as Array<Record<string, unknown>>) : [];
};

describe("manual calendar event mutations → armed-events outbox", () => {
  it("inserting a manual event writes no outbox row (a fresh row is never armed)", () => {
    addManual("ACME", "2026-09-02");
    expect(readArmedGeneration(db)).toBe(0);
  });

  it("editing an ARMED manual event's release_time adds one outbox row carrying the new time", () => {
    const id = addManual("ACME", "2026-09-02");
    armWorksheet(db, id); // gen 1
    expect(updateCalendarEvent(db, { id, release_time: "16:45" })).toBe(true);
    expect(readArmedGeneration(db)).toBe(2);
    expect(latestEntries()).toEqual([
      expect.objectContaining({ eventId: id, releaseTime: "16:45" }),
    ]);
  });

  it("editing an UNARMED manual event adds no outbox row", () => {
    const id = addManual("BETA", "2026-09-03");
    expect(updateCalendarEvent(db, { id, release_time: "16:45" })).toBe(true);
    expect(readArmedGeneration(db)).toBe(0);
  });

  it("a no-op edit of an armed event adds no outbox row (D10)", () => {
    const id = addManual("ACME", "2026-09-02");
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
    const id = seedSync("ACME", "2026-09-02");
    armWorksheet(db, id); // gen 1
    const res = deleteAndSuppressCalendarEvent(db, id, { today: "2026-09-02" });
    expect(res.deleted).toBe(true);
    expect(readArmedGeneration(db)).toBe(2);
    expect(latestEntries()).toEqual([
      expect.objectContaining({ eventId: id, symbol: "ACME", removed: true }),
    ]);
  });

  it("deleting an UNARMED sync-sourced event writes no outbox row", () => {
    const id = seedSync("BETA", "2026-09-03");
    expect(deleteAndSuppressCalendarEvent(db, id, { today: "2026-09-02" }).deleted).toBe(true);
    expect(readArmedGeneration(db)).toBe(0);
  });
});

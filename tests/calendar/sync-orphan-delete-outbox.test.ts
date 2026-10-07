/**
 * A sync orphan delete reaches the cloud.
 *
 * "The vendor moved the date": the sync deletes the old row and writes a row
 * with a new id on the new date. The cloud's 2 AM snapshot still lists the old
 * id, so it must be published as a removed event in the same transaction —
 * otherwise the Worker can still email for a print date that no longer exists.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { replaceWeekRowsPublishingRemovals } from "@/lib/calendar/sync";
import {
  deleteEventsForWeek,
  deleteUnenrichedEventsForWeek,
  type CalendarEventInput,
  type DeletedEarningsRow,
} from "@/lib/mutations/calendar";
import { todayET, addDays, mondayOf } from "@/lib/calendar/date-utils";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// Inside the 14-day live window on every run, and all in ONE week.
const WEEK = mondayOf(todayET());
const D1 = addDays(WEEK, 1);
const D2 = addDays(WEEK, 3);

const input = (symbol: string, date: string, source: "finnhub" | "nasdaq" = "finnhub"): CalendarEventInput =>
  ({
    source,
    event_type: "earnings",
    event_date: date,
    event_time: "AMC",
    title: `${symbol} earnings`,
    source_key: `${source}:${symbol}:${date}`,
    symbol,
    week_of: WEEK,
  }) as CalendarEventInput;

const seed = (symbol: string, date: string, eventType = "earnings", source = "finnhub") =>
  Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, source_key, symbol, week_of)
         VALUES (?, ?, ?, 'AMC', ?, ?, ?, ?)`,
      )
      .run(source, eventType, date, `${symbol} ${eventType}`, `${source}:${symbol}:${date}`, symbol, WEEK)
      .lastInsertRowid,
  );

const outbox = () =>
  (
    db.prepare(`SELECT generation, payload_json FROM cloud_outbox ORDER BY generation`).all() as Array<{
      generation: number;
      payload_json: string;
    }>
  ).map((r) => JSON.parse(r.payload_json) as { removedEventIds: Array<{ id: number; eventDate: string }> });

describe("sync orphan deletes are published to the armed-events outbox", () => {
  it("a vendor date move publishes the OLD id as removed, in one generation", () => {
    const old = seed("AAA", D1);
    replaceWeekRowsPublishingRemovals(db, WEEK, "finnhub", [input("AAA", D2)]);

    expect(db.prepare(`SELECT event_date FROM calendar_events WHERE symbol = 'AAA'`).all()).toEqual([
      { event_date: D2 },
    ]);
    const payloads = outbox();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].removedEventIds).toEqual([
      { id: old, eventDate: D1, removedAt: expect.any(String) },
    ]);
  });

  it("a row the vendor dropped altogether is published; a re-listed row on the same date is NOT", () => {
    const dropped = seed("AAA", D1);
    const relisted = seed("BBB", D1);
    replaceWeekRowsPublishingRemovals(db, WEEK, "finnhub", [input("BBB", D1)]);

    const newId = (db.prepare(`SELECT id FROM calendar_events WHERE symbol = 'BBB'`).get() as { id: number }).id;
    expect(newId).not.toBe(relisted); // the cleanup really did re-create it
    const payloads = outbox();
    expect(payloads).toHaveLength(1);
    // BBB's print still stands on the same date: silencing its old id would
    // stop the cloud emailing for a re-listed name on every refresh.
    expect(payloads[0].removedEventIds.map((r) => r.id)).toEqual([dropped]);
  });

  it("a refresh that re-lists everything writes no outbox row at all", () => {
    seed("AAA", D1);
    seed("BBB", D2);
    replaceWeekRowsPublishingRemovals(db, WEEK, "finnhub", [input("AAA", D1), input("BBB", D2)]);
    expect(outbox()).toEqual([]);
  });

  it("only earnings rows are published; the delete itself is unchanged", () => {
    const macro = seed("CPI", D1, "economic", "claude_macro");
    const earn = seed("AAA", D1, "earnings", "claude_macro");
    replaceWeekRowsPublishingRemovals(db, WEEK, "claude_macro", [], []);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM calendar_events`).get()).toEqual({ n: 0 });
    expect(outbox()[0].removedEventIds.map((r) => r.id)).toEqual([earn]);
    expect(outbox()[0].removedEventIds.map((r) => r.id)).not.toContain(macro);
  });

  it("a protected (enriched) row is neither deleted nor published", () => {
    const kept = seed("AAA", D1);
    db.prepare(`UPDATE calendar_events SET enriched_at = datetime('now') WHERE id = ?`).run(kept);
    replaceWeekRowsPublishingRemovals(db, WEEK, "finnhub", []);
    expect(db.prepare(`SELECT id FROM calendar_events`).all()).toEqual([{ id: kept }]);
    expect(outbox()).toEqual([]);
  });

  it("delete, upsert and publish are one transaction: a failed upsert leaves the old row and no outbox row", () => {
    const old = seed("AAA", D1);
    const broken = { ...input("AAA", D2), event_type: null } as unknown as CalendarEventInput;
    expect(() => replaceWeekRowsPublishingRemovals(db, WEEK, "finnhub", [broken])).toThrow();
    expect(db.prepare(`SELECT id FROM calendar_events`).all()).toEqual([{ id: old }]);
    expect(outbox()).toEqual([]);
  });
});

describe("deleteUnenrichedEventsForWeek — the deleted-earnings collector", () => {
  it("reports exactly the earnings rows the delete removed, keep list honoured, same count as before", () => {
    const gone = seed("AAA", D1);
    const kept = seed("BBB", D1);
    seed("CPI", D2, "economic");
    const collected: DeletedEarningsRow[] = [];
    const n = deleteUnenrichedEventsForWeek(db, WEEK, "finnhub", [`finnhub:BBB:${D1}`], collected);
    expect(n).toBe(2);
    expect(collected).toEqual([{ id: gone, eventDate: D1, sourceKey: `finnhub:AAA:${D1}` }]);
    expect(db.prepare(`SELECT id FROM calendar_events`).all()).toEqual([{ id: kept }]);
    // It never publishes by itself — the caller owns that.
    expect(outbox()).toEqual([]);
  });
});

describe("deleteEventsForWeek publishes the earnings rows it deletes", () => {
  it("one generation carrying every deleted earnings id; other event types are not listed", () => {
    const a = seed("AAA", D1);
    const b = seed("BBB", D2, "earnings", "nasdaq");
    seed("CPI", D1, "economic", "claude_macro");
    expect(deleteEventsForWeek(db, WEEK)).toBe(3);
    const payloads = outbox();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].removedEventIds.map((r) => r.id)).toEqual([a, b]);
  });

  it("a week with no earnings rows writes no outbox row", () => {
    seed("CPI", D1, "economic", "claude_macro");
    expect(deleteEventsForWeek(db, WEEK, "claude_macro")).toBe(1);
    expect(outbox()).toEqual([]);
  });
});

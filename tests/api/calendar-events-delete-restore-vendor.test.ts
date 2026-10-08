/**
 * DELETE /api/calendar/events with `restoreVendorDate`
 * (qa:today-earningshub-fix-date--suppression-row-delete-loses-coverage-permanently).
 *
 * Owner ruling 2026-09-02, option 2: removing a row that "Fix date" minted
 * may also lift the suppression that correction left on the vendor's original
 * date; a plain remove keeps its old meaning. Symbols are synthetic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, mondayOf, todayET } from "@/lib/calendar/date-utils";
import {
  correctEarningsEventDate,
  upsertCalendarEvents,
  type CalendarEventInput,
} from "@/lib/mutations/calendar";
import { DELETE } from "@/app/api/calendar/events/route";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// Always future, never wall-clock stale.
const vendorDate = mondayOf(addDays(todayET(), 7));
const correctedDate = addDays(vendorDate, 1);

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  delete process.env.WORKER_MARKER_URL;
  delete process.env.CRON_SHARED_SECRET;
});

function vendorEvent(symbol: string, date: string): CalendarEventInput {
  return {
    source: "finnhub",
    event_type: "earnings",
    event_date: date,
    title: `${symbol} earnings`,
    symbol,
    source_key: `finnhub:${symbol}:${date}:earnings`,
    week_of: mondayOf(date),
    raw_json: "{}",
  };
}

/** Vendor row on vendorDate, then "Fix date" to correctedDate. Returns the minted row id. */
function fixDate(symbol: string): number {
  upsertCalendarEvents(hoisted.db, [vendorEvent(symbol, vendorDate)]);
  const result = correctEarningsEventDate(hoisted.db, {
    symbol,
    wrongDate: vendorDate,
    correctDate: correctedDate,
  });
  expect(result.ok).toBe(true);
  return result.newEventId as number;
}

function del(body: unknown): Promise<Response> {
  return DELETE(
    new Request("http://test/api/calendar/events", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function suppressions(symbol: string): string[] {
  return (
    hoisted.db
      .prepare("SELECT event_date FROM calendar_event_suppressions WHERE symbol = ? ORDER BY event_date")
      .all(symbol) as { event_date: string }[]
  ).map((r) => r.event_date);
}

function eventDates(symbol: string): string[] {
  return (
    hoisted.db
      .prepare("SELECT event_date FROM calendar_events WHERE symbol = ? ORDER BY event_date")
      .all(symbol) as { event_date: string }[]
  ).map((r) => r.event_date);
}

describe("DELETE /api/calendar/events — a row that Fix date minted", () => {
  it("plain remove keeps its meaning: the row goes, the vendor date stays suppressed", async () => {
    const id = fixDate("ZZA");
    expect(suppressions("ZZA")).toEqual([vendorDate]);

    const res = await del({ id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(eventDates("ZZA")).toEqual([]);
    expect(suppressions("ZZA")).toEqual([vendorDate]);

    // The stranded state the finding describes: a sync cannot bring it back.
    upsertCalendarEvents(hoisted.db, [vendorEvent("ZZA", vendorDate)]);
    expect(eventDates("ZZA")).toEqual([]);
  });

  it("restoreVendorDate lifts that one suppression, so the next sync restores the vendor date", async () => {
    const id = fixDate("ZZA");
    // Another company's suppression on the same date must survive.
    fixDate("ZZB");

    const res = await del({ id, restoreVendorDate: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, vendorDate, suppressionsLifted: 1 });
    expect(eventDates("ZZA")).toEqual([]);
    expect(suppressions("ZZA")).toEqual([]);
    expect(suppressions("ZZB")).toEqual([vendorDate]);

    upsertCalendarEvents(hoisted.db, [vendorEvent("ZZA", vendorDate)]);
    expect(eventDates("ZZA")).toEqual([vendorDate]);
  });

  it("refuses restoreVendorDate on a plain manual row and removes nothing", async () => {
    const id = hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of, raw_json)
         VALUES ('manual', 'earnings', ?, 'ZZC earnings', 'ZZC', ?, ?, '{}')`,
      )
      .run(correctedDate, `manual:ZZC:${correctedDate}:earnings`, mondayOf(correctedDate))
      .lastInsertRowid as number;

    const res = await del({ id, restoreVendorDate: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/not a corrected earnings date/);
    expect(eventDates("ZZC")).toEqual([correctedDate]);
  });

  it("refuses restoreVendorDate on a vendor row and removes nothing", async () => {
    upsertCalendarEvents(hoisted.db, [vendorEvent("ZZD", vendorDate)]);
    const row = hoisted.db.prepare("SELECT id FROM calendar_events WHERE symbol = 'ZZD'").get() as {
      id: number;
    };
    const res = await del({ id: row.id, restoreVendorDate: true });
    expect(res.status).toBe(400);
    expect(eventDates("ZZD")).toEqual([vendorDate]);
    expect(suppressions("ZZD")).toEqual([]);
  });
});

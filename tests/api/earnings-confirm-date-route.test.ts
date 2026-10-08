/**
 * HTTP-boundary tests for POST /api/earnings/confirm-date.
 *
 * (qa:api-earnings-confirm-date-alerts-conflict-confirm-vs-earningshub-
 * confirming-a-date-for-a-symbol-with-two-rows-): with two hand-entered rows
 * for one name on different dates, confirming one date must leave THAT row
 * visible and locked, and the answer names it by id. The other row's date and
 * slot are never rewritten.
 *
 * Also pins the standard envelope: `{success:true,data}` / `{success:false,error}`.
 *
 * Dates derive from todayET() so the fixture never goes wall-clock stale.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, mondayOf, todayET } from "@/lib/calendar/date-utils";
import { POST } from "@/app/api/earnings/confirm-date/route";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const earlier = addDays(mondayOf(addDays(todayET(), 7)), 3);
const later = addDays(earlier, 1);

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  delete process.env.WORKER_MARKER_URL;
  delete process.env.CRON_SHARED_SECRET;
});

function seedManualRow(symbol: string, date: string, slot: string, time: string): number {
  return hoisted.db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol, source_key, week_of)
       VALUES ('manual', 'earnings', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      date,
      slot,
      time,
      `${symbol} earnings (Manual entry)`,
      symbol,
      `manual:${symbol}:${date}:earnings`,
      mondayOf(date),
    ).lastInsertRowid as number;
}

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/earnings/confirm-date", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

interface Row {
  id: number;
  event_date: string;
  event_time: string | null;
  date_status: string | null;
  superseded: number;
}
function rowById(id: number): Row {
  return hoisted.db
    .prepare(
      "SELECT id, event_date, event_time, date_status, COALESCE(superseded, 0) AS superseded FROM calendar_events WHERE id = ?",
    )
    .get(id) as Row;
}

describe("POST /api/earnings/confirm-date — two rows for one symbol", () => {
  it("confirming the LATER date locks the later row, by id, and leaves it visible", async () => {
    const earlierId = seedManualRow("AAA", earlier, "BMO", "08:00");
    const laterId = seedManualRow("AAA", later, "AMC", "16:10");

    const res = await post({ symbol: "AAA", confirmedDate: later, confirmedTime: "amc" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { eventId: laterId, eventDate: later } });

    const confirmed = rowById(laterId);
    expect(confirmed.event_date).toBe(later);
    expect(confirmed.date_status).toBe("user_confirmed");
    expect(confirmed.superseded).toBe(0);

    // The other row keeps the date and slot the user typed for it.
    const other = rowById(earlierId);
    expect(other.event_date).toBe(earlier);
    expect(other.event_time).toBe("BMO");
    // No third row was minted.
    const n = hoisted.db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get() as { n: number };
    expect(n.n).toBe(2);
  });

  it("confirming the EARLIER date locks the earlier row, by id", async () => {
    const earlierId = seedManualRow("AAA", earlier, "BMO", "08:00");
    const laterId = seedManualRow("AAA", later, "AMC", "16:10");

    const res = await post({ symbol: "aaa", confirmedDate: earlier, confirmedTime: "bmo" });
    const body = await res.json();
    expect(body.data.eventId).toBe(earlierId);
    expect(rowById(earlierId).superseded).toBe(0);
    expect(rowById(laterId).event_date).toBe(later);
  });

  it("a confirmed date beside a vendor row supersedes the vendor row, not the confirmed one", async () => {
    const vendorId = hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of, raw_json)
         VALUES ('finnhub', 'earnings', ?, 'AAA earnings', 'AAA', ?, ?, '{}')`,
      )
      .run(earlier, `finnhub:AAA:${earlier}:earnings`, mondayOf(earlier)).lastInsertRowid as number;

    const res = await post({ symbol: "AAA", confirmedDate: later, confirmedTime: "amc" });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.eventId).not.toBe(vendorId);
    expect(rowById(body.data.eventId).event_date).toBe(later);
    expect(rowById(body.data.eventId).superseded).toBe(0);
    expect(rowById(vendorId).superseded).toBe(1);
  });
});

describe("POST /api/earnings/confirm-date — envelope", () => {
  it("400s carry success:false and a message, and write nothing", async () => {
    for (const body of [
      { confirmedDate: later },
      { symbol: "AAA", confirmedDate: "next week" },
      { symbol: "!!!@@@ 123", confirmedDate: later },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(typeof json.error).toBe("string");
      expect(json).not.toHaveProperty("ok");
    }
    const n = hoisted.db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("a refused date is a 409 with success:false and the mutation's own words", async () => {
    const res = await post({ symbol: "AAA", confirmedDate: addDays(todayET(), -3) });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toMatch(/in the past/);
  });
});

describe("EarningsDateChip confirm handler reads the envelope", () => {
  it("treats a 2xx without success:true as a failure", async () => {
    const { readFileSync } = await import("node:fs");
    const { anchorIndex } = await import("@/tests/helpers/source-anchor");
    const src = readFileSync("app/dashboard/today/EarningsDateChip.tsx", "utf8");
    const start = anchorIndex(src, 'apiFetch("/api/earnings/confirm-date"');
    const end = anchorIndex(src, "onConfirmed?.();", start);
    const handler = src.slice(start, end);
    expect(handler).toContain("!res.ok || body?.success !== true");
  });
});

/**
 * HTTP-boundary tests for POST /api/earnings/confirm-date.
 *
 * (qa:api-earnings-confirm-date-alerts-conflict-confirm-vs-earningshub-
 * confirming-a-date-for-a-symbol-with-two-rows-): with two hand-entered rows
 * for one name on different dates, confirming one date must leave THAT row
 * visible and locked, and the answer names it by id. The other row's date and
 * slot are never rewritten.
 *
 * Owner ruling 2026-10-08: one hand-entered row per upcoming print. The other
 * row of such a pair is now folded into the confirmed one and deleted (it
 * used to stay showing), a lone hand-entered row on another date is moved,
 * and several such rows produce a notice.
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
    expect(body).toEqual({
      success: true,
      data: { eventId: laterId, eventDate: later, deletedEventId: earlierId },
    });

    const confirmed = rowById(laterId);
    expect(confirmed.event_date).toBe(later);
    expect(confirmed.date_status).toBe("user_confirmed");
    expect(confirmed.superseded).toBe(0);

    // The other row had nothing attached, so it is gone (ruling 2026-10-08):
    // one hand-entered row for the print, and no third row was minted.
    expect(rowById(earlierId)).toBeUndefined();
    const n = hoisted.db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("confirming the EARLIER date locks the earlier row, by id", async () => {
    const earlierId = seedManualRow("AAA", earlier, "BMO", "08:00");
    const laterId = seedManualRow("AAA", later, "AMC", "16:10");

    const res = await post({ symbol: "aaa", confirmedDate: earlier, confirmedTime: "bmo" });
    const body = await res.json();
    expect(body.data.eventId).toBe(earlierId);
    expect(body.data.deletedEventId).toBe(laterId);
    expect(rowById(earlierId).superseded).toBe(0);
    expect(rowById(earlierId).event_date).toBe(earlier);
    expect(rowById(laterId)).toBeUndefined();
  });

  it("a record still attached to the other row keeps it hidden, and the answer says so", async () => {
    const earlierId = seedManualRow("AAA", earlier, "BMO", "08:00");
    const laterId = seedManualRow("AAA", later, "AMC", "16:10");
    // A preview sent long before the confirmed date stays on the old row.
    hoisted.db
      .prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at)
         VALUES (?, 'preview', 'desk@example.com', ?)`,
      )
      .run(earlierId, `${addDays(todayET(), -20)} 12:00:00`);

    const res = await post({ symbol: "AAA", confirmedDate: later, confirmedTime: "amc" });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.eventId).toBe(laterId);
    expect(body.data.foldedEventId).toBe(earlierId);
    expect(body.data).not.toHaveProperty("deletedEventId");
    expect(body.data.note).toMatch(/hidden, not deleted/);
    // The user-facing sentence travels in `notice` (the conflict marker shows it).
    expect(body.data.notice).toBe(
      `AAA still has an entry on ${earlier} because a preview email was already sent for it. Remove that entry if you no longer want it.`,
    );
    expect(rowById(earlierId).superseded).toBe(1);
  });

  it("one hand-entered row on another date is MOVED: same id, confirmed date, no second row", async () => {
    const id = seedManualRow("AAA", earlier, "AMC", "16:10");

    const res = await post({ symbol: "AAA", confirmedDate: later, confirmedTime: "amc" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { eventId: id, eventDate: later, movedEventId: id },
    });
    const moved = rowById(id);
    expect(moved.event_date).toBe(later);
    expect(moved.date_status).toBe("user_confirmed");
    expect(moved.superseded).toBe(0);
    const n = hoisted.db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("several hand-entered rows on other dates: nothing moves and the answer carries a notice", async () => {
    const a = seedManualRow("AAA", earlier, "AMC", "16:10");
    const b = seedManualRow("AAA", addDays(later, 1), "AMC", "16:10");

    const res = await post({ symbol: "AAA", confirmedDate: later, confirmedTime: "amc" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.notice).toMatch(/several hand-entered dates/);
    expect(body.data).not.toHaveProperty("movedEventId");
    expect(rowById(a).event_date).toBe(earlier);
    expect(rowById(b).event_date).toBe(addDays(later, 1));
    expect(rowById(body.data.eventId).event_date).toBe(later);
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

/**
 * HTTP-boundary tests for the typed-input checks on the calendar routes
 * (qa:today-earningshub-add-ticker--any-string-accepted-as-ticker-creates-junk-event):
 * POST/PATCH /api/calendar/events and POST /api/earnings/correct-date refuse
 * text that cannot be a ticker and dates outside 2000 .. today + 2 years, and
 * write nothing when they refuse.
 *
 * Dates derive from todayET() so the fixture never goes wall-clock stale.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, mondayOf, todayET } from "@/lib/calendar/date-utils";
import { POST, PATCH } from "@/app/api/calendar/events/route";
import { POST as CORRECT_DATE } from "@/app/api/earnings/correct-date/route";
import { tickerShapeError, manualEventDateError } from "@/lib/calendar/manual-event-input";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const nextWeek = addDays(mondayOf(addDays(todayET(), 7)), 2);
const tooFar = addDays(todayET(), 365 * 2 + 1);
const atLimit = addDays(todayET(), 365 * 2);

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  delete process.env.WORKER_MARKER_URL;
  delete process.env.CRON_SHARED_SECRET;
});

function json(method: string, url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const post = (body: unknown) => POST(json("POST", "/api/calendar/events", body));
const patch = (body: unknown) => PATCH(json("PATCH", "/api/calendar/events", body));
const correct = (body: unknown) => CORRECT_DATE(json("POST", "/api/earnings/correct-date", body));

function eventCount(): number {
  return (hoisted.db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get() as { n: number }).n;
}

function seedSecurity(symbol: string, type = "Stock"): number {
  return hoisted.db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, ?, 'equity', 1)",
    )
    .run(symbol, `${symbol} Inc`, type).lastInsertRowid as number;
}

describe("tickerShapeError", () => {
  it.each(["AAA", "brk.b", "BF-B", "ABBNY", "000000.KS", " zzz "])("accepts %s", (s) => {
    expect(tickerShapeError(s)).toBeNull();
  });
  it.each(["!!!@@@ 123", "AA A", "AAA!", ".AAA", "AAA.", "AA..A", "-", "ABCDEFGHIJKLM", "AAA;DROP"])(
    "refuses %s",
    (s) => {
      expect(tickerShapeError(s)).toMatch(/is not a ticker symbol/);
    },
  );
});

describe("manualEventDateError", () => {
  it("accepts today + 2 years and refuses one day more", () => {
    expect(manualEventDateError(atLimit, todayET())).toBeNull();
    expect(manualEventDateError(tooFar, todayET())).toMatch(/more than 2 years ahead/);
  });
  it("refuses a date before 2000 and a day that does not exist", () => {
    expect(manualEventDateError("1999-12-31", todayET())).toMatch(/before the year 2000/);
    expect(manualEventDateError("2026-02-30", todayET())).toMatch(/not a real calendar day/);
    expect(manualEventDateError("2026-13-01", todayET())).toMatch(/not a real calendar day/);
  });
});

describe("POST /api/calendar/events — typed input checks", () => {
  it("refuses text that cannot be a ticker with a plain 400 and writes nothing", async () => {
    const res = await post({ symbol: "!!!@@@ 123", event_date: nextWeek, event_time: "AMC" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("invalid_symbol");
    expect(body.error).toMatch(/is not a ticker symbol/);
    expect(eventCount()).toBe(0);
  });

  it("accepts a share-class ticker typed in lower case and stores it upper case", async () => {
    const res = await post({ symbol: " brk.b ", event_date: nextWeek, event_time: "AMC" });
    expect(res.status).toBe(200);
    const row = hoisted.db.prepare("SELECT symbol FROM calendar_events").get() as { symbol: string };
    expect(row.symbol).toBe("BRK.B");
  });

  it("links the row to the security case-insensitively", async () => {
    const id = seedSecurity("zzz");
    const res = await post({ symbol: "ZZZ", event_date: nextWeek, event_time: "AMC" });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.securityMatched).toBe(true);
    const row = hoisted.db.prepare("SELECT security_id FROM calendar_events").get() as {
      security_id: number | null;
    };
    expect(row.security_id).toBe(id);
  });

  it("links a share class to its sibling's security when only the sibling is on file", async () => {
    const goog = seedSecurity("GOOG");
    const res = await post({ symbol: "GOOGL", event_date: nextWeek, event_time: "AMC" });
    expect((await res.json()).securityMatched).toBe(true);
    const row = hoisted.db.prepare("SELECT symbol, security_id FROM calendar_events").get() as {
      symbol: string;
      security_id: number | null;
    };
    expect(row.symbol).toBe("GOOGL");
    expect(row.security_id).toBe(goog);
  });

  it("still saves a well-formed symbol the app has never seen, and says it matched nothing", async () => {
    const res = await post({ symbol: "QQQZ", event_date: nextWeek, event_time: "AMC" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.securityMatched).toBe(false);
    expect(eventCount()).toBe(1);
  });

  it("refuses a date more than 2 years ahead, before 2000, or not a real day", async () => {
    for (const [date, pattern] of [
      [tooFar, /more than 2 years ahead/],
      ["1999-06-01", /before the year 2000/],
      ["2026-02-30", /not a real calendar day/],
    ] as const) {
      const res = await post({ symbol: "AAA", event_date: date, event_time: "AMC" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe("invalid_date");
      expect(body.error).toMatch(pattern);
    }
    expect(eventCount()).toBe(0);
  });

  it("accepts a date exactly 2 years ahead", async () => {
    const res = await post({ symbol: "AAA", event_date: atLimit, event_time: "AMC" });
    expect(res.status).toBe(200);
  });

  it("force and forceSlot never bypass the input checks", async () => {
    const res = await post({
      symbol: "AA A",
      event_date: tooFar,
      event_time: "AMC",
      force: true,
      forceSlot: true,
    });
    expect(res.status).toBe(400);
    expect(eventCount()).toBe(0);
  });
});

describe("PATCH /api/calendar/events — typed input checks", () => {
  async function seedManual(): Promise<number> {
    const res = await post({ symbol: "AAA", event_date: nextWeek, event_time: "AMC" });
    return (await res.json()).id as number;
  }

  it("refuses an out-of-range date and a junk symbol, leaving the row as it was", async () => {
    const id = await seedManual();
    const far = await patch({ id, event_date: tooFar, force: true });
    expect(far.status).toBe(400);
    expect((await far.json()).code).toBe("invalid_date");
    const junk = await patch({ id, symbol: "!!!" });
    expect(junk.status).toBe(400);
    expect((await junk.json()).code).toBe("invalid_symbol");
    const row = hoisted.db
      .prepare("SELECT symbol, event_date FROM calendar_events WHERE id = ?")
      .get(id) as { symbol: string; event_date: string };
    expect(row).toEqual({ symbol: "AAA", event_date: nextWeek });
  });

  it("still answers 403 for a sync-owned row before looking at the input", async () => {
    const id = hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of)
         VALUES ('finnhub', 'earnings', ?, 'ZZZ earnings', 'ZZZ', ?, ?)`,
      )
      .run(nextWeek, `finnhub:ZZZ:${nextWeek}:earnings`, mondayOf(nextWeek)).lastInsertRowid as number;
    const res = await patch({ id, event_date: tooFar });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/earnings/correct-date — date bounds", () => {
  function seedVendor(): void {
    hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of, raw_json)
         VALUES ('finnhub', 'earnings', ?, 'AAA earnings', 'AAA', ?, ?, '{}')`,
      )
      .run(nextWeek, `finnhub:AAA:${nextWeek}:earnings`, mondayOf(nextWeek));
  }

  it("refuses a corrected date more than 2 years ahead or before 2000 and changes nothing", async () => {
    seedVendor();
    for (const [date, pattern] of [
      [tooFar, /more than 2 years ahead/],
      ["1999-06-01", /before the year 2000/],
      ["2026-02-30", /not a real calendar day/],
    ] as const) {
      const res = await correct({ symbol: "AAA", wrongDate: nextWeek, correctDate: date });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(pattern);
    }
    const rows = hoisted.db.prepare("SELECT source, event_date FROM calendar_events").all();
    expect(rows).toEqual([{ source: "finnhub", event_date: nextWeek }]);
    const suppressed = hoisted.db
      .prepare("SELECT COUNT(*) AS n FROM calendar_event_suppressions")
      .get() as { n: number };
    expect(suppressed.n).toBe(0);
  });

  it("refuses a symbol that cannot be a ticker", async () => {
    const res = await correct({ symbol: "AA A!", wrongDate: nextWeek, correctDate: addDays(nextWeek, 1) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/is not a ticker symbol/);
  });

  it("still corrects to an in-range date", async () => {
    seedVendor();
    const res = await correct({ symbol: "AAA", wrongDate: nextWeek, correctDate: addDays(nextWeek, 1) });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});

/**
 * The Fix-date action asks before it leaves a second print beside a confirmed
 * vendor date (owner ruling 2026-10-20, decision record
 * correct-date-contradict-confirmed-guard).
 *
 * POST /api/earnings/correct-date moves a row to another day. When a showing
 * vendor row for the same company, on another day of that week, is confirmed
 * (two sources agree, or web-verified for that day), the move would leave two
 * prints, each with its own preview and recap emails. The route answers 409
 * `would_contradict_confirmed_date` and changes nothing until the body carries
 * `forceContradictConfirmed: true`; no other flag answers it. The rows on the
 * date named as wrong are deleted by the correction, so they never count.
 *
 * Synthetic symbol. Dates derive from todayET(): a week two weeks out.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, mondayOf, todayET } from "@/lib/calendar/date-utils";
import { WOULD_CONTRADICT_CONFIRMED_DATE } from "@/lib/calendar/manual-add-contradicts-confirmed";
import { CONTRADICT_CONFIRMED_CODE } from "@/app/dashboard/today/EarningsDateChip";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { POST } from "@/app/api/earnings/correct-date/route";

const monday = mondayOf(addDays(todayET(), 14));
const wednesday = addDays(monday, 2);
const thursday = addDays(monday, 3);
const friday = addDays(monday, 4);

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  delete process.env.WORKER_MARKER_URL;
  delete process.env.CRON_SHARED_SECRET;
});

function seedRow(
  source: string,
  symbol: string,
  date: string,
  dateStatus: string | null = null,
): number {
  return hoisted.db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, title, symbol, source_key, week_of, raw_json, date_status)
       VALUES (?, 'earnings', ?, 'AMC', ?, ?, ?, ?, '{}', ?)`,
    )
    .run(
      source,
      date,
      `${symbol} earnings`,
      symbol,
      `${source}:${symbol}:${date}:earnings`,
      mondayOf(date),
      dateStatus,
    ).lastInsertRowid as number;
}

function req(body: unknown): Request {
  return new Request("http://test/api/earnings/correct-date", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function showingDates(symbol: string): string[] {
  return (
    hoisted.db
      .prepare(
        `SELECT event_date FROM calendar_events
          WHERE symbol = ? AND event_type = 'earnings' AND COALESCE(superseded, 0) = 0
          ORDER BY event_date`,
      )
      .all(symbol) as Array<{ event_date: string }>
  ).map((r) => r.event_date);
}

const FIX = { symbol: "AAA", wrongDate: wednesday, correctDate: friday, slot: "amc" };

describe("POST /api/earnings/correct-date — would_contradict_confirmed_date", () => {
  it("refuses a move to Friday beside a two-source-confirmed vendor Thursday and changes nothing", async () => {
    const vendorId = seedRow("finnhub", "AAA", thursday, "confirmed");
    seedRow("manual", "AAA", wednesday);

    const res = await POST(req(FIX));

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.code).toBe("would_contradict_confirmed_date");
    expect(body.vendorEventId).toBe(vendorId);
    expect(body.vendorDate).toBe(thursday);
    expect(body.basis).toBe("two_sources");
    // Worded for a fix, not an add.
    expect(body.error).toMatch(/Nothing was changed\./);
    expect(body.error).toMatch(/Pick another date, or fix anyway to keep both\./);
    expect(body.error).not.toMatch(/Nothing was added|add anyway/);
    expect(showingDates("AAA")).toEqual([wednesday, thursday]);
  });

  it("goes through with forceContradictConfirmed and leaves both prints showing", async () => {
    seedRow("finnhub", "AAA", thursday, "confirmed");
    seedRow("manual", "AAA", wednesday);

    const res = await POST(req({ ...FIX, forceContradictConfirmed: true }));

    expect(res.status).toBe(200);
    expect(showingDates("AAA")).toEqual([thursday, friday]);
  });

  it("force (the add route's supersede flag) does not answer it", async () => {
    seedRow("finnhub", "AAA", thursday, "confirmed");
    seedRow("manual", "AAA", wednesday);

    const res = await POST(req({ ...FIX, force: true, forceSlot: true }));

    expect(res.status).toBe(409);
    expect(showingDates("AAA")).toEqual([wednesday, thursday]);
  });

  it("asks nothing when the confirmed vendor date is itself the one named as wrong", async () => {
    seedRow("finnhub", "AAA", thursday, "confirmed");

    const res = await POST(req({ symbol: "AAA", wrongDate: thursday, correctDate: friday, slot: "amc" }));

    expect(res.status).toBe(200);
    expect(showingDates("AAA")).toEqual([friday]);
  });

  it("asks nothing when the move lands on the confirmed vendor date", async () => {
    seedRow("finnhub", "AAA", thursday, "confirmed");
    seedRow("manual", "AAA", wednesday);

    const res = await POST(req({ ...FIX, correctDate: thursday }));

    expect(res.status).toBe(200);
  });

  it("asks nothing for a single-source vendor date", async () => {
    seedRow("finnhub", "AAA", thursday, "single");
    seedRow("manual", "AAA", wednesday);

    const res = await POST(req(FIX));

    expect(res.status).toBe(200);
  });

  it("never checks a same-date slot fix", async () => {
    seedRow("finnhub", "AAA", thursday, "confirmed");
    seedRow("manual", "AAA", wednesday);

    const res = await POST(req({ ...FIX, correctDate: wednesday, slot: "bmo" }));

    expect(res.status).toBe(200);
  });

  it("the chip's code constant mirrors the server's", () => {
    expect(CONTRADICT_CONFIRMED_CODE).toBe(WOULD_CONTRADICT_CONFIRMED_DATE);
  });
});

/**
 * HTTP-boundary tests for the `would_contradict_confirmed_date` 409 on
 * POST / PATCH /api/calendar/events
 * (qa:dashboard-today-earningshub-add-ticker-hand-entered-date-beside-a-vendor-date-in-the-same-week-hand-entered-da;
 * owner ruling 2026-10-12, option 1).
 *
 * A hand-entered earnings date on a DIFFERENT day in the same week as a
 * CONFIRMED vendor date (two sources agree, or a web-verified release time
 * for that day) is refused until the body carries
 * `forceContradictConfirmed: true`. That flag answers only this question:
 * `force` / `forceSlot` never answer it, and it never answers theirs.
 *
 * Synthetic symbol and dates. Dates derive from todayET() so the fixture can
 * never go wall-clock stale: a Thursday and Friday two weeks out.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, mondayOf, todayET } from "@/lib/calendar/date-utils";
import { POST, PATCH } from "@/app/api/calendar/events/route";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const monday = mondayOf(addDays(todayET(), 14));
const thursday = addDays(monday, 3);
const friday = addDays(monday, 4);
const nextMonday = addDays(monday, 7);
const farAway = addDays(monday, 45);

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  delete process.env.WORKER_MARKER_URL;
  delete process.env.CRON_SHARED_SECRET;
});

function seedVendorRow(
  symbol: string,
  date: string,
  opts: { dateStatus?: string | null; source?: string } = {},
): number {
  const source = opts.source ?? "finnhub";
  return hoisted.db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, week_of, raw_json, date_status)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, '{}', ?)`,
    )
    .run(
      source,
      date,
      `${symbol} earnings`,
      symbol,
      `${source}:${symbol}:${date}:earnings`,
      mondayOf(date),
      opts.dateStatus ?? null,
    ).lastInsertRowid as number;
}

function seedManualRow(symbol: string, date: string): number {
  return hoisted.db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, week_of, raw_json)
       VALUES ('manual', 'earnings', ?, ?, ?, ?, ?, '{}')`,
    )
    .run(date, `${symbol} earnings`, symbol, `manual:${symbol}:${date}:earnings`, mondayOf(date))
    .lastInsertRowid as number;
}

function seedReleaseTime(
  symbol: string,
  time: string,
  source: "user" | "web_verified",
  verifiedForDate: string | null,
) {
  hoisted.db
    .prepare(
      `INSERT INTO symbol_release_times (symbol, release_time, source, verified_for_date)
       VALUES (?, ?, ?, ?)`,
    )
    .run(symbol, time, source, verifiedForDate);
}

function req(method: "POST" | "PATCH", body: unknown): Request {
  return new Request("http://test/api/calendar/events", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function manualRows(symbol: string) {
  return hoisted.db
    .prepare("SELECT id, event_date FROM calendar_events WHERE source = 'manual' AND symbol = ?")
    .all(symbol) as Array<{ id: number; event_date: string }>;
}

function eventDate(id: number): string | undefined {
  return (
    hoisted.db.prepare("SELECT event_date FROM calendar_events WHERE id = ?").get(id) as
      | { event_date: string }
      | undefined
  )?.event_date;
}

const ADD = { symbol: "AAA", event_date: friday, event_time: "AMC", event_type: "earnings" };

type Refusal = {
  success: boolean;
  error: string;
  code: string;
  vendorEventId?: number;
  vendorDate?: string;
  vendorSource?: string;
};

describe("POST /api/calendar/events — would_contradict_confirmed_date", () => {
  it("(a) refuses a Friday add beside a two-source-confirmed vendor Thursday and saves nothing", async () => {
    const vendorId = seedVendorRow("AAA", thursday, { dateStatus: "confirmed" });

    const res = await POST(req("POST", ADD));

    expect(res.status).toBe(409);
    const body = (await res.json()) as Refusal;
    expect(body.success).toBe(false);
    expect(body.code).toBe("would_contradict_confirmed_date");
    expect(body.vendorEventId).toBe(vendorId);
    expect(body.vendorDate).toBe(thursday);
    expect(body.vendorSource).toBe("finnhub");
    expect(body.error).toContain(thursday);
    expect(body.error).toContain(friday);
    expect(body.error).toMatch(/Finnhub/);
    expect(manualRows("AAA")).toHaveLength(0);
  });

  it("(b) saves the same body with forceContradictConfirmed: true", async () => {
    seedVendorRow("AAA", thursday, { dateStatus: "confirmed" });

    const res = await POST(req("POST", { ...ADD, forceContradictConfirmed: true }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; id: number };
    expect(body.success).toBe(true);
    const rows = manualRows("AAA");
    expect(rows).toHaveLength(1);
    expect(rows[0].event_date).toBe(friday);
  });

  it("(c1) force: true and forceSlot: true do not answer this question", async () => {
    seedVendorRow("AAA", thursday, { dateStatus: "confirmed" });

    const res = await POST(req("POST", { ...ADD, force: true, forceSlot: true }));

    expect(res.status).toBe(409);
    expect(((await res.json()) as Refusal).code).toBe("would_contradict_confirmed_date");
    expect(manualRows("AAA")).toHaveLength(0);
  });

  it("(c2) forceContradictConfirmed does not answer would_supersede_vendor", async () => {
    // An unconfirmed vendor row in the NEXT week: the cross-week guard's case.
    seedVendorRow("AAA", nextMonday);

    const res = await POST(req("POST", { ...ADD, forceContradictConfirmed: true }));

    expect(res.status).toBe(409);
    expect(((await res.json()) as Refusal).code).toBe("would_supersede_vendor");
    expect(manualRows("AAA")).toHaveLength(0);
  });

  it("(c3) forceContradictConfirmed does not answer slot_contradicts_known_time", async () => {
    seedVendorRow("AAA", thursday, { dateStatus: "confirmed" });
    seedReleaseTime("AAA", "08:00", "user", null);

    const res = await POST(req("POST", { ...ADD, forceContradictConfirmed: true }));

    expect(res.status).toBe(409);
    expect(((await res.json()) as Refusal).code).toBe("slot_contradicts_known_time");
    expect(manualRows("AAA")).toHaveLength(0);
  });

  it("(c4) forceContradictConfirmed does not answer manual_row_exists", async () => {
    seedVendorRow("AAA", thursday, { dateStatus: "confirmed" });
    seedManualRow("AAA", friday);

    const res = await POST(req("POST", { ...ADD, forceContradictConfirmed: true }));

    expect(res.status).toBe(409);
    expect(((await res.json()) as Refusal).code).toBe("manual_row_exists");
  });

  it("(d) a vendor row that is not confirmed and has no web-verified time is not asked about", async () => {
    seedVendorRow("AAA", thursday, { dateStatus: null });

    const res = await POST(req("POST", ADD));

    expect(res.status).toBe(200);
    expect(manualRows("AAA")).toHaveLength(1);
  });

  it("(d2) a web-verified time for a DIFFERENT date does not count as confirming the vendor day", async () => {
    seedVendorRow("AAA", thursday, { dateStatus: null });
    seedReleaseTime("AAA", "16:05", "web_verified", addDays(thursday, -91));

    const res = await POST(req("POST", ADD));

    expect(res.status).toBe(200);
  });

  it("(e) a web-verified release time for the vendor day counts as confirmed", async () => {
    const vendorId = seedVendorRow("AAA", thursday, { dateStatus: null });
    seedReleaseTime("AAA", "16:05", "web_verified", thursday);

    const res = await POST(req("POST", ADD));

    expect(res.status).toBe(409);
    const body = (await res.json()) as Refusal;
    expect(body.code).toBe("would_contradict_confirmed_date");
    expect(body.vendorEventId).toBe(vendorId);
    expect(body.error).toMatch(/web-verified/);
    expect(manualRows("AAA")).toHaveLength(0);
  });

  it("(f) the vendor's own date is not this guard's business", async () => {
    seedVendorRow("AAA", thursday, { dateStatus: "confirmed" });

    const res = await POST(req("POST", { ...ADD, event_date: thursday }));

    const body = (await res.json()) as Refusal;
    expect(body.code).not.toBe("would_contradict_confirmed_date");
  });

  it("a hidden (superseded) confirmed vendor row is not asked about", async () => {
    const id = seedVendorRow("AAA", thursday, { dateStatus: "confirmed" });
    hoisted.db.prepare("UPDATE calendar_events SET superseded = 1 WHERE id = ?").run(id);

    const res = await POST(req("POST", ADD));

    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/calendar/events — would_contradict_confirmed_date", () => {
  it("(g1) refuses moving a manual row onto another day in the confirmed vendor's week", async () => {
    const vendorId = seedVendorRow("AAA", thursday, { dateStatus: "confirmed" });
    const manualId = seedManualRow("AAA", farAway);

    const res = await PATCH(req("PATCH", { id: manualId, event_date: friday }));

    expect(res.status).toBe(409);
    const body = (await res.json()) as Refusal;
    expect(body.code).toBe("would_contradict_confirmed_date");
    expect(body.vendorEventId).toBe(vendorId);
    expect(body.error).toMatch(/Nothing was changed/);
    expect(eventDate(manualId)).toBe(farAway);
  });

  it("(g2) moves it with forceContradictConfirmed: true, and force alone does not", async () => {
    seedVendorRow("AAA", thursday, { dateStatus: "confirmed" });
    const manualId = seedManualRow("AAA", farAway);

    const forced = await PATCH(req("PATCH", { id: manualId, event_date: friday, force: true }));
    expect(forced.status).toBe(409);
    expect(((await forced.json()) as Refusal).code).toBe("would_contradict_confirmed_date");
    expect(eventDate(manualId)).toBe(farAway);

    const res = await PATCH(
      req("PATCH", { id: manualId, event_date: friday, forceContradictConfirmed: true }),
    );
    expect(res.status).toBe(200);
    expect(eventDate(manualId)).toBe(friday);
  });

  it("(g3) a symbol change onto the confirmed vendor's family is asked about", async () => {
    seedVendorRow("AAA", thursday, { dateStatus: "confirmed" });
    const manualId = seedManualRow("BBBQ", friday);

    const res = await PATCH(req("PATCH", { id: manualId, symbol: "AAA" }));

    expect(res.status).toBe(409);
    expect(((await res.json()) as Refusal).code).toBe("would_contradict_confirmed_date");
  });

  it("(g4) a PATCH that leaves the date and symbol alone is never checked", async () => {
    seedVendorRow("AAA", thursday, { dateStatus: "confirmed" });
    const manualId = seedManualRow("AAA", friday);

    const res = await PATCH(
      req("PATCH", { id: manualId, event_date: friday, symbol: "AAA", description: "notes" }),
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
  });
});

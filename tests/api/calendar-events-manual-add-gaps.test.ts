/**
 * /api/calendar/events: three gaps in the hand-entered earnings road.
 *
 * (a) POST on a date that already holds a HIDDEN hand-entered row used to
 *     answer "already exists, edit it instead". The row is on no calendar
 *     surface, so there was nothing to edit. The refusal now says the entry is
 *     hidden and names the entry that took its place.
 * (b) PATCH never ran the slot guard: a slot change kept the release time of
 *     the old slot, on the other side of the session.
 * (c) A hand-entered row added on a date a feed row already shows on left two
 *     cards for one print until the next refresh. The feed row is now hidden
 *     at the write, through the same fold a refresh applies.
 *
 * Dates derive from todayET() so the fixture never goes wall-clock stale.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, mondayOf, todayET } from "@/lib/calendar/date-utils";
import { upsertSymbolReleaseTime } from "@/lib/earnings/wire-times";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { upsertCalendarEvents, type CalendarEventInput } from "@/lib/mutations/calendar";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { POST, PATCH } from "@/app/api/calendar/events/route";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const TODAY = todayET();
const SYM = "ZZA";
/** Beyond the reconciler's 30-day reach: nothing but the write itself folds. */
const FAR_DATE = addDays(TODAY, 60);
const NEXT_WEEK = mondayOf(addDays(TODAY, 7));

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  delete process.env.WORKER_MARKER_URL;
  delete process.env.CRON_SHARED_SECRET;
});

function req(method: "POST" | "PATCH", body: unknown): Request {
  return new Request("http://test/api/calendar/events", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A feed row shaped as the real fetchers build it. */
function feed(source: "finnhub" | "nasdaq", symbol: string, date: string): CalendarEventInput {
  return {
    source,
    event_type: "earnings",
    event_date: date,
    event_time: null,
    title: `${symbol} Earnings`,
    description: null,
    symbol,
    expected_impact: "high",
    consensus_estimate: "EPS 1.00",
    previous_value: null,
    raw_json: "{}",
    source_key: `${source}:${symbol}:${date}`,
    week_of: mondayOf(date),
  };
}

interface Row {
  id: number;
  source: string;
  event_date: string;
  event_time: string | null;
  release_time: string | null;
  superseded: number;
  consensus_estimate: string | null;
}

function rows(symbol = SYM): Row[] {
  return hoisted.db
    .prepare(
      `SELECT id, source, event_date, event_time, release_time,
              COALESCE(superseded, 0) AS superseded, consensus_estimate
         FROM calendar_events WHERE symbol = ? ORDER BY id`,
    )
    .all(symbol) as Row[];
}

function rowById(id: number): Row {
  return hoisted.db
    .prepare(
      `SELECT id, source, event_date, event_time, release_time,
              COALESCE(superseded, 0) AS superseded, consensus_estimate
         FROM calendar_events WHERE id = ?`,
    )
    .get(id) as Row;
}

function outboxPayloads(): Array<{
  entries: Array<{ eventId: number; removed?: true }>;
  supersededEventIds: number[];
}> {
  return (
    hoisted.db.prepare("SELECT payload_json FROM cloud_outbox ORDER BY generation ASC").all() as {
      payload_json: string;
    }[]
  ).map((r) => JSON.parse(r.payload_json));
}

async function add(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(req("POST", { symbol: SYM, ...body }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function patch(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await PATCH(req("PATCH", body));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("(a) POST onto a date that holds a hidden hand-entered row", () => {
  /**
   * A feed row the user confirmed in place, and a hand-entered row three days
   * later for the same print: the reconciler keeps the confirmed feed row (the
   * earlier locked date) and folds the hand-entered row hidden.
   */
  async function hiddenAndShowing(): Promise<{ hidden: Row; showing: Row }> {
    const confirmedDate = addDays(TODAY, 5);
    upsertCalendarEvents(hoisted.db, [feed("finnhub", SYM, confirmedDate)]);
    hoisted.db
      .prepare("UPDATE calendar_events SET date_status = 'user_confirmed' WHERE source = 'finnhub'")
      .run();
    const added = await add({ event_date: addDays(TODAY, 8), force: true });
    expect(added.status).toBe(200);
    reconcileEarningsDates(hoisted.db, { today: TODAY });
    const all = rows();
    const hidden = all.filter((r) => r.superseded === 1);
    const showing = all.filter((r) => r.superseded === 0);
    expect(hidden.map((r) => r.source)).toEqual(["manual"]);
    expect(showing.map((r) => r.source)).toEqual(["finnhub"]);
    return { hidden: hidden[0], showing: showing[0] };
  }

  it("refuses with its own code and names the entry that took its place", async () => {
    const { hidden, showing } = await hiddenAndShowing();

    const res = await add({ event_date: hidden.event_date });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("manual_row_hidden");
    expect(res.body.hiddenEventId).toBe(hidden.id);
    expect(res.body.replacedByEventId).toBe(showing.id);
    expect(res.body.replacedByDate).toBe(showing.event_date);
    const message = String(res.body.error);
    expect(message).toContain(SYM);
    expect(message).toContain(hidden.event_date);
    expect(message).toContain(showing.event_date);
    expect(message).toMatch(/hidden/i);
    expect(message).toMatch(/nothing was added/i);
    expect(message).not.toMatch(/edit it instead/i);
  });

  it("writes nothing and does not bring the hidden row back", async () => {
    const { hidden } = await hiddenAndShowing();
    const before = rows();

    await add({ event_date: hidden.event_date });

    expect(rows()).toEqual(before);
    expect(rowById(hidden.id).superseded).toBe(1);
  });

  it("neither acknowledgement gets past it", async () => {
    const { hidden } = await hiddenAndShowing();

    const res = await add({ event_date: hidden.event_date, force: true, forceSlot: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("manual_row_hidden");
  });

  it("says so plainly when no showing entry can be named", async () => {
    const first = await add({ event_date: FAR_DATE });
    hoisted.db.prepare("UPDATE calendar_events SET superseded = 1 WHERE id = ?").run(first.body.id);

    const res = await add({ event_date: FAR_DATE });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("manual_row_hidden");
    expect(res.body.replacedByEventId).toBeNull();
    expect(String(res.body.error)).toMatch(/hidden/i);
  });

  it("a SHOWING duplicate keeps the edit-it answer, before either guard is asked", async () => {
    upsertSymbolReleaseTime(hoisted.db, { symbol: SYM, releaseTime: "16:05", source: "user" });
    const first = await add({ event_date: NEXT_WEEK, event_time: "AMC" });
    expect(first.status).toBe(200);

    // BMO contradicts the known afternoon time; the duplicate is the real
    // reason this add cannot be saved, so that is what the user is told.
    const res = await add({ event_date: NEXT_WEEK, event_time: "BMO" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("manual_row_exists");
    expect(res.body.existingEventId).toBe(first.body.id);
    expect(String(res.body.error)).toMatch(/edit it instead/i);
  });
});

describe("(b) PATCH runs the slot guard", () => {
  async function seeded(slot: "BMO" | "AMC", knownTime: string): Promise<number> {
    upsertSymbolReleaseTime(hoisted.db, { symbol: SYM, releaseTime: knownTime, source: "user" });
    const res = await add({ event_date: NEXT_WEEK, event_time: slot });
    expect(res.status).toBe(200);
    return res.body.id as number;
  }

  it("refuses a slot that contradicts the known time and leaves the row alone", async () => {
    const id = await seeded("AMC", "16:05");

    const res = await patch({ id, event_time: "BMO" });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("slot_contradicts_known_time");
    expect(res.body.knownTime).toBe("16:05");
    expect(res.body.slot).toBe("BMO");
    expect(String(res.body.error)).toMatch(/nothing was changed/i);
    expect(String(res.body.error)).not.toMatch(/nothing was added/i);
    expect(rowById(id)).toMatchObject({ event_time: "AMC", release_time: "16:05" });
  });

  it("forceSlot stores the new slot with ITS default time, never the old slot's", async () => {
    const id = await seeded("AMC", "16:05");

    const res = await patch({ id, event_time: "BMO", forceSlot: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(rowById(id)).toMatchObject({ event_time: "BMO", release_time: "08:00" });
  });

  it("`force` alone does not answer the slot warning", async () => {
    const id = await seeded("AMC", "16:05");

    const res = await patch({ id, event_time: "BMO", force: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("slot_contradicts_known_time");
  });

  it("a slot change with no known time moves the release time to the new slot's default", async () => {
    const created = await add({ event_date: NEXT_WEEK, event_time: "AMC" });
    const id = created.body.id as number;
    expect(rowById(id).release_time).toBe("16:15");

    const res = await patch({ id, event_time: "BMO" });

    expect(res.status).toBe(200);
    expect(rowById(id)).toMatchObject({ event_time: "BMO", release_time: "08:00" });
  });

  it("an explicit release_time in the body is the caller's own statement", async () => {
    const id = await seeded("AMC", "16:05");

    const res = await patch({ id, event_time: "BMO", release_time: "07:30" });

    expect(res.status).toBe(200);
    expect(rowById(id)).toMatchObject({ event_time: "BMO", release_time: "07:30" });
  });

  it("a PATCH that keeps the slot never asks and keeps the stored time", async () => {
    const id = await seeded("AMC", "16:05");
    // The known time moves to the morning after the row was saved.
    upsertSymbolReleaseTime(hoisted.db, { symbol: SYM, releaseTime: "07:30", source: "user" });

    const same = await patch({ id, event_time: "AMC" });
    const notes = await patch({ id, description: "notes" });

    expect(same.status).toBe(200);
    expect(notes.status).toBe(200);
    expect(rowById(id)).toMatchObject({ event_time: "AMC", release_time: "16:05" });
  });

  it("a non-earnings row is not slot-checked", async () => {
    upsertSymbolReleaseTime(hoisted.db, { symbol: SYM, releaseTime: "16:05", source: "user" });
    const created = await add({ event_date: NEXT_WEEK, event_time: "AMC", event_type: "investor_day" });
    expect(created.status).toBe(200);

    const res = await patch({ id: created.body.id, event_time: "BMO" });

    expect(res.status).toBe(200);
  });
});

describe("(c) adding on top of a showing feed row hides the feed row at the write", () => {
  it("one card is left, the feed row's consensus is carried, and the answer says so", async () => {
    upsertCalendarEvents(hoisted.db, [feed("finnhub", SYM, FAR_DATE)]);
    const feedId = rows()[0].id;

    const res = await add({ event_date: FAR_DATE, force: true });

    expect(res.status).toBe(200);
    expect(res.body.hiddenFeedRows).toBe(1);
    const manualId = res.body.id as number;
    expect(rowById(feedId).superseded).toBe(1);
    expect(rowById(manualId).superseded).toBe(0);
    expect(rowById(manualId).consensus_estimate).toBe("EPS 1.00");
    // The cloud is told which row was replaced, in the same transaction.
    const payloads = outboxPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].supersededEventIds).toEqual([feedId]);
  });

  it("an armed feed row's arm moves to the new row and the cloud hears it", async () => {
    upsertCalendarEvents(hoisted.db, [feed("finnhub", SYM, FAR_DATE)]);
    const feedId = rows()[0].id;
    armWorksheet(hoisted.db, feedId);

    const res = await add({ event_date: FAR_DATE, force: true });

    const manualId = res.body.id as number;
    expect(hoisted.db.prepare("SELECT event_id FROM earnings_worksheet_flags").all()).toEqual([
      { event_id: manualId },
    ]);
    const newest = outboxPayloads().at(-1)!;
    expect(newest.entries.filter((e) => !e.removed).map((e) => e.eventId)).toEqual([manualId]);
    expect(newest.supersededEventIds).toEqual([feedId]);
  });

  it("an add with no feed row on the date reports none hidden and tells the cloud nothing", async () => {
    upsertCalendarEvents(hoisted.db, [feed("finnhub", SYM, addDays(FAR_DATE, 1))]);

    const res = await add({ event_date: FAR_DATE, force: true });

    expect(res.status).toBe(200);
    expect(res.body.hiddenFeedRows).toBe(0);
    expect(rows().every((r) => r.superseded === 0)).toBe(true);
    expect(outboxPayloads()).toHaveLength(0);
  });

  it("PATCH moving a hand-entered row onto a feed row's date hides that feed row too", async () => {
    upsertCalendarEvents(hoisted.db, [feed("finnhub", SYM, FAR_DATE)]);
    const feedId = rows()[0].id;
    const created = await add({ event_date: addDays(FAR_DATE, 40), force: true });
    const manualId = created.body.id as number;
    expect(rowById(feedId).superseded).toBe(0);

    const res = await patch({ id: manualId, event_date: FAR_DATE, force: true });

    expect(res.status).toBe(200);
    expect(rowById(feedId).superseded).toBe(1);
    expect(outboxPayloads().at(-1)!.supersededEventIds).toEqual([feedId]);
  });
});

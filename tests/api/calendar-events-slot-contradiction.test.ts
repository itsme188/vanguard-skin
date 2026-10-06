/**
 * POST /api/calendar/events — a manual earnings add may not store a slot and a
 * release time on opposite sides of the session (user ruling 2026-10-05).
 *
 * Two QA findings, one cause: "+ Add ticker" let the user pick BMO while the
 * stored release_time came from the symbol's remembered AFTERNOON time (the
 * countdown said 4:05 PM, the accept gate said 7:00 AM).
 *
 * Ruling: the symbol's known time is kept only when it sits on the SAME side of
 * noon as the chosen slot. A contradiction refuses with 409
 * `slot_contradicts_known_time` and writes nothing; the same POST with
 * `force: true` inserts and stores the SLOT default, never the contradicting
 * remembered time. No known time → no refusal, slot default.
 *
 * Dates derive from todayET() so the fixture can never go wall-clock stale.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, mondayOf, todayET } from "@/lib/calendar/date-utils";
import { upsertSymbolReleaseTime } from "@/lib/earnings/wire-times";
import { POST } from "@/app/api/calendar/events/route";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const eventDate = mondayOf(addDays(todayET(), 7));
const SYM = "ZQTEST";

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  delete process.env.WORKER_MARKER_URL;
  delete process.env.CRON_SHARED_SECRET;
});

function postReq(body: unknown): Request {
  return new Request("http://test/api/calendar/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function storedRow(): { event_time: string | null; release_time: string | null } | undefined {
  return hoisted.db
    .prepare(
      `SELECT event_time, release_time FROM calendar_events
        WHERE source = 'manual' AND symbol = ? AND event_date = ?`,
    )
    .get(SYM, eventDate) as { event_time: string | null; release_time: string | null } | undefined;
}

function rememberTime(releaseTime: string): void {
  upsertSymbolReleaseTime(hoisted.db, { symbol: SYM, releaseTime, source: "user" });
}

describe("POST /api/calendar/events — slot vs the symbol's known release time", () => {
  it("no known time: no refusal, stores the slot default", async () => {
    const bmo = await POST(postReq({ symbol: SYM, event_date: eventDate, event_time: "BMO" }));
    expect(bmo.status).toBe(200);
    expect((await bmo.json()).success).toBe(true);
    expect(storedRow()).toEqual({ event_time: "BMO", release_time: "08:00" });
  });

  it("no known time, AMC: stores 16:15", async () => {
    const amc = await POST(postReq({ symbol: SYM, event_date: eventDate, event_time: "AMC" }));
    expect(amc.status).toBe(200);
    expect(storedRow()).toEqual({ event_time: "AMC", release_time: "16:15" });
  });

  it("known time on the same side of the session is kept", async () => {
    rememberTime("16:05");
    const res = await POST(postReq({ symbol: SYM, event_date: eventDate, event_time: "AMC" }));
    expect(res.status).toBe(200);
    expect(storedRow()).toEqual({ event_time: "AMC", release_time: "16:05" });
  });

  it("a contradicting known time refuses with 409 slot_contradicts_known_time and writes nothing", async () => {
    rememberTime("16:05");
    const res = await POST(postReq({ symbol: SYM, event_date: eventDate, event_time: "BMO" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("slot_contradicts_known_time");
    expect(body.knownTime).toBe("16:05");
    expect(body.slot).toBe("BMO");
    // Domain language: names the symbol, the remembered time and the picked slot.
    expect(body.error).toContain(SYM);
    expect(body.error).toContain("4:05 PM");
    expect(body.error).toMatch(/before the open/i);
    expect(storedRow()).toBeUndefined();
  });

  it("the mirror contradiction (AMC picked, morning time known) refuses too", async () => {
    rememberTime("07:30");
    const res = await POST(postReq({ symbol: SYM, event_date: eventDate, event_time: "AMC" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("slot_contradicts_known_time");
    expect(storedRow()).toBeUndefined();
  });

  it("force: true inserts and stores the SLOT default, never the contradicting time", async () => {
    rememberTime("16:05");
    const res = await POST(
      postReq({ symbol: SYM, event_date: eventDate, event_time: "BMO", force: true }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(storedRow()).toEqual({ event_time: "BMO", release_time: "08:00" });
  });

  it("force on the AMC side stores 16:15", async () => {
    rememberTime("07:30");
    const res = await POST(
      postReq({ symbol: SYM, event_date: eventDate, event_time: "AMC", force: true }),
    );
    expect(res.status).toBe(200);
    expect(storedRow()).toEqual({ event_time: "AMC", release_time: "16:15" });
  });

  it("the built-in per-symbol constant counts as a known time (META 16:05 vs BMO)", async () => {
    const res = await POST(postReq({ symbol: "META", event_date: eventDate, event_time: "BMO" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("slot_contradicts_known_time");
    expect(body.knownTime).toBe("16:05");
  });

  it("an explicit release_time in the body is the caller's own statement — not second-guessed", async () => {
    rememberTime("16:05");
    const res = await POST(
      postReq({ symbol: SYM, event_date: eventDate, event_time: "BMO", release_time: "07:15" }),
    );
    expect(res.status).toBe(200);
    expect(storedRow()).toEqual({ event_time: "BMO", release_time: "07:15" });
  });

  it("a non-earnings or TAS add is never checked", async () => {
    rememberTime("16:05");
    const res = await POST(postReq({ symbol: SYM, event_date: eventDate, event_time: "TAS" }));
    expect(res.status).toBe(200);
  });
});

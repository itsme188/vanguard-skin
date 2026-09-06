/**
 * Tests for the slot-mismatch guard on POST /api/earnings/release-time (QA
 * finding today-earningshub-release-time--save-stamps-slot-default-summary-
 * contradicts-input, 2026-09-03): a symbol whose upcoming earnings event is
 * slotted AMC had a web_verified row at 16:05. The user typed 07:30 and hit
 * Save. Before this fix the POST wrote a 'user' row at 07:30 (overwriting
 * the web_verified row + its citation via the single-row-per-symbol PK
 * upsert), then applyResolvedReleaseTimeToUpcomingEvents recomputed the
 * event's release_time — but resolveSymbolReleaseTime's sameSideOfNoon
 * guard silently ignored the wrong-side 'user' row, so the event fell
 * through to the 16:15 AMC slot default. Net effect: THREE different times
 * (07:30 written, 16:05 lost, 16:15 shown) and the write was pointless. This
 * guard runs before the write and rejects the mismatch with 409 instead.
 *
 * The lib composition pieces (cascade resolution, PK-precedence upsert,
 * clear semantics, the new checkUserReleaseTimeAgainstUpcomingSlot guard
 * itself) are covered in tests/earnings/wire-times.test.ts and
 * tests/earnings/release-time-route.test.ts. These tests pin the
 * route-layer contract for the new 409. Non-conflicting cases (400s, GET,
 * clear) are covered in tests/api/earnings-release-time.test.ts and are not
 * duplicated here. Pattern follows that file exactly.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// Import AFTER the mock is registered so the route binds to the mock db.
import { POST } from "@/app/api/earnings/release-time/route";

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/earnings/release-time", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Seed an AMC-slotted upcoming earnings row carrying a standing web_verified override. */
function seedAmcEventWithWebVerified(symbol: string, eventDate: string) {
  hoisted.db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, symbol, title, source_key, week_of)
       VALUES ('finnhub','earnings',?,?,?,?,?,?,?)`,
    )
    .run(eventDate, "AMC", "16:15", symbol, `${symbol} earnings`, `finnhub:${symbol}:${eventDate}`, eventDate);
  hoisted.db
    .prepare(
      `INSERT INTO symbol_release_times (symbol, release_time, source, note, verified_for_date, updated_at)
       VALUES (?, '16:05', 'web_verified', 'confirmed via IR site', ?, datetime('now'))`,
    )
    .run(symbol, eventDate);
}

describe("POST /api/earnings/release-time — slot-mismatch guard (409)", () => {
  it("rejects a before-open time against an AMC-slotted upcoming event with 409 + code slot_mismatch", async () => {
    seedAmcEventWithWebVerified("XMTR", "2099-01-01");

    const res = await POST(postReq({ symbol: "XMTR", releaseTime: "07:30" }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("slot_mismatch");
    expect(body.data).toEqual({ slot: "amc", eventDate: "2099-01-01" });
    expect(body.error).toMatch(/before-open/i);
    expect(body.error).toMatch(/after-close/i);
    expect(body.error).toMatch(/XMTR/);
    expect(body.error).toMatch(/2099-01-01/);
  });

  it("leaves the standing web_verified row completely untouched on a 409", async () => {
    seedAmcEventWithWebVerified("XMTR", "2099-01-01");

    await POST(postReq({ symbol: "XMTR", releaseTime: "07:30" }));

    const row = hoisted.db
      .prepare(
        "SELECT release_time, source, note, verified_for_date FROM symbol_release_times WHERE symbol = 'XMTR'",
      )
      .get();
    expect(row).toEqual({
      release_time: "16:05",
      source: "web_verified",
      note: "confirmed via IR site",
      verified_for_date: "2099-01-01",
    });
  });

  it("leaves calendar_events.release_time untouched on a 409", async () => {
    seedAmcEventWithWebVerified("XMTR", "2099-01-01");

    await POST(postReq({ symbol: "XMTR", releaseTime: "07:30" }));

    const row = hoisted.db
      .prepare("SELECT release_time FROM calendar_events WHERE symbol = 'XMTR'")
      .get() as { release_time: string };
    expect(row.release_time).toBe("16:15");
  });

  it("still allows a same-side (after-close) time: 200, writes the user row, updates the event", async () => {
    seedAmcEventWithWebVerified("XMTR", "2099-01-01");

    const res = await POST(postReq({ symbol: "XMTR", releaseTime: "16:20" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.updatedEvents).toBe(1);

    const override = hoisted.db
      .prepare("SELECT release_time, source FROM symbol_release_times WHERE symbol = 'XMTR'")
      .get();
    expect(override).toEqual({ release_time: "16:20", source: "user" });

    const event = hoisted.db
      .prepare("SELECT release_time FROM calendar_events WHERE symbol = 'XMTR'")
      .get() as { release_time: string };
    expect(event.release_time).toBe("16:20");
  });

  it("a symbol with no upcoming event is never guarded (200, writes as before)", async () => {
    const res = await POST(postReq({ symbol: "NOPE", releaseTime: "07:30" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

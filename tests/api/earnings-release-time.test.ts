/**
 * Tests for GET + POST /api/earnings/release-time (Task 5, earnings
 * wire-time tracking spec 2026-08-04).
 *
 * The lib composition pieces (cascade resolution, PK-precedence upsert,
 * clear semantics) are covered in tests/earnings/wire-times.test.ts and
 * tests/earnings/release-time-route.test.ts. These tests pin the
 * route-layer contract: validation 400s (including the "10:99" shape-valid-
 * but-not-a-real-time case), the GET response shape, and the POST
 * write/clear success shapes.
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
import { GET, POST } from "@/app/api/earnings/release-time/route";

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

function getReq(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/earnings/release-time${qs}`);
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/earnings/release-time", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/earnings/release-time", () => {
  it("400s when symbol is missing", async () => {
    const res = await GET(getReq("?slot=bmo"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns resolved + override + observations for an unknown symbol (all empty/null)", async () => {
    const res = await GET(getReq("?symbol=xmtr&slot=bmo"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.symbol).toBe("XMTR"); // uppercased
    expect(body.data.resolved).toBeNull();
    expect(body.data.override).toBeNull();
    expect(body.data.observations).toEqual([]);
  });

  it("surfaces a standing user override as both resolved and override", async () => {
    await POST(postReq({ symbol: "XMTR", releaseTime: "07:00" }));
    const res = await GET(getReq("?symbol=XMTR&slot=bmo"));
    const body = await res.json();
    expect(body.data.resolved).toEqual({ time: "07:00", source: "user" });
    expect(body.data.override).toMatchObject({ release_time: "07:00", source: "user" });
  });

  it("ignores an unrecognized slot value (treated as null/no guard)", async () => {
    const res = await GET(getReq("?symbol=XMTR&slot=noon"));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/earnings/release-time", () => {
  it("400s when symbol is missing", async () => {
    const res = await POST(postReq({ releaseTime: "07:00" }));
    expect(res.status).toBe(400);
  });

  it("400s on malformed shape (no colon)", async () => {
    const res = await POST(postReq({ symbol: "XMTR", releaseTime: "0700" }));
    expect(res.status).toBe(400);
  });

  it('400s on "10:99" — shape-valid (two digits, colon, two digits) but not a real clock time', async () => {
    const res = await POST(postReq({ symbol: "XMTR", releaseTime: "10:99" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/24-hour/i);
    // No API parameter name leaks into the user-facing message — catch both
    // camelCase and a future snake_case rename, case-insensitively.
    expect(body.error).not.toMatch(/release_?time/i);
    // Never wrote a durable row.
    const row = hoisted.db
      .prepare("SELECT * FROM symbol_release_times WHERE symbol = 'XMTR'")
      .get();
    expect(row).toBeUndefined();
  });

  it('400s on "19:99" (would otherwise slip a naive string range compare against 20:00)', async () => {
    const res = await POST(postReq({ symbol: "XMTR", releaseTime: "19:99" }));
    expect(res.status).toBe(400);
  });

  it("400s on an out-of-range but validly-shaped time (before EARLIEST_PLAUSIBLE_ET)", async () => {
    const res = await POST(postReq({ symbol: "XMTR", releaseTime: "02:00" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/between 04:00 and 20:00/);
    // The refusal must not assert a claim about the world (late prints do
    // happen) — it should read as a plausibility judgment about THIS input.
    expect(body.error).toMatch(/almost certainly a call time, not the print/);
    expect(body.error).not.toMatch(/do not print/i);
    expect(body.error).not.toMatch(/release_?time/i);
  });

  it("400s on an out-of-range but validly-shaped time (after LATEST_PLAUSIBLE_ET)", async () => {
    const res = await POST(postReq({ symbol: "XMTR", releaseTime: "21:00" }));
    expect(res.status).toBe(400);
  });

  it("writes a user override and returns updatedEvents on a valid time", async () => {
    const res = await POST(postReq({ symbol: "xmtr", releaseTime: "07:15" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.data.updatedEvents).toBe("number");

    const row = hoisted.db
      .prepare("SELECT release_time, source FROM symbol_release_times WHERE symbol = 'XMTR'")
      .get();
    expect(row).toEqual({ release_time: "07:15", source: "user" });
  });

  it("releaseTime: null clears an existing user override (cleared=true)", async () => {
    await POST(postReq({ symbol: "XMTR", releaseTime: "07:15" }));
    const res = await POST(postReq({ symbol: "XMTR", releaseTime: null }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ cleared: true });

    const row = hoisted.db
      .prepare("SELECT * FROM symbol_release_times WHERE symbol = 'XMTR'")
      .get();
    expect(row).toBeUndefined();
  });

  it("releaseTime: null against a symbol with no override is a no-op (cleared=false, updatedEvents=0)", async () => {
    const res = await POST(postReq({ symbol: "NOPE", releaseTime: null }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ cleared: false, updatedEvents: 0 });
  });
});

// Unit 17 (2026-10-08): Save over a web-verified time asks first.
describe("POST /api/earnings/release-time over a web-verified time", () => {
  function seedWebVerified(symbol: string, time = "16:05") {
    hoisted.db
      .prepare(
        `INSERT INTO symbol_release_times (symbol, release_time, source, note, verified_for_date, updated_at)
         VALUES (?, ?, 'web_verified', 'company schedule page', '2099-01-05', datetime('now'))`,
      )
      .run(symbol, time);
  }
  const row = (symbol: string) =>
    hoisted.db
      .prepare("SELECT release_time, source, note, verified_for_date FROM symbol_release_times WHERE symbol = ?")
      .get(symbol);

  it("answers 409 would_replace_web_verified and stores nothing", async () => {
    seedWebVerified("ZZA");
    const res = await POST(postReq({ symbol: "ZZA", releaseTime: "16:30" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("would_replace_web_verified");
    expect(body.data).toEqual({
      releaseTime: "16:05",
      verifiedForDate: "2099-01-05",
      note: "company schedule page",
    });
    expect(body.error).toContain("16:05");
    expect(body.error).toMatch(/Clear will not bring/);
    expect(row("ZZA")).toEqual({
      release_time: "16:05",
      source: "web_verified",
      note: "company schedule page",
      verified_for_date: "2099-01-05",
    });
  });

  it("saves once the body carries replaceWebVerified: true", async () => {
    seedWebVerified("ZZA");
    const res = await POST(postReq({ symbol: "ZZA", releaseTime: "16:30", replaceWebVerified: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(row("ZZA")).toMatchObject({ release_time: "16:30", source: "user" });
  });

  it("only the boolean true acknowledges", async () => {
    seedWebVerified("ZZA");
    for (const flag of ["true", 1, "yes", {}]) {
      const res = await POST(postReq({ symbol: "ZZA", releaseTime: "16:30", replaceWebVerified: flag }));
      expect(res.status).toBe(409);
    }
    // `force` belongs to other routes and answers nothing here.
    const forced = await POST(postReq({ symbol: "ZZA", releaseTime: "16:30", force: true }));
    expect(forced.status).toBe(409);
    expect(row("ZZA")).toMatchObject({ release_time: "16:05", source: "web_verified" });
  });

  it("the acknowledgement never answers the slot check", async () => {
    seedWebVerified("ZZA");
    hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, symbol, title, source_key, week_of)
         VALUES ('finnhub','earnings','2099-01-05','AMC','16:05','ZZA','ZZA earnings','finnhub:ZZA:2099-01-05','2099-01-05')`,
      )
      .run();
    const res = await POST(postReq({ symbol: "ZZA", releaseTime: "07:30", replaceWebVerified: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("slot_mismatch");
    expect(row("ZZA")).toMatchObject({ release_time: "16:05", source: "web_verified" });
  });

  it("does not ask over a suspect call time (web-verified, 17:00 or later)", async () => {
    seedWebVerified("ZZA", "17:00");
    const res = await POST(postReq({ symbol: "ZZA", releaseTime: "16:10" }));
    expect(res.status).toBe(200);
    expect(row("ZZA")).toMatchObject({ release_time: "16:10", source: "user" });
  });

  it("the full loss the question guards: acknowledged Save then Clear leaves no row", async () => {
    seedWebVerified("ZZA");
    await POST(postReq({ symbol: "ZZA", releaseTime: "16:30", replaceWebVerified: true }));
    const cleared = await POST(postReq({ symbol: "ZZA", releaseTime: null }));
    expect((await cleared.json()).data.cleared).toBe(true);
    expect(row("ZZA")).toBeUndefined();
  });

  it("Clear alone never touches a web-verified row", async () => {
    seedWebVerified("ZZA");
    const res = await POST(postReq({ symbol: "ZZA", releaseTime: null }));
    expect((await res.json()).data.cleared).toBe(false);
    expect(row("ZZA")).toMatchObject({ release_time: "16:05", source: "web_verified" });
  });

  it("GET says how the standing row is used", async () => {
    seedWebVerified("ZZA", "17:00");
    seedWebVerified("ZZB");
    const suspect = await (await GET(getReq("?symbol=ZZA&slot=amc"))).json();
    expect(suspect.data.overrideUse).toBe("suspect_call_time");
    expect(suspect.data.resolved).toBeNull();
    const used = await (await GET(getReq("?symbol=ZZB&slot=amc"))).json();
    expect(used.data.overrideUse).toBe("in_effect");
    const none = await (await GET(getReq("?symbol=ZZC&slot=amc"))).json();
    expect(none.data.overrideUse).toBeNull();
  });
});

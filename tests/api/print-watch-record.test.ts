/**
 * GET /api/print-watch/record?eventId=<id>: the scoped read behind the
 * read-only record of a finished print (sprint 2 unit B2).
 *
 * Pattern per tests/api/print-watch-outputs.test.ts: mock the db singleton with
 * an in-memory migrated getter and dynamic-import the route.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { markLineAccepted, setPrintState, upsertLines, upsertPrint } from "@/lib/print-watch/store";
import { classifyRoute } from "@/lib/auth/route-policy";
import { todayET } from "@/lib/calendar/date-utils";
import type { PrintWatchLine } from "@/lib/print-watch/types";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const PAST = todayET(new Date(Date.now() - 3 * 86_400_000));
let eventId: number;
let printId: number;

function revenueLine(): PrintWatchLine {
  return {
    metric_id: "revenue_q",
    contract: {
      metric_id: "revenue_q",
      label: "Revenue",
      definition: "d",
      basis: "gaap",
      period: "Q",
      currency: "USD",
      unit: "usd",
      kind: "point",
      segment: null,
    },
    expected: null,
    state: "agreed",
    value: 2_000_000_000,
    value_high: null,
    snippet: "Revenue $2.0 billion",
    source_doc_id: null,
    candidates_json: "[]",
  };
}

function get(query: string) {
  return new NextRequest(`http://127.0.0.1:3099/api/print-watch/record${query}`);
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  eventId = Number(
    hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual','earnings',?,'ZZA earnings','ZZA','k1')`,
      )
      .run(PAST).lastInsertRowid,
  );
  printId = upsertPrint(hoisted.db, eventId, "ZZA", PAST, "16:05");
  upsertLines(hoisted.db, printId, [revenueLine()]);
  markLineAccepted(hoisted.db, printId, "revenue_q");
  setPrintState(hoisted.db, printId, "expired");
});

afterEach(() => {
  hoisted.db.close();
});

describe("GET /api/print-watch/record", () => {
  it("returns the finished print, its lines and its outputs in the standard envelope", async () => {
    const { GET } = await import("@/app/api/print-watch/record/route");
    const res = await GET(get(`?eventId=${eventId}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.print).toEqual({ printId, symbol: "ZZA", eventDate: PAST, state: "expired" });
    expect(body.data.lines).toHaveLength(1);
    expect(body.data.lines[0].state).toBe("accepted");
    expect(body.data.outputs.printSheet.enabled).toBe(true);
  });

  it("answers 200 with a null print for an event that never had one", async () => {
    const { GET } = await import("@/app/api/print-watch/record/route");
    const res = await GET(get(`?eventId=${eventId + 500}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: { eventId: eventId + 500, print: null, lines: [], documents: {}, outputs: null },
    });
  });

  it("refuses a missing or malformed eventId with a 400", async () => {
    const { GET } = await import("@/app/api/print-watch/record/route");
    for (const query of ["", "?eventId=", "?eventId=abc", "?eventId=0", "?eventId=-4", "?eventId=1.5"]) {
      const res = await GET(get(query));
      expect(res.status, query).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe("string");
    }
  });

  it("stays a pure read: nothing in the DB changes across two GETs", async () => {
    const { GET } = await import("@/app/api/print-watch/record/route");
    const before = hoisted.db.prepare("SELECT total_changes() AS n").get() as { n: number };
    await GET(get(`?eventId=${eventId}`));
    await GET(get(`?eventId=${eventId}`));
    const after = hoisted.db.prepare("SELECT total_changes() AS n").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("is a human route like its sibling print-watch reads, and a thin wrapper", () => {
    expect(classifyRoute("GET", "/api/print-watch/record")).toBe(
      classifyRoute("GET", "/api/print-watch/sources"),
    );
    const src = readFileSync("app/api/print-watch/record/route.ts", "utf8");
    expect(src).toContain("getPrintRecord(db,");
    // The assembly lives in lib; the route never reaches the store itself.
    expect(src).not.toContain("@/lib/print-watch/store");
    expect(src).not.toContain("ensure");
  });
});

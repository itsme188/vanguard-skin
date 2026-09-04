/**
 * HTTP-boundary tests for POST /api/calendar/events — the
 * would-supersede-a-vendor-date guard
 * (qa:today-earningshub-add-ticker--manual-add-silently-supersedes-vendor-date-other-week).
 *
 * User ruling 2026-09-02 (Option 1): a manual add that would knock a live
 * vendor earnings date off the calendar refuses with 409
 * `would_supersede_vendor` and writes NOTHING; the same POST with
 * `force: true` skips the check and inserts. Same shape as the
 * approveLevelGuarded 409 + force path on /api/levels/review.
 *
 * Dates are derived from todayET() rather than hardcoded, so the fixture can
 * never go wall-clock stale: `manualDate` is the Monday of next week and
 * `vendorDate` the Monday after it — always future, always a DIFFERENT week,
 * always inside the reconciler's 14-day clustering proximity.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, mondayOf, todayET } from "@/lib/calendar/date-utils";
// Static import (vi.mock is hoisted above it): the route pulls a large module
// graph, and paying that inside the first `it` blows the 5s test timeout on a
// busy machine.
import { POST } from "@/app/api/calendar/events/route";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const manualDate = mondayOf(addDays(todayET(), 7));
const vendorDate = addDays(manualDate, 7);
const sameWeekAsVendor = addDays(vendorDate, 1);

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  // The post-commit outbox drain must stay a no-op in tests: with no Worker
  // configured it skips before any fetch.
  delete process.env.WORKER_MARKER_URL;
  delete process.env.CRON_SHARED_SECRET;
});

function seedVendorRow(symbol: string, date: string, source = "finnhub"): number {
  return hoisted.db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, week_of, raw_json)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, '{}')`,
    )
    .run(
      source,
      date,
      `${symbol} earnings`,
      symbol,
      `${source}:${symbol}:${date}:earnings`,
      mondayOf(date),
    ).lastInsertRowid as number;
}

function postReq(body: unknown): Request {
  return new Request("http://test/api/calendar/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function manualRows(symbol: string) {
  return hoisted.db
    .prepare(
      "SELECT id, event_date FROM calendar_events WHERE source = 'manual' AND symbol = ?",
    )
    .all(symbol) as Array<{ id: number; event_date: string }>;
}

describe("POST /api/calendar/events — would_supersede_vendor guard", () => {
  it("refuses with 409 and writes nothing when the add would displace a vendor date in another week", async () => {
    const vendorId = seedVendorRow("ZQTEST", vendorDate);

    const res = await POST(
      postReq({ symbol: "ZQTEST", event_date: manualDate, event_time: "AMC", event_type: "earnings" }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      success: boolean;
      error: string;
      code: string;
      vendorEventId: number;
      vendorDate: string;
      vendorSource: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe("would_supersede_vendor");
    expect(body.vendorEventId).toBe(vendorId);
    expect(body.vendorDate).toBe(vendorDate);
    expect(body.vendorSource).toBe("finnhub");
    // Plain English, naming the symbol, the vendor date and its source.
    expect(body.error).toContain("ZQTEST");
    expect(body.error).toContain(vendorDate);
    expect(body.error).toMatch(/finnhub/i);

    // Refused means refused: no manual row, and the vendor row untouched.
    expect(manualRows("ZQTEST")).toHaveLength(0);
    const vendor = hoisted.db
      .prepare("SELECT COALESCE(superseded,0) AS superseded FROM calendar_events WHERE id = ?")
      .get(vendorId) as { superseded: number };
    expect(vendor.superseded).toBe(0);
  });

  it("inserts on the same POST with force:true", async () => {
    seedVendorRow("ZQTEST", vendorDate);

    const res = await POST(
      postReq({
        symbol: "ZQTEST",
        event_date: manualDate,
        event_time: "AMC",
        event_type: "earnings",
        force: true,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; id: number };
    expect(body.success).toBe(true);

    const rows = manualRows("ZQTEST");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(body.id);
    expect(rows[0].event_date).toBe(manualDate);
  });

  it("does not gate a same-week add (confirming the vendor's own week)", async () => {
    seedVendorRow("ZQTEST", vendorDate);

    const res = await POST(
      postReq({ symbol: "ZQTEST", event_date: sameWeekAsVendor, event_time: "BMO", event_type: "earnings" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(manualRows("ZQTEST")).toHaveLength(1);
  });

  it("inserts normally when there is no vendor row at all", async () => {
    const res = await POST(
      postReq({ symbol: "ZQTEST", event_date: manualDate, event_time: "AMC", event_type: "earnings" }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(manualRows("ZQTEST")).toHaveLength(1);
  });
});

/**
 * HTTP-boundary tests for POST /api/earnings/actuals — the pre-print floor
 * guard (QA finding today-bogeys-actuals--future-print-actuals-accepted-no-guard,
 * severity HIGH): "Save actuals" on the Today tab's Earnings Hub bogeys
 * modal must not accept a print whose recorded release instant is still in
 * the future without an explicit force:true override. Mirrors
 * tests/api/levels-review-route.test.ts (same 409 + force override shape
 * as approveLevelGuarded).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  vi.useRealTimers();
});

function seedEvent(opts: {
  eventDate: string;
  releaseTime: string | null;
  actual?: string | null;
}): number {
  const row = hoisted.db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, source_key, actual_value
       ) VALUES ('finnhub','earnings',?,?,?,?,?,?,?)
       RETURNING id`,
    )
    .get(
      opts.eventDate,
      opts.releaseTime,
      opts.releaseTime,
      "XMTR earnings",
      "XMTR",
      `finnhub:XMTR:${opts.eventDate}`,
      opts.actual ?? null,
    ) as { id: number };
  return row.id;
}

function postReq(body: unknown): Request {
  return new Request("http://test/api/earnings/actuals", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/earnings/actuals — pre-print floor", () => {
  it("refuses a future release instant without force: nothing written, enriched_at not stamped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00Z")); // "today"
    const eventId = seedEvent({ eventDate: "2026-08-21", releaseTime: "07:30" }); // 2 days ahead

    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(
      postReq({ event_id: eventId, eps_actual: 0.91 }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("pre_print");
    expect(body.error).toMatch(/future/i);

    const row = hoisted.db
      .prepare(`SELECT actual_value, enriched_at FROM calendar_events WHERE id = ?`)
      .get(eventId) as { actual_value: string | null; enriched_at: string | null };
    expect(row.actual_value).toBeNull();
    expect(row.enriched_at).toBeNull();
  });

  it("accepts a future release instant when force:true is passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));
    const eventId = seedEvent({ eventDate: "2026-08-21", releaseTime: "07:30" });

    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(
      postReq({ event_id: eventId, eps_actual: 0.91, force: true }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; actual_value: string };
    expect(body.success).toBe(true);
    expect(body.actual_value).toContain("0.91");

    const row = hoisted.db
      .prepare(`SELECT actual_value, enriched_at FROM calendar_events WHERE id = ?`)
      .get(eventId) as { actual_value: string | null; enriched_at: string | null };
    expect(row.actual_value).toContain("0.91");
    expect(row.enriched_at).not.toBeNull();
  });

  it("accepts a past release instant as today (no force needed)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));
    const eventId = seedEvent({ eventDate: "2026-08-19", releaseTime: "07:30" }); // already printed

    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(
      postReq({ event_id: eventId, eps_actual: 1.05, revenue_actual_usd: 500_000_000 }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; actual_value: string };
    expect(body.success).toBe(true);
    expect(body.actual_value).toBe("EPS 1.05 · Rev 500000000");

    const row = hoisted.db
      .prepare(`SELECT actual_value, enriched_at FROM calendar_events WHERE id = ?`)
      .get(eventId) as { actual_value: string | null; enriched_at: string | null };
    expect(row.actual_value).toBe("EPS 1.05 · Rev 500000000");
    expect(row.enriched_at).not.toBeNull();
  });

  it("an event with no release_time is treated as usable (unknown release instants pass)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));
    const eventId = seedEvent({ eventDate: "2026-08-21", releaseTime: null });

    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(postReq({ event_id: eventId, eps_actual: 0.91 }));

    expect(res.status).toBe(200);
  });

  it("404s for an unknown event_id — nothing written", async () => {
    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(postReq({ event_id: 999999, eps_actual: 0.91 }));
    expect(res.status).toBe(404);
  });

  it("400s when neither eps_actual nor revenue_actual_usd is provided", async () => {
    const eventId = seedEvent({ eventDate: "2026-08-19", releaseTime: "07:30" });
    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(postReq({ event_id: eventId }));
    expect(res.status).toBe(400);
  });
});

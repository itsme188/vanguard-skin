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
  /** Defaults to releaseTime (the historical shape of this helper). */
  eventTime?: string | null;
  rawJson?: string | null;
}): number {
  const row = hoisted.db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, source_key, actual_value, raw_json
       ) VALUES ('finnhub','earnings',?,?,?,?,?,?,?,?)
       RETURNING id`,
    )
    .get(
      opts.eventDate,
      opts.eventTime === undefined ? opts.releaseTime : opts.eventTime,
      opts.releaseTime,
      "XMTR earnings",
      "XMTR",
      `finnhub:XMTR:${opts.eventDate}`,
      opts.actual ?? null,
      opts.rawJson ?? null,
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
    // Slot floor wording (2026-08-28): the row is BMO, so the message names
    // the 07:00 ET floor for the print date rather than the raw release_time.
    expect(body.error).toMatch(/before-open print/);
    expect(body.error).toContain("7:00 AM ET");

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

/**
 * Slot floor — the AMC call-time trap (owner report, live 2026-08-26/27).
 *
 * A vendor/web release_time of 17:00 on an after-close name is almost always
 * the CALL time, not the print: accepting a real 16:05 print at 16:12 ET was
 * refused as "still in the future". saveManualActuals now floors on the slot
 * (16:00 ET after-close, 07:00 ET before-open) instead of a time it does not
 * trust, and names that basis in the refusal.
 */
describe("POST /api/earnings/actuals — slot floor (AMC call-time trap)", () => {
  const AMC_RAW = JSON.stringify({ entry: { hour: "amc" } });

  it("accepts an AMC print at 16:12 ET even though release_time carries the 17:00 call time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T20:12:00Z")); // 16:12 ET
    const eventId = seedEvent({
      eventDate: "2026-08-27",
      releaseTime: "17:00",
      eventTime: null,
      rawJson: AMC_RAW,
    });

    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(postReq({ event_id: eventId, eps_actual: 1.42 }));

    expect(res.status).toBe(200);
    const row = hoisted.db
      .prepare(`SELECT actual_value, enriched_at FROM calendar_events WHERE id = ?`)
      .get(eventId) as { actual_value: string | null; enriched_at: string | null };
    expect(row.actual_value).toContain("1.42");
    expect(row.enriched_at).not.toBeNull();
  });

  it("still refuses the same AMC print at 15:30 ET, naming the after-close floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T19:30:00Z")); // 15:30 ET
    const eventId = seedEvent({
      eventDate: "2026-08-27",
      releaseTime: "17:00",
      eventTime: null,
      rawJson: AMC_RAW,
    });

    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(postReq({ event_id: eventId, eps_actual: 1.42 }));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("pre_print");
    expect(body.error).toMatch(/after-close print/);
    expect(body.error).toContain("4:00 PM ET");

    const row = hoisted.db
      .prepare(`SELECT actual_value, enriched_at FROM calendar_events WHERE id = ?`)
      .get(eventId) as { actual_value: string | null; enriched_at: string | null };
    expect(row.actual_value).toBeNull();
    expect(row.enriched_at).toBeNull();
  });

  it("force:true still bypasses the slot floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T19:30:00Z")); // 15:30 ET
    const eventId = seedEvent({
      eventDate: "2026-08-27",
      releaseTime: "17:00",
      eventTime: null,
      rawJson: AMC_RAW,
    });

    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(
      postReq({ event_id: eventId, eps_actual: 1.42, force: true }),
    );
    expect(res.status).toBe(200);
  });

  it("a slot-less (TAS) row keeps the release_time wording and floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T20:12:00Z")); // 16:12 ET
    const eventId = seedEvent({
      eventDate: "2026-08-27",
      releaseTime: "17:00",
      eventTime: "TAS",
      rawJson: AMC_RAW,
    });

    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(postReq({ event_id: eventId, eps_actual: 1.42 }));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("pre_print");
    expect(body.error).toMatch(/still in the future/);
  });
});

/**
 * "Clear actuals" control (QA finding
 * today-earningshub-bogeys--save-actuals-empty-silent-noop-cannot-clear,
 * decided 2026-08-03; re-confirmed 2026-08-20 DECISIONS-PENDING Option 2):
 * a dedicated clear mode nulls actual_value for MANUAL overrides only —
 * gated on calendar_events.manual_actuals_at (migration 084), which
 * saveManualActuals now stamps on every manual save. Sync-owned actuals
 * (Finnhub/FRED/Claude enrichment, manual_actuals_at IS NULL) stay
 * protected: clearing 409s instead of silently wiping a real print.
 */
describe("POST /api/earnings/actuals — clear mode", () => {
  it("save stamps manual_actuals_at", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));
    const eventId = seedEvent({ eventDate: "2026-08-19", releaseTime: "07:30" });

    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(postReq({ event_id: eventId, eps_actual: 0.91 }));
    expect(res.status).toBe(200);

    const row = hoisted.db
      .prepare(`SELECT manual_actuals_at FROM calendar_events WHERE id = ?`)
      .get(eventId) as { manual_actuals_at: string | null };
    expect(row.manual_actuals_at).not.toBeNull();
  });

  it("clears actual_value, enriched_at, manual_actuals_at, and actual_missing_alerted_at on a manual-stamped row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));
    const eventId = seedEvent({ eventDate: "2026-08-19", releaseTime: "07:30" });

    const mod = await import("@/app/api/earnings/actuals/route");
    // Manual save first — stamps manual_actuals_at.
    const saveRes = await mod.POST(postReq({ event_id: eventId, eps_actual: 0.91 }));
    expect(saveRes.status).toBe(200);
    hoisted.db
      .prepare(`UPDATE calendar_events SET actual_missing_alerted_at = datetime('now') WHERE id = ?`)
      .run(eventId);

    const clearRes = await mod.POST(postReq({ event_id: eventId, clear: true }));
    expect(clearRes.status).toBe(200);
    const body = (await clearRes.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const row = hoisted.db
      .prepare(
        `SELECT actual_value, enriched_at, manual_actuals_at, actual_missing_alerted_at
           FROM calendar_events WHERE id = ?`,
      )
      .get(eventId) as {
      actual_value: string | null;
      enriched_at: string | null;
      manual_actuals_at: string | null;
      actual_missing_alerted_at: string | null;
    };
    expect(row.actual_value).toBeNull();
    expect(row.enriched_at).toBeNull();
    expect(row.manual_actuals_at).toBeNull();
    expect(row.actual_missing_alerted_at).toBeNull();
  });

  it("leaves consensus_value untouched on clear", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));
    const eventId = seedEvent({ eventDate: "2026-08-19", releaseTime: "07:30" });
    hoisted.db
      .prepare(`UPDATE calendar_events SET consensus_value = 'EPS 0.85' WHERE id = ?`)
      .run(eventId);

    const mod = await import("@/app/api/earnings/actuals/route");
    await mod.POST(postReq({ event_id: eventId, eps_actual: 0.91 }));
    await mod.POST(postReq({ event_id: eventId, clear: true }));

    const row = hoisted.db
      .prepare(`SELECT consensus_value FROM calendar_events WHERE id = ?`)
      .get(eventId) as { consensus_value: string | null };
    expect(row.consensus_value).toBe("EPS 0.85");
  });

  it("409s clearing a row whose actuals were never manually saved (sync-owned)", async () => {
    const eventId = seedEvent({
      eventDate: "2026-08-19",
      releaseTime: "07:30",
      actual: "EPS 1.10 · Rev 500000000",
    });

    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(postReq({ event_id: eventId, clear: true }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toMatch(/manual/i);

    const row = hoisted.db
      .prepare(`SELECT actual_value FROM calendar_events WHERE id = ?`)
      .get(eventId) as { actual_value: string | null };
    expect(row.actual_value).toBe("EPS 1.10 · Rev 500000000");
  });

  it("400s when clear:true is combined with eps_actual or revenue_actual_usd", async () => {
    const eventId = seedEvent({ eventDate: "2026-08-19", releaseTime: "07:30" });
    const mod = await import("@/app/api/earnings/actuals/route");

    const res1 = await mod.POST(
      postReq({ event_id: eventId, clear: true, eps_actual: 0.91 }),
    );
    expect(res1.status).toBe(400);

    const res2 = await mod.POST(
      postReq({ event_id: eventId, clear: true, revenue_actual_usd: 500_000_000 }),
    );
    expect(res2.status).toBe(400);
  });

  it("404s clearing an unknown event_id", async () => {
    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.POST(postReq({ event_id: 999999, clear: true }));
    expect(res.status).toBe(404);
  });
});

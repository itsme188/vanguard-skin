/**
 * Phase 9b — Mac reconcile endpoint tests.
 *
 * Simulates a POST to /api/calendar/reconcile-cloud-enrich by invoking the
 * route handler directly. Covers the TWS-always-wins precedence rule and
 * idempotency (already-enriched rows preserve their reaction snapshot).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";

// Mock @/lib/db so the route handler uses our in-memory DB.
let testDb: Database.Database;
vi.mock("@/lib/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import the route AFTER the mock so the module-local `db` resolves correctly.
import { POST } from "@/app/api/calendar/reconcile-cloud-enrich/route";

function insertEvent(
  db: Database.Database,
  opts: {
    id: number;
    reaction_snapshot?: string | null;
    enriched_at?: string | null;
    actual_value?: string | null;
    consensus_value?: string | null;
  },
) {
  db.prepare(
    `INSERT INTO calendar_events
       (id, source, event_type, event_date, event_time, title, source_key, week_of,
        reaction_snapshot, enriched_at, actual_value, consensus_value)
     VALUES (?, 'claude_macro', 'cpi', '2026-04-24', '08:30', 'Test', ?, '2026-04-24',
             ?, ?, ?, ?)`,
  ).run(
    opts.id,
    `fred:10:2026-04-24-${opts.id}`,
    opts.reaction_snapshot ?? null,
    opts.enriched_at ?? null,
    opts.actual_value ?? null,
    opts.consensus_value ?? null,
  );
}

function makeRequest(headers: Record<string, string> = { "x-cron-secret": "test-secret" }) {
  return new NextRequest("http://localhost:3000/api/calendar/reconcile-cloud-enrich", {
    method: "POST",
    headers,
  });
}

describe("POST /api/calendar/reconcile-cloud-enrich", () => {
  beforeEach(() => {
    testDb = new Database(":memory:");
    testDb.pragma("foreign_keys = ON");
    runMigrations(testDb);
    vi.stubGlobal("fetch", vi.fn());
    process.env.CRON_SHARED_SECRET = "test-secret";
    process.env.WORKER_MARKER_URL = "https://example.workers.dev/internal/marker";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    testDb.close();
    delete process.env.CRON_SHARED_SECRET;
    delete process.env.WORKER_MARKER_URL;
  });

  it("is a no-op when WORKER_MARKER_URL is unset", async () => {
    delete process.env.WORKER_MARKER_URL;
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reconciled).toBe(0);
    expect(body.note).toMatch(/WORKER_MARKER_URL/);
  });

  it("returns 403 when X-Cron-Secret is provided but wrong", async () => {
    const res = await POST(makeRequest({ "x-cron-secret": "wrong" }));
    expect(res.status).toBe(403);
  });

  it("returns 403 when X-Cron-Secret is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(403);
  });

  it("returns 500 when CRON_SHARED_SECRET is not configured", async () => {
    delete process.env.CRON_SHARED_SECRET;
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(500);
  });

  it("returns 502 when Worker returns an error", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      async json() {
        return {};
      },
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(502);
  });

  it("upserts both actual and reaction when the row has no existing snapshot", async () => {
    insertEvent(testDb, { id: 100 });

    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") return { ok: true, async json() { return {}; } };
      return {
        ok: true,
        async json() {
          return {
            payloads: {
              "100": {
                eventId: 100,
                source_key: "fred:10:2026-04-24",
                actual: "3.2%",
                consensus: "3.1%",
                source: "fred",
                reaction: { source: "polygon", t0_utc: "2026-04-24T12:30:00Z", window_min: 120, spy: { t_pre: 500, t_post: 502, delta_pct: 0.4 }, qqq: { t_pre: 400, t_post: 402, delta_pct: 0.5 }, tlt: { t_pre: 90, t_post: 89, delta_pct: -1.1 } },
                fetchedAt: new Date().toISOString(),
              },
            },
          };
        },
      };
    });

    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reconciled).toBe(1);
    expect(body.skipped_tws_wins).toBe(0);

    const row = testDb
      .prepare("SELECT actual_value, consensus_value, reaction_snapshot, enriched_at FROM calendar_events WHERE id = 100")
      .get() as { actual_value: string; consensus_value: string; reaction_snapshot: string; enriched_at: string };

    expect(row.actual_value).toBe("3.2%");
    expect(row.consensus_value).toBe("3.1%");
    const snapshot = JSON.parse(row.reaction_snapshot);
    expect(snapshot.source).toBe("polygon");
    expect(row.enriched_at).toBeTruthy();
  });

  it("TWS-always-wins — preserves existing tws snapshot, still upserts actual", async () => {
    const existingTws = JSON.stringify({
      source: "tws",
      t0_utc: "2026-04-24T12:30:00Z",
      window_min: 120,
      spy: { t_pre: 500, t_post: 503, delta_pct: 0.6 },
      qqq: { t_pre: 400, t_post: 403, delta_pct: 0.75 },
      tlt: { t_pre: 90, t_post: 89.5, delta_pct: -0.55 },
    });
    insertEvent(testDb, { id: 200, reaction_snapshot: existingTws, enriched_at: "2026-04-24T12:35:00" });

    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") return { ok: true, async json() { return {}; } };
      return {
        ok: true,
        async json() {
          return {
            payloads: {
              "200": {
                eventId: 200,
                source_key: "fred:10:2026-04-24",
                actual: "3.2%",
                consensus: null,
                source: "fred",
                reaction: { source: "polygon", t0_utc: "2026-04-24T12:30:00Z", window_min: 120, spy: { t_pre: 500, t_post: 502, delta_pct: 0.4 }, qqq: { t_pre: 0, t_post: 0, delta_pct: 0 }, tlt: { t_pre: 0, t_post: 0, delta_pct: 0 } },
                fetchedAt: new Date().toISOString(),
              },
            },
          };
        },
      };
    });

    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reconciled).toBe(1);
    expect(body.skipped_tws_wins).toBe(1);

    const row = testDb
      .prepare("SELECT actual_value, reaction_snapshot FROM calendar_events WHERE id = 200")
      .get() as { actual_value: string; reaction_snapshot: string };

    expect(row.actual_value).toBe("3.2%");
    const snapshot = JSON.parse(row.reaction_snapshot);
    // TWS preserved; polygon did NOT overwrite.
    expect(snapshot.source).toBe("tws");
  });

  it("overwrites an existing polygon snapshot (same-source re-upsert is safe)", async () => {
    const existingPolygon = JSON.stringify({
      source: "polygon",
      t0_utc: "2026-04-24T12:30:00Z",
      window_min: 120,
      spy: { t_pre: 500, t_post: 501, delta_pct: 0.2 },
      qqq: { t_pre: 0, t_post: 0, delta_pct: 0 },
      tlt: { t_pre: 0, t_post: 0, delta_pct: 0 },
    });
    insertEvent(testDb, { id: 300, reaction_snapshot: existingPolygon });

    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") return { ok: true, async json() { return {}; } };
      return {
        ok: true,
        async json() {
          return {
            payloads: {
              "300": {
                eventId: 300,
                source_key: "fred:10:2026-04-24",
                actual: "3.2%",
                consensus: null,
                source: "fred",
                reaction: { source: "polygon", t0_utc: "2026-04-24T12:30:00Z", window_min: 120, spy: { t_pre: 500, t_post: 504, delta_pct: 0.8 }, qqq: { t_pre: 0, t_post: 0, delta_pct: 0 }, tlt: { t_pre: 0, t_post: 0, delta_pct: 0 } },
                fetchedAt: new Date().toISOString(),
              },
            },
          };
        },
      };
    });

    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.skipped_tws_wins).toBe(0);
    const row = testDb
      .prepare("SELECT reaction_snapshot FROM calendar_events WHERE id = 300")
      .get() as { reaction_snapshot: string };
    const snap = JSON.parse(row.reaction_snapshot);
    expect(snap.spy.delta_pct).toBe(0.8); // updated
  });

  it("drains KV when the referenced event was deleted from the DB", async () => {
    // No insertEvent call — row doesn't exist.
    const deleteCalls: string[] = [];
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") {
        deleteCalls.push(url);
        return { ok: true, async json() { return {}; } };
      }
      return {
        ok: true,
        async json() {
          return {
            payloads: {
              "999": {
                eventId: 999,
                source_key: "fred:10:2026-04-24",
                actual: "3.2%",
                consensus: null,
                source: "fred",
                reaction: null,
                fetchedAt: new Date().toISOString(),
              },
            },
          };
        },
      };
    });

    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reconciled).toBe(0);
    // The KV delete for event 999 still ran, so the orphan payload is drained.
    expect(deleteCalls.some((u) => u.includes("eventId=999"))).toBe(true);
  });
});

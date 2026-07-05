import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileCloudEnrichment } from "@/lib/calendar/cloud-reconcile";

function mockWorker(payloads: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ payloads }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("reconcileCloudEnrichment data-preservation guards", () => {
  let db: Database.Database;
  let eventId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    const r = db
      .prepare(
        `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, symbol, actual_value, enriched_at)
       VALUES ('finnhub', 'finnhub:T:2026-07-28', 'earnings', '2026-07-28', '2026-07-27', 'T', 'T', 'EPS 1.42 · Rev 775,000,000', datetime('now'))`,
      )
      .run();
    eventId = Number(r.lastInsertRowid);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WORKER_MARKER_URL;
  });

  it("skips deferred payloads entirely", async () => {
    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:T:2026-07-28",
        actual: null,
        consensus: null,
        source: "cloud",
        deferred: true,
        reaction: null,
        fetchedAt: "2026-07-28T21:00:00Z",
      },
    });
    const res = await reconcileCloudEnrichment(db, "secret");
    expect(res.skipped_deferred).toBe(1);
    const row = db
      .prepare("SELECT actual_value FROM calendar_events WHERE id = ?")
      .get(eventId) as { actual_value: string };
    expect(row.actual_value).toBe("EPS 1.42 · Rev 775,000,000");
  });

  it("null actual in payload never clears an existing actual", async () => {
    mockWorker({
      [String(eventId)]: {
        eventId,
        source_key: "finnhub:T:2026-07-28",
        actual: null,
        consensus: null,
        source: "cloud",
        reaction: { source: "yahoo", spy: { delta_pct: 0.4 } },
        fetchedAt: "2026-07-28T21:00:00Z",
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    const row = db
      .prepare("SELECT actual_value, reaction_snapshot FROM calendar_events WHERE id = ?")
      .get(eventId) as { actual_value: string; reaction_snapshot: string | null };
    expect(row.actual_value).toBe("EPS 1.42 · Rev 775,000,000"); // preserved
    expect(row.reaction_snapshot).toContain("yahoo"); // reaction still added
  });

  it("reaction-only payload on a row with no actual does NOT stamp enriched_at", async () => {
    const r2 = db
      .prepare(
        `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, symbol)
       VALUES ('finnhub', 'finnhub:U:2026-07-28', 'earnings', '2026-07-28', '2026-07-27', 'U', 'U')`,
      )
      .run();
    const id2 = Number(r2.lastInsertRowid);
    mockWorker({
      [String(id2)]: {
        eventId: id2,
        source_key: "finnhub:U:2026-07-28",
        actual: null,
        consensus: null,
        source: "cloud",
        reaction: { source: "yahoo", spy: { delta_pct: 0.4 } },
        fetchedAt: "2026-07-28T21:00:00Z",
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    const row = db
      .prepare("SELECT enriched_at, reaction_snapshot FROM calendar_events WHERE id = ?")
      .get(id2) as { enriched_at: string | null; reaction_snapshot: string | null };
    expect(row.reaction_snapshot).toContain("yahoo");
    expect(row.enriched_at).toBeNull(); // Mac retry (Task 6) can still fetch the actual
  });

  it("TWS-wins branch does NOT stamp enriched_at when the row still lacks an actual (Task 6)", async () => {
    // A row that already has a TWS-sourced reaction (e.g. captured via the
    // Mac's own reaction-snapshot path) but no actual yet — enriched_at is
    // still NULL because Task 6's runner only stamps on completion.
    const r3 = db
      .prepare(
        `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, symbol, reaction_snapshot)
       VALUES ('finnhub', 'finnhub:V:2026-07-28', 'earnings', '2026-07-28', '2026-07-27', 'V', 'V', ?)`,
      )
      .run(JSON.stringify({ source: "tws", spy: { delta_pct: 0.1 } }));
    const id3 = Number(r3.lastInsertRowid);
    mockWorker({
      [String(id3)]: {
        eventId: id3,
        source_key: "finnhub:V:2026-07-28",
        actual: null,
        consensus: null,
        source: "cloud",
        reaction: { source: "yahoo", spy: { delta_pct: 0.4 } },
        fetchedAt: "2026-07-28T21:00:00Z",
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    const row = db
      .prepare("SELECT enriched_at, actual_value, reaction_snapshot FROM calendar_events WHERE id = ?")
      .get(id3) as { enriched_at: string | null; actual_value: string | null; reaction_snapshot: string | null };
    expect(row.enriched_at).toBeNull(); // TWS wins, but no actual → Mac retry keeps going
    expect(row.actual_value).toBeNull();
    // TWS reaction is preserved — the cloud payload's Yahoo reaction is discarded (TWS wins).
    expect(row.reaction_snapshot).toContain("tws");
  });
});

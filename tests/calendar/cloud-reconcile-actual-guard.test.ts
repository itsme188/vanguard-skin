import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/alerts/print-push", () => ({ sendEarningsPrintPush: vi.fn() }));
import { reconcileCloudEnrichment } from "@/lib/calendar/cloud-reconcile";

function mockWorker(payloads: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ payloads }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("reconcileCloudEnrichment never overwrites a local actual", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WORKER_MARKER_URL;
  });

  function insert(sym: string, actual: string | null, manualAt: string | null): number {
    return Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title, symbol, actual_value, manual_actuals_at)
           VALUES ('finnhub', ?, 'earnings', '2026-07-28', '2026-07-27', ?, ?, ?, ?)`,
        )
        .run(`finnhub:${sym}:2026-07-28`, sym, sym, actual, manualAt).lastInsertRowid,
    );
  }
  const get = (id: number) =>
    db.prepare(`SELECT actual_value, consensus_value FROM calendar_events WHERE id = ?`).get(id) as {
      actual_value: string | null;
      consensus_value: string | null;
    };

  it("keeps a manual actual when the cloud carries a different one; other fields still apply", async () => {
    const id = insert("MAN", "EPS 2.00", "2026-07-28 21:00:00");
    mockWorker({ [String(id)]: { eventId: id, actual: "EPS 9.99", consensus: "EPS 1.80", source: "cloud" } });
    const r = await reconcileCloudEnrichment(db, "secret");
    expect(r.ok).toBe(true);
    expect(get(id)).toEqual({ actual_value: "EPS 2.00", consensus_value: "EPS 1.80" });
  });

  it("fills a NULL local actual", async () => {
    const id = insert("NUL", null, null);
    mockWorker({ [String(id)]: { eventId: id, actual: "EPS 1.10", consensus: "EPS 1.00", source: "cloud" } });
    await reconcileCloudEnrichment(db, "secret");
    expect(get(id)).toEqual({ actual_value: "EPS 1.10", consensus_value: "EPS 1.00" });
  });

  it("a non-manual non-null actual is also kept (Mac is source of truth)", async () => {
    const id = insert("MAC", "EPS 1.50", null);
    mockWorker({ [String(id)]: { eventId: id, actual: "EPS 7.77", consensus: null, source: "cloud" } });
    await reconcileCloudEnrichment(db, "secret");
    expect(get(id).actual_value).toBe("EPS 1.50");
  });

  describe("a differing cloud actual is surfaced, not dropped silently", () => {
    it("warns once with the event id, symbol and both public values, and counts the conflict", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const id = insert("ZZA", "EPS 2.00", null);
      mockWorker({ [String(id)]: { eventId: id, actual: "EPS 9.99", consensus: null, source: "cloud" } });
      const r = await reconcileCloudEnrichment(db, "secret");
      expect(r.actualConflicts).toBe(1);
      expect(get(id).actual_value).toBe("EPS 2.00");
      const conflictWarns = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => /cloud actual/i.test(m));
      expect(conflictWarns).toHaveLength(1);
      expect(conflictWarns[0]).toContain(`event ${id}`);
      expect(conflictWarns[0]).toContain("ZZA");
      expect(conflictWarns[0]).toContain("EPS 9.99");
      expect(conflictWarns[0]).toContain("EPS 2.00");
      expect(conflictWarns[0]).toMatch(/not applied/);
    });

    it("an identical cloud actual, a NULL local actual and a NULL cloud actual are not conflicts", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const same = insert("ZZB", "EPS 1.50", null);
      const fill = insert("ZZC", null, null);
      const none = insert("ZZD", "EPS 3.00", null);
      mockWorker({
        [String(same)]: { eventId: same, actual: "EPS 1.50", consensus: null, source: "cloud" },
        [String(fill)]: { eventId: fill, actual: "EPS 1.10", consensus: null, source: "cloud" },
        [String(none)]: { eventId: none, actual: null, consensus: "EPS 2.90", source: "cloud" },
      });
      const r = await reconcileCloudEnrichment(db, "secret");
      expect(r.actualConflicts).toBe(0);
      expect(warn.mock.calls.filter((c) => /cloud actual/i.test(String(c[0])))).toHaveLength(0);
      expect(get(fill).actual_value).toBe("EPS 1.10");
    });
  });
});

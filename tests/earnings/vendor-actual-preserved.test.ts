/**
 * Owner ruling 2026-10-08 (recap scoreboard actuals): "the vendor's actual is
 * kept in a new column. Accepting worksheet figures overwrites the vendor
 * actual today, so there was nothing to footnote."
 *
 * calendar_events.vendor_actual_value (migration 096) holds the vendor's
 * figure. Three writers, one rule: written once, and never a hand-entered
 * figure.
 *   1. saveManualActuals: the first hand-entered or promoted save copies the
 *      vendor figure it is about to replace.
 *   2. Cloud reconcile: a cloud (vendor) actual that arrives for a row that
 *      already carries a hand-entered one lands in the new column.
 *   3. Enrichment runner: the same, for a vendor fetch that returns after a
 *      hand-entered save landed mid-fetch. The hand-entered figure stays.
 *
 * Synthetic tickers and round figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/alerts/print-push", () => ({ sendEarningsPrintPush: vi.fn() }));
vi.mock("@/lib/calendar/enrich-actuals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar/enrich-actuals")>();
  return { ...actual, fetchActualForEvent: vi.fn() };
});

import { saveManualActuals, clearManualActuals } from "@/lib/earnings/actuals";
import { reconcileCloudEnrichment } from "@/lib/calendar/cloud-reconcile";
import { runEnrichment } from "@/lib/calendar/enrichment-runner";
import { fetchActualForEvent } from "@/lib/calendar/enrich-actuals";
import { getEventById } from "@/lib/queries/calendar";

const mockFetchActual = vi.mocked(fetchActualForEvent);

// The shape the vendor road writes (lib/calendar/enrich-actuals.ts: revenue
// through toLocaleString) and the shape saveManualActuals writes.
const VENDOR = "EPS 1.02 · Rev 505,000,000";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  mockFetchActual.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.WORKER_MARKER_URL;
});

function seed(
  symbol: string,
  opts: { actual?: string | null; source?: string; superseded?: number } = {},
): number {
  const source = opts.source ?? "finnhub";
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
           (source, source_key, event_type, event_date, week_of, event_time, title, symbol,
            consensus_estimate, actual_value, superseded)
         VALUES (?, ?, 'earnings', '2020-01-07', '2020-01-06', 'AMC', ?, ?,
                 'EPS 1.00 · Rev 500000000', ?, ?)`,
      )
      .run(
        source,
        `${source}:${symbol}:2020-01-07`,
        `${symbol} earnings`,
        symbol,
        opts.actual ?? null,
        opts.superseded ?? 0,
      ).lastInsertRowid,
  );
}

function row(id: number) {
  return db
    .prepare(
      `SELECT actual_value, vendor_actual_value, manual_actuals_at IS NOT NULL AS stamped
         FROM calendar_events WHERE id = ?`,
    )
    .get(id) as { actual_value: string | null; vendor_actual_value: string | null; stamped: number };
}

describe("saveManualActuals keeps the vendor figure it replaces", () => {
  it("copies the vendor actual on the first hand-entered save", () => {
    const id = seed("ZZA", { actual: VENDOR });
    const r = saveManualActuals(db, { eventId: id, epsActual: 1.1, revenueActualUsd: 510_000_000 });
    expect(r.ok).toBe(true);
    expect(row(id)).toEqual({
      actual_value: "EPS 1.10 · Rev 510000000",
      vendor_actual_value: VENDOR,
      stamped: 1,
    });
  });

  it("a second save never replaces the kept vendor figure with a hand-entered one", () => {
    const id = seed("ZZA", { actual: VENDOR });
    saveManualActuals(db, { eventId: id, epsActual: 1.1 });
    saveManualActuals(db, { eventId: id, epsActual: 1.15 });
    const after = row(id);
    expect(after.actual_value).toBe("EPS 1.15 · Rev 505000000");
    expect(after.vendor_actual_value).toBe(VENDOR);
  });

  it("stores nothing when there was no actual to replace", () => {
    const id = seed("ZZA");
    saveManualActuals(db, { eventId: id, epsActual: 1.1 });
    expect(row(id).vendor_actual_value).toBeNull();
    // ...and the next save does not mistake the first hand-entered figure
    // for a vendor one.
    saveManualActuals(db, { eventId: id, epsActual: 1.2 });
    expect(row(id).vendor_actual_value).toBeNull();
  });

  it("does not copy a hand-entered figure that reached this row from a twin", () => {
    // The acceptance sits on a replaced twin; the canonical row shows the
    // SAME figure with no stamp of its own (the twin-flip shape,
    // lib/queries/manual-actuals-cluster.ts). That figure is hand-entered.
    const twin = seed("ZZA", { source: "nasdaq", superseded: 1 });
    saveManualActuals(db, { eventId: twin, epsActual: 1.1, revenueActualUsd: 510_000_000 });
    const canonical = seed("ZZA", { actual: "EPS 1.10 · Rev 510000000" });
    expect(row(canonical).stamped).toBe(0);

    saveManualActuals(db, { eventId: canonical, epsActual: 1.12 });
    expect(row(canonical).actual_value).toBe("EPS 1.12 · Rev 510000000");
    expect(row(canonical).vendor_actual_value).toBeNull();
  });

  it("a refused save writes nothing to the new column", () => {
    const id = seed("ZZA", { actual: VENDOR });
    const r = saveManualActuals(db, { eventId: id });
    expect(r.ok).toBe(false);
    expect(row(id)).toEqual({ actual_value: VENDOR, vendor_actual_value: null, stamped: 0 });
  });

  it("the healed reader returns the kept vendor figure", () => {
    const id = seed("ZZA", { actual: VENDOR });
    saveManualActuals(db, { eventId: id, epsActual: 1.1 });
    expect(getEventById(db, id)?.vendor_actual_value).toBe(VENDOR);
  });

  it("clearing the hand-entered actual leaves the kept vendor figure alone", () => {
    const id = seed("ZZA", { actual: VENDOR });
    saveManualActuals(db, { eventId: id, epsActual: 1.1 });
    expect(clearManualActuals(db, { eventId: id })).toEqual({ ok: true });
    expect(row(id)).toEqual({ actual_value: null, vendor_actual_value: VENDOR, stamped: 0 });
  });
});

describe("cloud reconcile: a vendor actual arriving after a promote", () => {
  function mockWorker(payloads: Record<string, unknown>) {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ payloads }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("lands in vendor_actual_value; the hand-entered actual stays", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = seed("ZZA");
    saveManualActuals(db, { eventId: id, epsActual: 1.1, revenueActualUsd: 510_000_000 });
    mockWorker({ [String(id)]: { eventId: id, actual: VENDOR, consensus: null, source: "cloud" } });
    const r = await reconcileCloudEnrichment(db, "secret");
    expect(r.ok).toBe(true);
    expect(row(id)).toEqual({
      actual_value: "EPS 1.10 · Rev 510000000",
      vendor_actual_value: VENDOR,
      stamped: 1,
    });
  });

  it("never replaces a vendor figure already kept", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = seed("ZZA", { actual: VENDOR });
    saveManualActuals(db, { eventId: id, epsActual: 1.1 });
    mockWorker({
      [String(id)]: { eventId: id, actual: "EPS 1.03 · Rev 506,000,000", consensus: null, source: "cloud" },
    });
    await reconcileCloudEnrichment(db, "secret");
    expect(row(id).vendor_actual_value).toBe(VENDOR);
  });

  it("stores nothing for a row whose local actual is the vendor's own", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = seed("ZZA", { actual: VENDOR });
    const filled = seed("ZZB");
    mockWorker({
      [String(kept)]: { eventId: kept, actual: "EPS 1.03 · Rev 506,000,000", consensus: null, source: "cloud" },
      [String(filled)]: { eventId: filled, actual: VENDOR, consensus: null, source: "cloud" },
    });
    await reconcileCloudEnrichment(db, "secret");
    expect(row(kept)).toEqual({ actual_value: VENDOR, vendor_actual_value: null, stamped: 0 });
    expect(row(filled)).toEqual({ actual_value: VENDOR, vendor_actual_value: null, stamped: 0 });
  });
});

describe("enrichment runner: a vendor fetch that returns after a hand-entered save", () => {
  it("keeps the hand-entered actual and stores the vendor figure beside it", async () => {
    const id = seed("ZZA");
    mockFetchActual.mockImplementation(async () => {
      // The desk saves while the vendor request is in flight.
      const saved = saveManualActuals(db, { eventId: id, epsActual: 1.1, revenueActualUsd: 510_000_000 });
      expect(saved.ok).toBe(true);
      return { actual: VENDOR, consensus: null, source: "finnhub" as const };
    });
    await runEnrichment(db, { eventId: id });
    expect(mockFetchActual).toHaveBeenCalledTimes(1);
    expect(row(id)).toEqual({
      actual_value: "EPS 1.10 · Rev 510000000",
      vendor_actual_value: VENDOR,
      stamped: 1,
    });
  });

  it("an ordinary vendor fill of an empty actual is unchanged", async () => {
    const id = seed("ZZA");
    mockFetchActual.mockResolvedValue({ actual: VENDOR, consensus: null, source: "finnhub" as const });
    await runEnrichment(db, { eventId: id });
    expect(row(id)).toEqual({ actual_value: VENDOR, vendor_actual_value: null, stamped: 0 });
  });
});

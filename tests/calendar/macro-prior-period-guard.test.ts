/**
 * A macro release never stores the PRIOR period's figure as its actual
 * [qa:dashboard-today-view-week-ahead-oct-12-week-september-ppi-card-september-ppi-card-records-august-s-5-4-as-its].
 *
 * Enrichment runs minutes after the release time. When FRED has not yet
 * loaded the new print, the release-day vintage's newest observation is the
 * PREVIOUS period's, and it used to be stored as this release's actual with
 * its true (older) reference period. The rule: the period the release is
 * expected to report comes from the same derivation the sync uses for the
 * title (reportingPeriodKey with the release's reporting lag); an observation
 * for an EARLIER period is not stored, the row stays open for the next pass,
 * and a release whose period cannot be derived keeps today's behaviour.
 *
 * All figures are synthetic round index levels.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/alerts/print-push", () => ({ sendEarningsPrintPush: vi.fn() }));

import { runEnrichment } from "@/lib/calendar/enrichment-runner";
import { reconcileCloudEnrichment } from "@/lib/calendar/cloud-reconcile";
import {
  expectedReferencePeriod,
  isPriorPeriodObservation,
  PERIOD_CHECKED_RELEASE_LAGS,
} from "@/lib/calendar/macro-figure";
import { reportingPeriodKey, trackedReportingLag } from "@/lib/calendar/macro-events";

interface Row {
  actual_value: string | null;
  reference_period: string | null;
  enriched_at: string | null;
  enrichment_attempted_at: string | null;
  actual_refused_reason: string | null;
}

const readRow = (db: Database.Database, id: number) =>
  db
    .prepare(
      `SELECT actual_value, reference_period, enriched_at, enrichment_attempted_at, actual_refused_reason
       FROM calendar_events WHERE id = ?`,
    )
    .get(id) as Row;

function insertMacro(db: Database.Database, sourceKey: string, eventDate: string, eventType = "cpi"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, event_time, release_time, title, source_key, week_of)
         VALUES ('claude_macro', ?, ?, '08:30', '08:30', 'Synthetic release', ?, ?)`,
      )
      .run(eventType, eventDate, sourceKey, eventDate).lastInsertRowid,
  );
}

function stubFred(bySeries: Record<string, Array<{ date: string; value: string }>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "api.stlouisfed.org") {
        const series = url.searchParams.get("series_id") ?? "";
        return { ok: true, json: async () => ({ observations: bySeries[series] ?? [] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}

// A PPI release on 2026-10-15 reports September (lag 1).
const RELEASE = "2026-10-15";
// 08:30 ET is 12:30 UTC; fifteen minutes later is inside the window.
const EARLY = new Date("2026-10-15T12:45:00Z");
// Fresh: September is in. 110 vs 100 a year earlier = 10.0%.
const FRESH = [
  { date: "2026-09-01", value: "110.0" },
  { date: "2026-08-01", value: "105.0" },
  { date: "2025-09-01", value: "100.0" },
  { date: "2025-08-01", value: "100.0" },
];
// Stale: FRED has not loaded September yet; newest is August.
const STALE = FRESH.slice(1);

describe("the pure rule", () => {
  it("derives the expected period with the sync's own derivation", () => {
    expect(expectedReferencePeriod("fred:46:2026-10-15", "2026-10-15")).toBe("2026-09");
    expect(expectedReferencePeriod("fred:53:2026-10-29", "2026-10-29")).toBe("2026-Q3");
    expect(expectedReferencePeriod("fred:51:2026-11-04", "2026-11-04")).toBe("2026-09");
    expect(expectedReferencePeriod("fred:10:2027-01-13", "2027-01-13")).toBe("2026-12");
  });

  it("fails open where the period cannot be derived", () => {
    // Weekly claims, the two-report durable goods release, an unknown id,
    // non-FRED and FOMC rows.
    expect(expectedReferencePeriod("fred:180:2026-10-15", "2026-10-15")).toBeNull();
    expect(expectedReferencePeriod("fred:95:2026-11-03", "2026-11-03")).toBeNull();
    expect(expectedReferencePeriod("fred:9999:2026-11-03", "2026-11-03")).toBeNull();
    expect(expectedReferencePeriod("nonfred:ISM_Manufacturing:2026-11-02", "2026-11-02")).toBeNull();
    expect(expectedReferencePeriod("fomc:2026-10-28", "2026-10-28")).toBeNull();
    expect(isPriorPeriodObservation("fred:95:2026-11-03", "2026-11-03", "2026-09")).toBe(false);
  });

  it("refuses only an EARLIER period of the same form", () => {
    expect(isPriorPeriodObservation("fred:46:2026-10-15", "2026-10-15", "2026-08")).toBe(true);
    expect(isPriorPeriodObservation("fred:46:2026-10-15", "2026-10-15", "2026-09")).toBe(false);
    expect(isPriorPeriodObservation("fred:46:2026-10-15", "2026-10-15", "2026-10")).toBe(false);
    expect(isPriorPeriodObservation("fred:53:2026-10-29", "2026-10-29", "2026-Q2")).toBe(true);
    expect(isPriorPeriodObservation("fred:53:2026-10-29", "2026-10-29", "2026-Q3")).toBe(false);
    expect(isPriorPeriodObservation("fred:10:2027-01-13", "2027-01-13", "2026-11")).toBe(true);
    // No period, or a period of another form: today's behaviour.
    expect(isPriorPeriodObservation("fred:46:2026-10-15", "2026-10-15", null)).toBe(false);
    expect(isPriorPeriodObservation("fred:46:2026-10-15", "2026-10-15", "2026-Q2")).toBe(false);
  });

  it("checks each release with the lag the sync titles it with", () => {
    for (const [id, lag] of Object.entries(PERIOD_CHECKED_RELEASE_LAGS)) {
      expect(trackedReportingLag(Number(id)), `release ${id}`).toBe(lag);
    }
    expect(expectedReferencePeriod("fred:50:2026-11-06", "2026-11-06")).toBe(
      reportingPeriodKey("2026-11-06", 1),
    );
  });
});

describe("enrichment runner", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    process.env.FRED_API_KEY = "test_fred_key";
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.FRED_API_KEY;
    db.close();
  });

  it("an observation for the expected period is stored", async () => {
    stubFred({ PPIFIS: FRESH });
    const id = insertMacro(db, `fred:46:${RELEASE}`, RELEASE);
    const results = await runEnrichment(db, { now: EARLY });
    expect(results[0].actual).toBe("10.0%");
    expect(readRow(db, id)).toMatchObject({ actual_value: "10.0%", reference_period: "2026-09" });
    expect(readRow(db, id).enriched_at).toBeTruthy();
  });

  it("an observation one period earlier is not stored and the row stays open for the next pass", async () => {
    stubFred({ PPIFIS: STALE });
    const id = insertMacro(db, `fred:46:${RELEASE}`, RELEASE);
    const results = await runEnrichment(db, { now: EARLY });
    expect(results[0].actual).toBeNull();
    expect(results[0].enriched).toBe(false);
    const row = readRow(db, id);
    expect(row.actual_value).toBeNull();
    expect(row.reference_period).toBeNull();
    expect(row.enriched_at).toBeNull();
    // Not a size refusal: the card's "different scale" line must not show.
    expect(row.actual_refused_reason).toBeNull();
    expect(row.enrichment_attempted_at).toBeTruthy();

    // Twenty minutes later FRED has the new print: the next pass stores it.
    // (The stamp is the wall clock; put it at the test's own "now" so the
    // ten-minute retry pacing reads as it would live.)
    db.prepare(
      `UPDATE calendar_events SET enrichment_attempted_at = '2026-10-15 12:45:00' WHERE id = ?`,
    ).run(id);
    stubFred({ PPIFIS: FRESH });
    const later = await runEnrichment(db, { now: new Date("2026-10-15T13:05:00Z") });
    expect(later.map((r) => r.eventId)).toContain(id);
    expect(readRow(db, id)).toMatchObject({ actual_value: "10.0%", reference_period: "2026-09" });
    expect(readRow(db, id).enriched_at).toBeTruthy();
  });

  it("still stale in the last half hour of the window: the row is closed with no actual", async () => {
    stubFred({ PPIFIS: STALE });
    const id = insertMacro(db, `fred:46:${RELEASE}`, RELEASE);
    // 08:30 ET + 100 minutes.
    await runEnrichment(db, { now: new Date("2026-10-15T14:10:00Z") });
    const row = readRow(db, id);
    expect(row.actual_value).toBeNull();
    expect(row.reference_period).toBeNull();
    // Closed the way a fetch that found nothing always closed a macro row,
    // so the reaction-only follow-up still runs.
    expect(row.enriched_at).toBeTruthy();
  });

  it("a release whose period cannot be derived keeps today's behaviour", async () => {
    // Durable goods (release 95) reports different months on different dates.
    stubFred({ DGORDER: STALE });
    const id = insertMacro(db, `fred:95:${RELEASE}`, RELEASE, "other_macro");
    const results = await runEnrichment(db, { now: EARLY });
    expect(results[0].actual).not.toBeNull();
    expect(readRow(db, id).reference_period).toBe("2026-08");
    expect(readRow(db, id).enriched_at).toBeTruthy();
  });
});

describe("cloud reconcile", () => {
  let db: Database.Database;

  function mockWorker(payloads: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") return new Response("{}", { status: 200 });
        return new Response(JSON.stringify({ payloads }), { status: 200 });
      }),
    );
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.WORKER_MARKER_URL;
    db.close();
  });

  const payload = (id: number, actual: string, referencePeriod: string) => ({
    [String(id)]: {
      eventId: id,
      source_key: `fred:46:${RELEASE}`,
      actual,
      consensus: null,
      source: "fred",
      reaction: null,
      referencePeriod,
      fetchedAt: "2026-10-15T12:45:00.000Z",
    },
  });

  it("a cloud actual for the prior period does not fill the local NULL and leaves the row open", async () => {
    const id = insertMacro(db, `fred:46:${RELEASE}`, RELEASE);
    mockWorker(payload(id, "5.0%", "2026-08"));
    const r = await reconcileCloudEnrichment(db, "secret");
    expect(r.ok).toBe(true);
    expect(readRow(db, id)).toMatchObject({
      actual_value: null,
      reference_period: null,
      enriched_at: null,
      actual_refused_reason: null,
    });
  });

  it("a cloud actual for the expected period fills it", async () => {
    const id = insertMacro(db, `fred:46:${RELEASE}`, RELEASE);
    mockWorker(payload(id, "10.0%", "2026-09"));
    await reconcileCloudEnrichment(db, "secret");
    expect(readRow(db, id)).toMatchObject({ actual_value: "10.0%", reference_period: "2026-09" });
  });
});

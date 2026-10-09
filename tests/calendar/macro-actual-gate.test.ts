/**
 * Macro actuals: the size check where an actual is about to be stored, and
 * the reference period from FRED's observation date (owner rulings
 * 2026-10-08, migration 097).
 *
 * Three roads are exercised with the real functions against in-memory rows:
 *   - the Mac enrichment runner (FRED rows and non-FRED rows);
 *   - the cloud reconcile (a cloud actual is re-checked before it fills a
 *     local NULL; a Worker refusal carries its reason);
 *   - the weekly sync upsert, which must leave both new columns alone.
 *
 * All figures are synthetic index levels and round percents.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/alerts/print-push", () => ({ sendEarningsPrintPush: vi.fn() }));

const mockCreate = vi.fn();
vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  return { ...actual, getRawAnthropicClient: vi.fn(() => ({ messages: { create: mockCreate } })) };
});

import { runEnrichment } from "@/lib/calendar/enrichment-runner";
import { reconcileCloudEnrichment } from "@/lib/calendar/cloud-reconcile";
import { upsertCalendarEvents } from "@/lib/mutations/calendar";
import { ACTUAL_REFUSED_PREFIX } from "@/lib/calendar/macro-figure";

interface MacroRow {
  actual_value: string | null;
  actual_refused_reason: string | null;
  reference_period: string | null;
  enriched_at: string | null;
  consensus_value: string | null;
}

function readRow(db: Database.Database, id: number): MacroRow {
  return db
    .prepare(
      `SELECT actual_value, actual_refused_reason, reference_period, enriched_at, consensus_value
       FROM calendar_events WHERE id = ?`,
    )
    .get(id) as MacroRow;
}

function insertMacro(
  db: Database.Database,
  opts: {
    source_key: string;
    event_type: string;
    event_date: string;
    release_time: string;
    consensus: string | null;
    previous: string | null;
    title?: string;
  },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, event_time, release_time, title,
            consensus_estimate, previous_value, source_key, week_of)
         VALUES ('claude_macro', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.event_type,
        opts.event_date,
        opts.release_time,
        opts.release_time,
        opts.title ?? "Synthetic release",
        opts.consensus,
        opts.previous,
        opts.source_key,
        opts.event_date,
      ).lastInsertRowid,
  );
}

/** FRED observations by series id; every other URL answers "not ok". */
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

// A synthetic price index: 103.0 now, 102.8 a month earlier, 100.0 a year
// earlier. Year over year that is 3.0%; month over month about 0.2%.
const PRICE_INDEX = [
  { date: "2026-08-01", value: "103.0" },
  { date: "2026-07-01", value: "102.8" },
  { date: "2025-08-01", value: "100.0" },
];
// 08:30 ET on 2026-09-10 is 12:30 UTC; half an hour later is inside the macro
// window and before any reaction may be captured.
const PPI_DATE = "2026-09-10";
const PPI_NOW = new Date("2026-09-10T13:00:00Z");

describe("enrichment runner: macro size check and reference period", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    process.env.FRED_API_KEY = "test_fred_key";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    mockCreate.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.FRED_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    db.close();
  });

  it("PPI: a year-over-year actual beside month-over-month figures is refused, stored empty with a reason, and the row is still marked done", async () => {
    stubFred({ PPIFIS: PRICE_INDEX });
    const id = insertMacro(db, {
      source_key: `fred:46:${PPI_DATE}`,
      event_type: "cpi",
      event_date: PPI_DATE,
      release_time: "08:30",
      consensus: "0.2%",
      previous: "0.2%",
    });

    const results = await runEnrichment(db, { now: PPI_NOW });

    expect(results).toHaveLength(1);
    expect(results[0].actual).toBeNull();
    expect(results[0].enriched).toBe(true);
    expect(results[0].actualRefusedReason).toContain("3.0%");

    const row = readRow(db, id);
    expect(row.actual_value).toBeNull();
    expect(row.actual_refused_reason).toContain("3.0%");
    expect(row.actual_refused_reason).toContain("0.2%");
    expect(row.actual_refused_reason).toMatch(/ten times/);
    // Single-shot, the way a null macro actual is today.
    expect(row.enriched_at).toBeTruthy();
    // The observation's period is still what the release reported on.
    expect(row.reference_period).toBe("2026-08");
  });

  it("PPI: the same actual beside same-basis figures is stored, with the reference month from the observation date", async () => {
    stubFred({ PPIFIS: PRICE_INDEX });
    const id = insertMacro(db, {
      source_key: `fred:46:${PPI_DATE}`,
      event_type: "cpi",
      event_date: PPI_DATE,
      release_time: "08:30",
      consensus: "2.9%",
      previous: "2.7%",
    });

    const results = await runEnrichment(db, { now: PPI_NOW });

    expect(results[0].actual).toBe("3.0%");
    expect(results[0].actualRefusedReason).toBeUndefined();
    expect(readRow(db, id)).toMatchObject({
      actual_value: "3.0%",
      actual_refused_reason: null,
      reference_period: "2026-08",
    });
  });

  it("PPI: more than ten times the previous but not the consensus is stored", async () => {
    stubFred({ PPIFIS: PRICE_INDEX });
    const id = insertMacro(db, {
      source_key: `fred:46:${PPI_DATE}`,
      event_type: "cpi",
      event_date: PPI_DATE,
      release_time: "08:30",
      consensus: "0.3%",
      previous: "0.2%",
    });
    await runEnrichment(db, { now: PPI_NOW });
    expect(readRow(db, id)).toMatchObject({ actual_value: "3.0%", actual_refused_reason: null });
  });

  it("a zero consensus is not comparable: the actual is stored", async () => {
    stubFred({ PPIFIS: PRICE_INDEX });
    const id = insertMacro(db, {
      source_key: `fred:46:${PPI_DATE}`,
      event_type: "cpi",
      event_date: PPI_DATE,
      release_time: "08:30",
      consensus: "0.0%",
      previous: "0.2%",
    });
    await runEnrichment(db, { now: PPI_NOW });
    expect(readRow(db, id)).toMatchObject({ actual_value: "3.0%", actual_refused_reason: null });
  });

  it("mixed units never trip the check: the actual is stored", async () => {
    stubFred({ PPIFIS: PRICE_INDEX });
    const id = insertMacro(db, {
      source_key: `fred:46:${PPI_DATE}`,
      event_type: "cpi",
      event_date: PPI_DATE,
      release_time: "08:30",
      consensus: "0.2",
      previous: "0.2%",
    });
    await runEnrichment(db, { now: PPI_NOW });
    expect(readRow(db, id)).toMatchObject({ actual_value: "3.0%", actual_refused_reason: null });
  });

  it("a later valid actual clears the reason", async () => {
    stubFred({ PPIFIS: PRICE_INDEX });
    const id = insertMacro(db, {
      source_key: `fred:46:${PPI_DATE}`,
      event_type: "cpi",
      event_date: PPI_DATE,
      release_time: "08:30",
      consensus: "0.2%",
      previous: "0.2%",
    });
    await runEnrichment(db, { now: PPI_NOW });
    expect(readRow(db, id).actual_refused_reason).toBeTruthy();

    // The estimates are corrected to the actual's basis, and the row is
    // enriched again on request.
    db.prepare(
      "UPDATE calendar_events SET consensus_estimate = '2.9%', previous_value = '2.7%' WHERE id = ?",
    ).run(id);
    await runEnrichment(db, { now: PPI_NOW, eventId: id });

    expect(readRow(db, id)).toMatchObject({
      actual_value: "3.0%",
      actual_refused_reason: null,
      reference_period: "2026-08",
    });
  });

  it("a pass that fetches nothing new keeps a stored reason", async () => {
    stubFred({ PPIFIS: PRICE_INDEX });
    const id = insertMacro(db, {
      source_key: `fred:46:${PPI_DATE}`,
      event_type: "cpi",
      event_date: PPI_DATE,
      release_time: "08:30",
      consensus: "0.2%",
      previous: "0.2%",
    });
    await runEnrichment(db, { now: PPI_NOW });
    const reason = readRow(db, id).actual_refused_reason;
    expect(reason).toBeTruthy();

    // The source has nothing this time.
    stubFred({});
    await runEnrichment(db, { now: PPI_NOW, eventId: id });
    expect(readRow(db, id)).toMatchObject({ actual_value: null, actual_refused_reason: reason });
  });

  it("GDP: a quarterly series stores the quarter of the observation", async () => {
    stubFred({
      GDPC1: [
        { date: "2026-04-01", value: "101.0" },
        { date: "2026-01-01", value: "100.0" },
      ],
    });
    const id = insertMacro(db, {
      source_key: "fred:53:2026-07-30",
      event_type: "gdp",
      event_date: "2026-07-30",
      release_time: "08:30",
      consensus: "3.8%",
      previous: "2.1%",
    });
    await runEnrichment(db, { now: new Date("2026-07-30T13:00:00Z") });
    expect(readRow(db, id)).toMatchObject({
      actual_value: "4.1%",
      actual_refused_reason: null,
      reference_period: "2026-Q2",
    });
  });

  it("jobless claims: a weekly series stores the observation's own week-ending date", async () => {
    stubFred({
      ICSA: [
        { date: "2026-09-05", value: "229000" },
        { date: "2026-08-29", value: "231000" },
      ],
    });
    const id = insertMacro(db, {
      source_key: `fred:180:${PPI_DATE}`,
      event_type: "jobs",
      event_date: PPI_DATE,
      release_time: "08:30",
      consensus: "235K",
      previous: "231K",
    });
    await runEnrichment(db, { now: PPI_NOW });
    expect(readRow(db, id)).toMatchObject({
      actual_value: "229K",
      actual_refused_reason: null,
      reference_period: "2026-09-05",
    });
  });

  it("a non-FRED actual is checked too, and the lookup is told the row's consensus and previous", async () => {
    stubFred({});
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "571" }] });
    // 10:00 ET on 2026-09-01 is 14:00 UTC.
    const id = insertMacro(db, {
      source_key: "nonfred:ISM_Manufacturing:2026-09-01",
      event_type: "pmi",
      event_date: "2026-09-01",
      release_time: "10:00",
      consensus: "52.1",
      previous: "51.8",
    });

    await runEnrichment(db, { now: new Date("2026-09-01T14:30:00Z") });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const prompt = String(mockCreate.mock.calls[0][0].messages[0].content);
    expect(prompt).toContain("52.1");
    expect(prompt).toContain("51.8");
    expect(prompt).toMatch(/same basis/i);

    const row = readRow(db, id);
    expect(row.actual_value).toBeNull();
    expect(row.actual_refused_reason).toContain("571");
    expect(row.enriched_at).toBeTruthy();
    // No FRED observation, so no reference period.
    expect(row.reference_period).toBeNull();
  });

  it("a non-FRED actual on the row's basis is stored", async () => {
    stubFred({});
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "52.6" }] });
    const id = insertMacro(db, {
      source_key: "nonfred:ISM_Manufacturing:2026-09-01",
      event_type: "pmi",
      event_date: "2026-09-01",
      release_time: "10:00",
      consensus: "52.1",
      previous: "51.8",
    });
    await runEnrichment(db, { now: new Date("2026-09-01T14:30:00Z") });
    expect(readRow(db, id)).toMatchObject({ actual_value: "52.6", actual_refused_reason: null });
  });
});

describe("cloud reconcile: a cloud macro actual is re-checked before it fills a local NULL", () => {
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

  const ppi = (consensus: string | null, previous: string | null) =>
    insertMacro(db, {
      source_key: `fred:46:${PPI_DATE}`,
      event_type: "cpi",
      event_date: PPI_DATE,
      release_time: "08:30",
      consensus,
      previous,
    });

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

  it("a cloud actual on the row's basis fills the NULL and brings its reference period", async () => {
    const id = ppi("2.9%", "2.7%");
    mockWorker({
      [String(id)]: {
        eventId: id,
        source_key: `fred:46:${PPI_DATE}`,
        actual: "3.0%",
        consensus: "2.9%",
        source: "fred",
        reaction: null,
        referencePeriod: "2026-08",
        fetchedAt: "2026-09-10T13:00:00.000Z",
      },
    });
    const r = await reconcileCloudEnrichment(db, "secret");
    expect(r.ok).toBe(true);
    expect(readRow(db, id)).toMatchObject({
      actual_value: "3.0%",
      actual_refused_reason: null,
      reference_period: "2026-08",
    });
  });

  it("a cloud actual more than ten times both local figures is not stored, and the reason is", async () => {
    const id = ppi("0.2%", "0.2%");
    mockWorker({
      [String(id)]: {
        eventId: id,
        source_key: `fred:46:${PPI_DATE}`,
        actual: "3.0%",
        consensus: "0.2%",
        source: "fred",
        reaction: null,
        referencePeriod: "2026-08",
        fetchedAt: "2026-09-10T13:00:00.000Z",
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    const row = readRow(db, id);
    expect(row.actual_value).toBeNull();
    expect(row.actual_refused_reason).toContain("3.0%");
    expect(row.reference_period).toBe("2026-08");
  });

  it("a Worker refusal (actual null, reason on the payload) stores the reason", async () => {
    const id = ppi("0.2%", "0.2%");
    mockWorker({
      [String(id)]: {
        eventId: id,
        source_key: `fred:46:${PPI_DATE}`,
        actual: null,
        consensus: "0.2%",
        source: "fred",
        reason: `${ACTUAL_REFUSED_PREFIX}synthetic worker reason`,
        reaction: null,
        referencePeriod: "2026-08",
        fetchedAt: "2026-09-10T13:00:00.000Z",
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    expect(readRow(db, id)).toMatchObject({
      actual_value: null,
      actual_refused_reason: "synthetic worker reason",
      reference_period: "2026-08",
    });
  });

  it("an ordinary payload reason is not stored as a refusal", async () => {
    const id = ppi("2.9%", "2.7%");
    mockWorker({
      [String(id)]: {
        eventId: id,
        source_key: `fred:46:${PPI_DATE}`,
        actual: null,
        consensus: "2.9%",
        source: "fred",
        reason: "no_observation",
        reaction: null,
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    expect(readRow(db, id)).toMatchObject({ actual_value: null, actual_refused_reason: null });
  });

  it("a valid cloud actual clears a reason left by an earlier refusal", async () => {
    const id = ppi("2.9%", "2.7%");
    db.prepare("UPDATE calendar_events SET actual_refused_reason = 'earlier refusal' WHERE id = ?").run(id);
    mockWorker({
      [String(id)]: {
        eventId: id,
        source_key: `fred:46:${PPI_DATE}`,
        actual: "3.0%",
        consensus: "2.9%",
        source: "fred",
        reaction: null,
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    expect(readRow(db, id)).toMatchObject({ actual_value: "3.0%", actual_refused_reason: null });
  });

  it("a payload period that is not a period is ignored", async () => {
    const id = ppi("2.9%", "2.7%");
    mockWorker({
      [String(id)]: {
        eventId: id,
        source_key: `fred:46:${PPI_DATE}`,
        actual: "3.0%",
        consensus: "2.9%",
        source: "fred",
        reaction: null,
        referencePeriod: "August",
      },
    });
    await reconcileCloudEnrichment(db, "secret");
    expect(readRow(db, id)).toMatchObject({ actual_value: "3.0%", reference_period: null });
  });

  it("an earnings row is not judged by the macro check", async () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO calendar_events
             (source, source_key, event_type, event_date, week_of, title, symbol,
              consensus_estimate, previous_value)
           VALUES ('finnhub', 'finnhub:ZZA:2026-09-10', 'earnings', '2026-09-10', '2026-09-07',
                   'ZZA', 'ZZA', '2.00', '2.10')`,
        )
        .run().lastInsertRowid,
    );
    mockWorker({
      [String(id)]: { eventId: id, actual: "25.00", consensus: "2.00", source: "finnhub", reaction: null },
    });
    await reconcileCloudEnrichment(db, "secret");
    expect(readRow(db, id)).toMatchObject({ actual_value: "25.00", actual_refused_reason: null });
  });
});

describe("the weekly sync never touches the two macro basis columns", () => {
  it("a second upsert rewrites the title and raw_json and leaves both columns as they were", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const input = {
      source: "claude_macro" as const,
      event_type: "cpi",
      event_date: PPI_DATE,
      event_time: "08:30",
      title: "August Producer Price Index",
      consensus_estimate: "0.2%",
      previous_value: "0.2%",
      raw_json: JSON.stringify({ pass: 1 }),
      source_key: `fred:46:${PPI_DATE}`,
      week_of: "2026-09-07",
    };
    upsertCalendarEvents(db, [input]);
    // A fresh row starts with both columns empty.
    expect(
      db.prepare("SELECT actual_refused_reason, reference_period FROM calendar_events").get(),
    ).toEqual({ actual_refused_reason: null, reference_period: null });

    db.prepare(
      "UPDATE calendar_events SET actual_refused_reason = 'kept reason', reference_period = '2026-08'",
    ).run();

    upsertCalendarEvents(db, [
      { ...input, title: "September Producer Price Index", raw_json: JSON.stringify({ pass: 2 }) },
    ]);

    expect(
      db
        .prepare("SELECT title, raw_json, actual_refused_reason, reference_period FROM calendar_events")
        .get(),
    ).toEqual({
      title: "September Producer Price Index",
      raw_json: JSON.stringify({ pass: 2 }),
      actual_refused_reason: "kept reason",
      reference_period: "2026-08",
    });
    db.close();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { CalendarEventInput } from "@/lib/mutations/calendar";

// Mock all external/IO dependencies before importing the module under test.
// Mirrors tests/calendar/sync.test.ts.
vi.mock("@/lib/tws/wsh", () => ({
  fetchWshEvents: vi.fn(),
}));
vi.mock("@/lib/calendar/parse-wsh", () => ({
  parseWshEvents: vi.fn(() => [] as CalendarEventInput[]),
}));
vi.mock("@/lib/calendar/macro-events", () => ({
  fetchMacroEvents: vi.fn(),
}));
vi.mock("@/lib/calendar/finnhub", () => ({
  fetchFinnhubEarningsForSymbols: vi.fn(),
}));
vi.mock("@/lib/calendar/nasdaq", () => ({
  fetchNasdaqEarningsForSymbols: vi.fn(() => [] as CalendarEventInput[]),
}));
vi.mock("@/lib/queries/briefing-symbols", () => ({
  getHeldStockSymbols: vi.fn(() => [] as string[]),
  // Wave 1 item 3 hoisted the scan-set computation out of the
  // FINNHUB_API_KEY-gated block so the Nasdaq cross-check can reuse it —
  // it now runs unconditionally, so this mock needs the export too.
  getHeldOptionUnderlyingSymbols: vi.fn(() => [] as string[]),
}));
vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(() => null), // TWS not connected → WSH phase skipped
  disconnectTws: vi.fn(),
}));

import { syncCalendarForWeek } from "@/lib/calendar/sync";
import { fetchMacroEvents } from "@/lib/calendar/macro-events";
import { upsertCalendarEvents } from "@/lib/mutations/calendar";

const WEEK = "2026-06-08";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.clearAllMocks();
  delete process.env.FINNHUB_API_KEY; // finnhub phase skipped
});

function macroEvent(
  date: string,
  eventType: string,
  releaseId: number,
  overrides: Partial<CalendarEventInput> = {},
): CalendarEventInput {
  return {
    source: "claude_macro",
    event_type: eventType as never,
    event_date: date,
    event_time: "08:30",
    title: `Test ${eventType}`,
    description: null,
    expected_impact: "high",
    consensus_estimate: null,
    previous_value: null,
    source_key: `fred:${releaseId}:${date}`,
    week_of: WEEK,
    ...overrides,
  };
}

interface EnrichmentRow {
  source_key: string;
  actual_value: string | null;
  consensus_value: string | null;
  reaction_snapshot: string | null;
  enriched_at: string | null;
  release_time: string | null;
  title: string;
}

function getRow(sourceKey: string): EnrichmentRow | undefined {
  return db
    .prepare(
      `SELECT source_key, actual_value, consensus_value, reaction_snapshot,
              enriched_at, release_time, title
         FROM calendar_events WHERE source_key = ?`,
    )
    .get(sourceKey) as EnrichmentRow | undefined;
}

/** Seed an event and stamp enrichment onto it (what the enrichment runner writes post-release). */
function seedEnriched(input: CalendarEventInput, enrichment: Partial<EnrichmentRow> = {}) {
  upsertCalendarEvents(db, [input]);
  db.prepare(
    `UPDATE calendar_events
        SET actual_value = ?, consensus_value = ?, reaction_snapshot = ?, enriched_at = ?
      WHERE source_key = ?`,
  ).run(
    enrichment.actual_value ?? "3.9%",
    enrichment.consensus_value ?? "3.8%",
    enrichment.reaction_snapshot ?? '{"SPY":-0.41,"source":"tws"}',
    enrichment.enriched_at ?? "2026-06-10 13:05:00",
    input.source_key,
  );
}

describe("syncCalendarForWeek — macro re-sync preserves enrichment", () => {
  it("keeps actual/consensus/reaction/enriched_at on a re-synced enriched macro event", async () => {
    // CPI released + enriched, then the user hits "Refresh from Finnhub" which
    // re-syncs the week, returning the SAME event (same source_key).
    seedEnriched(macroEvent("2026-06-10", "cpi", 10, { title: "CPI (May)" }));

    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      macroEvent("2026-06-10", "cpi", 10, { title: "CPI (May) refreshed" }),
    ]);

    await syncCalendarForWeek(db, WEEK);

    const row = getRow("fred:10:2026-06-10");
    expect(row).toBeDefined();
    expect(row!.actual_value).toBe("3.9%");
    expect(row!.consensus_value).toBe("3.8%");
    expect(row!.reaction_snapshot).toBe('{"SPY":-0.41,"source":"tws"}');
    expect(row!.enriched_at).toBe("2026-06-10 13:05:00");
    // Sync metadata still refreshes (the upsert is not skipped):
    expect(row!.title).toBe("CPI (May) refreshed");
  });

  it("keeps an enriched event that the new sync set does NOT re-produce (orphan with history)", async () => {
    // Existing Home Sales released + enriched; a later re-sync doesn't include
    // it (source list drift). The historical record must not vanish.
    seedEnriched(
      macroEvent("2026-06-09", "other_macro", 97, { title: "Existing Home Sales" }),
      { actual_value: "+130,000K" },
    );

    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      macroEvent("2026-06-10", "cpi", 10),
    ]);

    await syncCalendarForWeek(db, WEEK);

    const row = getRow("fred:97:2026-06-09");
    expect(row).toBeDefined();
    expect(row!.actual_value).toBe("+130,000K");
    expect(row!.title).toBe("Existing Home Sales");
    // And the new event landed too.
    expect(getRow("fred:10:2026-06-10")).toBeDefined();
  });

  it("still deletes UN-enriched stale macro rows (reschedule-orphan cleanup intact)", async () => {
    // Stale un-enriched row (e.g. a rescheduled date left an orphan source_key).
    upsertCalendarEvents(db, [macroEvent("2026-06-11", "fomc", 999)]);

    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      macroEvent("2026-06-10", "cpi", 10),
    ]);

    await syncCalendarForWeek(db, WEEK);

    expect(getRow("fred:999:2026-06-11")).toBeUndefined();
    expect(getRow("fred:10:2026-06-10")).toBeDefined();
  });

  it("preserves a backfilled release_time when the re-synced input resolves none", async () => {
    // other_macro has no RELEASE_TIMES_ET entry; with event_time null the fresh
    // input resolves release_time = null. The existing row's release_time was
    // backfilled (scripts/backfill-calendar-release-times.ts) and feeds the
    // enrichment window filter — it must survive the re-sync.
    seedEnriched(
      macroEvent("2026-06-09", "other_macro", 55, {
        title: "Consumer Confidence",
        event_time: "10:00",
      }),
    );
    expect(getRow("fred:55:2026-06-09")!.release_time).toBe("10:00");

    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      macroEvent("2026-06-09", "other_macro", 55, {
        title: "Consumer Confidence",
        event_time: null, // fresh sync lost the time → resolves null
      }),
    ]);

    await syncCalendarForWeek(db, WEEK);

    expect(getRow("fred:55:2026-06-09")!.release_time).toBe("10:00");
  });
});

describe("upsertCalendarEvents — date-verification stamp clearing", () => {
  /** A minimal finnhub earnings row, built on the existing macroEvent helper. */
  function baseEvent(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
    return macroEvent("2026-08-05", "earnings", 0, {
      source: "finnhub",
      title: "LLY earnings",
      source_key: "finnhub:LLY:x",
      ...overrides,
    });
  }

  it("a sync upsert that moves event_date clears the date-verification stamp", () => {
    // Insert a finnhub row, stamp it verified, then re-upsert with a new date.
    upsertCalendarEvents(db, [baseEvent({ source_key: "finnhub:LLY:x", event_date: "2026-08-05" })]);
    db.prepare(
      `UPDATE calendar_events SET date_verified_at = datetime('now'),
         date_verification_note = 'confirmed' WHERE source_key = 'finnhub:LLY:x'`,
    ).run();
    upsertCalendarEvents(db, [baseEvent({ source_key: "finnhub:LLY:x", event_date: "2026-08-06" })]);
    const row = db.prepare(
      `SELECT date_verified_at, date_verification_note FROM calendar_events WHERE source_key = 'finnhub:LLY:x'`,
    ).get() as { date_verified_at: string | null; date_verification_note: string | null };
    expect(row.date_verified_at).toBeNull();
    expect(row.date_verification_note).toBeNull();

    // Same-date re-upsert keeps the stamp.
    db.prepare(`UPDATE calendar_events SET date_verified_at = datetime('now') WHERE source_key='finnhub:LLY:x'`).run();
    upsertCalendarEvents(db, [baseEvent({ source_key: "finnhub:LLY:x", event_date: "2026-08-06" })]);
    const row2 = db.prepare(`SELECT date_verified_at FROM calendar_events WHERE source_key='finnhub:LLY:x'`).get() as { date_verified_at: string | null };
    expect(row2.date_verified_at).not.toBeNull();
  });
});

describe("upsertCalendarEvents — earnings release_time earlier-wins on re-sync", () => {
  /** A minimal finnhub earnings row with a symbol (required by the wire-time cascade). */
  function earningsEvent(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
    return macroEvent("2026-08-05", "earnings", 0, {
      source: "finnhub",
      symbol: "XYZ",
      title: "XYZ earnings",
      source_key: "finnhub:XYZ:2026-08-05",
      event_time: "AMC",
      ...overrides,
    });
  }

  it("preserves an existing release_time that is EARLIER than the freshly-resolved incoming value", () => {
    // First sync resolves the plain AMC default (16:15 — no wire history yet).
    upsertCalendarEvents(db, [earningsEvent()]);
    expect(getRow("finnhub:XYZ:2026-08-05")!.release_time).toBe("16:15");

    // The T-90m wire probe (lib/calendar/wire-probe.ts) writes an earlier
    // observed release_time DIRECTLY to the row, outside upsertCalendarEvents.
    db.prepare(
      `UPDATE calendar_events SET release_time = '14:05' WHERE source_key = 'finnhub:XYZ:2026-08-05'`,
    ).run();

    // A later re-sync ("Refresh from Finnhub") re-upserts the same event.
    // With no recorded wire OBSERVATION yet (that only lands once actuals are
    // captured), the cascade recomputes the same AMC default — strictly
    // later than the probe's direct evidence. The upsert must not clobber
    // the probe-pulled value back to the cascade output.
    upsertCalendarEvents(db, [earningsEvent()]);

    expect(getRow("finnhub:XYZ:2026-08-05")!.release_time).toBe("14:05");
  });

  it("still fills a NULL existing release_time from the incoming resolved value", () => {
    // First sync resolves nothing (no event_time slot, no raw_json hour).
    upsertCalendarEvents(db, [earningsEvent({ event_time: null })]);
    expect(getRow("finnhub:XYZ:2026-08-05")!.release_time).toBeNull();

    // A later sync learns the AMC slot.
    upsertCalendarEvents(db, [earningsEvent({ event_time: "AMC" })]);

    expect(getRow("finnhub:XYZ:2026-08-05")!.release_time).toBe("16:15");
  });

  it("still applies a genuinely EARLIER incoming value (fresh info moving the time earlier is not blocked)", () => {
    upsertCalendarEvents(db, [earningsEvent()]); // AMC → 16:15
    expect(getRow("finnhub:XYZ:2026-08-05")!.release_time).toBe("16:15");

    // The slot flips to BMO on a later sync — the incoming value (08:00) is
    // earlier than the existing (16:15), so it should apply normally.
    upsertCalendarEvents(db, [earningsEvent({ event_time: "BMO" })]);

    expect(getRow("finnhub:XYZ:2026-08-05")!.release_time).toBe("08:00");
  });

  it("macro rows keep exact current semantics — a non-null incoming value always wins regardless of earlier/later", () => {
    upsertCalendarEvents(db, [macroEvent("2026-08-05", "cpi", 42)]);
    expect(getRow("fred:42:2026-08-05")!.release_time).toBe("08:30");

    // Macro rows have no probe-pull mechanism, but the upsert clause must
    // not special-case them the way it does earnings rows — plain COALESCE
    // (incoming wins whenever non-null) stays byte-identical.
    db.prepare(
      `UPDATE calendar_events SET release_time = '07:00' WHERE source_key = 'fred:42:2026-08-05'`,
    ).run();

    upsertCalendarEvents(db, [macroEvent("2026-08-05", "cpi", 42)]);

    expect(getRow("fred:42:2026-08-05")!.release_time).toBe("08:30");
  });
});

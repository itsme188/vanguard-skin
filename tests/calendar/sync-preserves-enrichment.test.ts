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

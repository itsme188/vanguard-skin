import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { CalendarEventInput } from "@/lib/mutations/calendar";

// Mock all external/IO dependencies before importing the module under test.
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
  getHeldOptionUnderlyingSymbols: vi.fn(() => [] as string[]),
}));
vi.mock("@/lib/queries/watchlist", () => ({
  getActiveWatchlistStockSymbols: vi.fn(() => [] as string[]),
}));
vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(() => null), // default: TWS not connected
  disconnectTws: vi.fn(),
}));

import { syncCalendarForWeek, SyncCalendarValidationError } from "@/lib/calendar/sync";
import { fetchMacroEvents } from "@/lib/calendar/macro-events";
import { fetchFinnhubEarningsForSymbols } from "@/lib/calendar/finnhub";
import { fetchWshEvents } from "@/lib/tws/wsh";
import { parseWshEvents } from "@/lib/calendar/parse-wsh";
import { getIbApi } from "@/lib/tws/client";
import { getHeldStockSymbols, getHeldOptionUnderlyingSymbols } from "@/lib/queries/briefing-symbols";
import { getActiveWatchlistStockSymbols } from "@/lib/queries/watchlist";
import { upsertCalendarEvents } from "@/lib/mutations/calendar";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.clearAllMocks();
  // Default: no FINNHUB_API_KEY so finnhub phase is skipped
  delete process.env.FINNHUB_API_KEY;
});

function macroEvent(date: string, eventType: string = "gdp", releaseId: number = 53): CalendarEventInput {
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
    week_of: "2026-04-27",
  };
}

describe("syncCalendarForWeek", () => {
  it("rejects an invalid weekOf with a typed error", async () => {
    await expect(syncCalendarForWeek(db, "2026-04-28")).rejects.toThrow(SyncCalendarValidationError);
  });

  it("upserts macro events fetched from FRED into calendar_events", async () => {
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      macroEvent("2026-04-30", "gdp", 53),
      macroEvent("2026-04-30", "cpi", 54),
    ]);

    const result = await syncCalendarForWeek(db, "2026-04-27");

    expect(result.macroEvents).toBe(2);
    expect(result.macroNew).toBe(2);
    const rows = db.prepare("SELECT source_key FROM calendar_events ORDER BY source_key").all() as { source_key: string }[];
    expect(rows.map((r) => r.source_key)).toEqual([
      "fred:53:2026-04-30",
      "fred:54:2026-04-30",
    ]);
  });

  it("clears stale claude_macro rows for the week before re-upserting", async () => {
    // Pre-seed a stale row that should be deleted by the sync
    upsertCalendarEvents(db, [macroEvent("2026-04-29", "fomc", 999)]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get()).toEqual({ n: 1 });

    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      macroEvent("2026-04-30", "gdp", 53),
    ]);

    const result = await syncCalendarForWeek(db, "2026-04-27");

    expect(result.macroEvents).toBe(1);
    const rows = db.prepare("SELECT source_key FROM calendar_events").all() as { source_key: string }[];
    expect(rows.map((r) => r.source_key)).toEqual(["fred:53:2026-04-30"]);
  });

  it("does not cascade — a macro fetch failure leaves finnhub free to run", async () => {
    process.env.FINNHUB_API_KEY = "test-key";
    vi.mocked(fetchMacroEvents).mockRejectedValueOnce(new Error("FRED 503"));
    vi.mocked(getHeldStockSymbols).mockReturnValueOnce(["AAPL"]);
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce([
      {
        source: "finnhub",
        event_type: "earnings",
        event_date: "2026-04-30",
        event_time: "16:00",
        title: "AAPL earnings",
        description: null,
        expected_impact: "medium",
        consensus_estimate: null,
        previous_value: null,
        source_key: "finnhub:AAPL:2026-04-30",
        week_of: "2026-04-27",
      },
    ]);

    const result = await syncCalendarForWeek(db, "2026-04-27");

    expect(result.macroEvents).toBe(0);
    expect(result.finnhubEvents).toBe(1);
    expect(result.errors).toEqual([expect.stringMatching(/^macro: FRED 503/)]);
  });

  it("merges watchlist symbols and held-option underlyings into the Finnhub scan", async () => {
    process.env.FINNHUB_API_KEY = "test-key";
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([]);
    vi.mocked(getHeldStockSymbols).mockReturnValueOnce(["AAPL"]);
    vi.mocked(getActiveWatchlistStockSymbols).mockReturnValueOnce(["SHOP"]);
    vi.mocked(getHeldOptionUnderlyingSymbols).mockReturnValueOnce(["TER"]);
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce([]);

    await syncCalendarForWeek(db, "2026-04-27");

    expect(vi.mocked(fetchFinnhubEarningsForSymbols)).toHaveBeenCalledTimes(1);
    const symbolsArg = vi.mocked(fetchFinnhubEarningsForSymbols).mock.calls[0][1];
    expect(symbolsArg).toEqual(["AAPL", "SHOP", "TER"]);
  });

  it("skips wsh phase when TWS is not connected", async () => {
    vi.mocked(getIbApi).mockReturnValueOnce(null);
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([]);

    const events: { phase: string; message: string }[] = [];
    await syncCalendarForWeek(db, "2026-04-27", { onProgress: (e) => events.push(e) });

    expect(events.find((e) => e.phase === "wsh_skip")).toBeDefined();
    expect(vi.mocked(fetchWshEvents)).not.toHaveBeenCalled();
    expect(vi.mocked(parseWshEvents)).not.toHaveBeenCalled();
  });

  it("skips finnhub phase when FINNHUB_API_KEY is unset", async () => {
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([]);

    const events: { phase: string; message: string }[] = [];
    await syncCalendarForWeek(db, "2026-04-27", { onProgress: (e) => events.push(e) });

    expect(events.find((e) => e.phase === "finnhub_skip")).toBeDefined();
    expect(vi.mocked(fetchFinnhubEarningsForSymbols)).not.toHaveBeenCalled();
  });

  it("respects opts.includeMacro=false to skip Claude entirely", async () => {
    await syncCalendarForWeek(db, "2026-04-27", { includeMacro: false });
    expect(vi.mocked(fetchMacroEvents)).not.toHaveBeenCalled();
  });

  it("emits progress callbacks with phase + message", async () => {
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      macroEvent("2026-04-30", "gdp", 53),
    ]);

    const events: { phase: string; message: string }[] = [];
    await syncCalendarForWeek(db, "2026-04-27", { onProgress: (e) => events.push(e) });

    expect(events.some((e) => e.phase === "macro_fetch")).toBe(true);
    expect(events.some((e) => e.phase === "macro_done" && e.message.includes("1"))).toBe(true);
  });
});

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
import { fetchNasdaqEarningsForSymbols } from "@/lib/calendar/nasdaq";
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

    // Wave 1 item 3: the Nasdaq cross-check must scan the exact same merged
    // set (held ∪ reporters ∪ watchlist ∪ optionUnderlyings) as Finnhub, not
    // a narrower held-only-plus-reporters set.
    expect(vi.mocked(fetchNasdaqEarningsForSymbols)).toHaveBeenCalledTimes(1);
    const nasdaqSymbolsArg = vi.mocked(fetchNasdaqEarningsForSymbols).mock.calls[0][1];
    expect(nasdaqSymbolsArg).toEqual(["AAPL", "SHOP", "TER"]);
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

/**
 * Partial-failure reporting for the Finnhub phase (nightly QA ledger finding
 * `today-earningshub-refresh--silent-partial-failure-no-outcome-report-regression-3`).
 *
 * 17 of 77 per-symbol calendar fetches came back 429 and the run still
 * reported "Finnhub 77/77 scanned" → "Refreshed — 5 new". The per-symbol
 * failures now flow out of fetchFinnhubEarningsForSymbols through its
 * optional `onSymbolFailure` callback, and this phase turns them into a
 * progress line that counts SUCCESSFUL scans, a done line that names the
 * not-scanned count, and exactly ONE domain-language `errors` entry.
 */
describe("syncCalendarForWeek — Finnhub partial failures are reported, not swallowed", () => {
  const finnhubEvent = (symbol: string): CalendarEventInput => ({
    source: "finnhub",
    event_type: "earnings",
    event_date: "2026-04-30",
    event_time: null,
    title: `${symbol} earnings`,
    description: null,
    expected_impact: "medium",
    consensus_estimate: null,
    previous_value: null,
    source_key: `finnhub:${symbol}:2026-04-30`,
    week_of: "2026-04-27",
  });

  /** Drives the mocked fetcher: which of the 3 scanned symbols failed, and how. */
  function mockFinnhubRun(failures: { index: number; message: string }[]) {
    process.env.FINNHUB_API_KEY = "test-key";
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([]);
    vi.mocked(getHeldStockSymbols).mockReturnValueOnce(["AAPL", "MSFT", "TER"]);
    vi.mocked(fetchFinnhubEarningsForSymbols).mockImplementationOnce(
      async (_db, symbols, _start, _end, _weekOf, onProgress, onSymbolFailure) => {
        for (let i = 0; i < symbols.length; i++) {
          const failure = failures.find((f) => f.index === i);
          if (failure) {
            onSymbolFailure?.({
              symbol: symbols[i],
              message: failure.message,
              rateLimited: /\b429\b/.test(failure.message),
            });
          }
          onProgress?.(i + 1, symbols.length);
        }
        return failures.length === symbols.length ? [] : [finnhubEvent("MSFT")];
      },
    );
  }

  async function runSync() {
    const events: { phase: string; message: string }[] = [];
    const result = await syncCalendarForWeek(db, "2026-04-27", {
      onProgress: (e) => events.push(e),
      includeNasdaq: false,
    });
    return { result, events };
  }

  it("counts SUCCESSFUL scans in the progress line and shows the rate-limited count separately", async () => {
    mockFinnhubRun([
      { index: 0, message: "Finnhub 429: Too many requests" },
      { index: 2, message: "Finnhub 429: Too many requests" },
    ]);

    const { events } = await runSync();
    const progress = events.filter((e) => e.phase === "finnhub_progress").map((e) => e.message);

    expect(progress).toEqual([
      "Finnhub 0/3 scanned · 1 rate-limited",
      "Finnhub 1/3 scanned · 1 rate-limited",
      "Finnhub 1/3 scanned · 2 rate-limited",
    ]);
  });

  it("pushes exactly one domain-language errors entry naming the not-scanned count", async () => {
    mockFinnhubRun([
      { index: 0, message: "Finnhub 429: Too many requests" },
      { index: 2, message: "Finnhub 429: Too many requests" },
    ]);

    const { result } = await runSync();

    expect(result.errors).toEqual([
      "finnhub: 2 of 3 symbols not scanned — rate-limited by Finnhub (429); retry in a few minutes",
    ]);
  });

  it("names the not-scanned count on the done line too", async () => {
    mockFinnhubRun([{ index: 0, message: "Finnhub 429: Too many requests" }]);

    const { events } = await runSync();
    const done = events.find((e) => e.phase === "finnhub_done");

    expect(done?.message).toContain("1 of 3 symbols not scanned");
    expect(done?.message).toContain("Found 1 portfolio earning");
  });

  it("says 'failed to fetch' when no failure was a 429", async () => {
    mockFinnhubRun([{ index: 1, message: "Finnhub 503: Service unavailable" }]);

    const { result, events } = await runSync();

    expect(result.errors).toEqual([
      "finnhub: 1 of 3 symbols not scanned — failed to fetch",
    ]);
    expect(
      events.filter((e) => e.phase === "finnhub_progress").map((e) => e.message),
    ).toEqual([
      // The failure lands on the SECOND symbol, so the first tick is clean.
      "Finnhub 1/3 scanned",
      "Finnhub 1/3 scanned · 1 failed",
      "Finnhub 2/3 scanned · 1 failed",
    ]);
  });

  it("breaks out both causes when the failures are mixed", async () => {
    mockFinnhubRun([
      { index: 0, message: "Finnhub 429: Too many requests" },
      { index: 1, message: "Finnhub 503: Service unavailable" },
    ]);

    const { result } = await runSync();

    expect(result.errors).toEqual([
      "finnhub: 2 of 3 symbols not scanned — 1 rate-limited by Finnhub (429), 1 failed to fetch; retry in a few minutes",
    ]);
  });

  it("leaves a clean run byte-identical — no suffix, no errors entry", async () => {
    mockFinnhubRun([]);

    const { result, events } = await runSync();

    expect(result.errors).toEqual([]);
    expect(
      events.filter((e) => e.phase === "finnhub_progress").map((e) => e.message),
    ).toEqual(["Finnhub 1/3 scanned", "Finnhub 2/3 scanned", "Finnhub 3/3 scanned"]);
    expect(events.find((e) => e.phase === "finnhub_done")?.message).toBe(
      "Found 1 portfolio earning",
    );
  });
});

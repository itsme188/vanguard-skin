import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { CalendarEventInput } from "@/lib/mutations/calendar";

// [qa:today-earningshub-refresh--outcome-line-counts-reminted-macro-rows-as-new]
// "New" in the sync result must mean "a source_key the week did not have
// before the step ran" — not "a row the upsert physically inserted". The
// macro / Finnhub / Nasdaq steps delete their un-enriched rows and re-insert
// them with identical keys, which used to count every re-minted row as new.
//
// Mocks mirror tests/calendar/sync.test.ts. The week is passed explicitly to
// syncCalendarForWeek, so the fixed synthetic week is not wall-clock stale.
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
  getIbApi: vi.fn(() => null),
  disconnectTws: vi.fn(),
}));

import { syncCalendarForWeek } from "@/lib/calendar/sync";
import { fetchMacroEvents } from "@/lib/calendar/macro-events";
import { fetchFinnhubEarningsForSymbols } from "@/lib/calendar/finnhub";
import { fetchNasdaqEarningsForSymbols } from "@/lib/calendar/nasdaq";
import { fetchWshEvents } from "@/lib/tws/wsh";
import { parseWshEvents } from "@/lib/calendar/parse-wsh";
import { getIbApi } from "@/lib/tws/client";
import { getHeldStockSymbols } from "@/lib/queries/briefing-symbols";

const WEEK = "2026-04-27";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.clearAllMocks();
  delete process.env.FINNHUB_API_KEY;
});

function macroEvent(date: string, eventType: string, releaseId: number): CalendarEventInput {
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
  };
}

function earningsEvent(
  source: "finnhub" | "nasdaq" | "wsh",
  symbol: string,
  date: string,
): CalendarEventInput {
  return {
    source,
    event_type: "earnings",
    event_date: date,
    event_time: "16:00",
    title: `${symbol} Earnings`,
    description: null,
    symbol,
    expected_impact: "high",
    consensus_estimate: null,
    previous_value: null,
    source_key: `${source}:earnings:${symbol}:${date}`,
    week_of: WEEK,
  };
}

const macroSet = () => [
  macroEvent("2026-04-29", "fomc", 101),
  macroEvent("2026-04-30", "gdp", 53),
  macroEvent("2026-05-01", "cpi", 10),
];

describe("syncCalendarForWeek — new counts ignore re-minted rows", () => {
  it("first run on an empty week counts every macro row as new", async () => {
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce(macroSet());

    const result = await syncCalendarForWeek(db, WEEK);

    expect(result.macroEvents).toBe(3);
    expect(result.macroNew).toBe(3);
    expect(result.newEvents).toBe(3);
    expect(result.refreshedEvents).toBe(0);
  });

  it("a second identical run reports 0 new macro rows", async () => {
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce(macroSet());
    await syncCalendarForWeek(db, WEEK);

    vi.mocked(fetchMacroEvents).mockResolvedValueOnce(macroSet());
    const second = await syncCalendarForWeek(db, WEEK);

    expect(second.macroEvents).toBe(3);
    expect(second.macroNew).toBe(0);
    expect(second.newEvents).toBe(0);
    expect(second.refreshedEvents).toBe(3);
    // The rows really were re-minted (the delete + re-insert still runs).
    const n = db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get() as { n: number };
    expect(n.n).toBe(3);
  });

  it("a genuinely new macro event on the second run counts as exactly 1 new", async () => {
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce(macroSet());
    await syncCalendarForWeek(db, WEEK);

    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      ...macroSet(),
      macroEvent("2026-04-28", "other_macro", 97),
    ]);
    const second = await syncCalendarForWeek(db, WEEK);

    expect(second.macroEvents).toBe(4);
    expect(second.macroNew).toBe(1);
    expect(second.newEvents).toBe(1);
  });

  it("Finnhub and Nasdaq re-mints are 0 new on an identical re-run; a new name is exactly 1", async () => {
    process.env.FINNHUB_API_KEY = "test-key";
    vi.mocked(getHeldStockSymbols).mockReturnValue(["AAA", "BBB", "CCC"]);
    vi.mocked(fetchMacroEvents).mockResolvedValue([]);

    const finnhubSet = () => [
      earningsEvent("finnhub", "AAA", "2026-04-28"),
      earningsEvent("finnhub", "BBB", "2026-04-29"),
    ];
    const nasdaqSet = () => [
      earningsEvent("nasdaq", "AAA", "2026-04-28"),
      earningsEvent("nasdaq", "BBB", "2026-04-29"),
    ];

    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce(finnhubSet());
    vi.mocked(fetchNasdaqEarningsForSymbols).mockResolvedValueOnce(nasdaqSet());
    const first = await syncCalendarForWeek(db, WEEK);
    expect(first.finnhubNew).toBe(2);
    expect(first.nasdaqNew).toBe(2);

    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce(finnhubSet());
    vi.mocked(fetchNasdaqEarningsForSymbols).mockResolvedValueOnce(nasdaqSet());
    const second = await syncCalendarForWeek(db, WEEK);
    expect(second.finnhubEvents).toBe(2);
    expect(second.finnhubNew).toBe(0);
    expect(second.nasdaqEvents).toBe(2);
    expect(second.nasdaqNew).toBe(0);
    expect(second.newEvents).toBe(0);

    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce([
      ...finnhubSet(),
      earningsEvent("finnhub", "CCC", "2026-04-30"),
    ]);
    vi.mocked(fetchNasdaqEarningsForSymbols).mockResolvedValueOnce(nasdaqSet());
    const third = await syncCalendarForWeek(db, WEEK);
    expect(third.finnhubNew).toBe(1);
    expect(third.nasdaqNew).toBe(0);
    expect(third.newEvents).toBe(1);
  });

  it("WSH uses the same definition: identical re-run is 0 new", async () => {
    vi.mocked(getIbApi).mockReturnValue({} as never);
    vi.mocked(fetchWshEvents).mockResolvedValue("[]" as never);
    vi.mocked(fetchMacroEvents).mockResolvedValue([]);
    const wshSet = () => [earningsEvent("wsh", "AAA", "2026-04-28")];

    vi.mocked(parseWshEvents).mockReturnValueOnce(wshSet());
    const first = await syncCalendarForWeek(db, WEEK, { includeNasdaq: false });
    expect(first.wshNew).toBe(1);

    vi.mocked(parseWshEvents).mockReturnValueOnce(wshSet());
    const second = await syncCalendarForWeek(db, WEEK, { includeNasdaq: false });
    expect(second.wshEvents).toBe(1);
    expect(second.wshNew).toBe(0);
  });
});

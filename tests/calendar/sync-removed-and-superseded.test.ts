import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { CalendarEventInput } from "@/lib/mutations/calendar";

// Owner rulings 2026-10-06:
//  [qa:today-earningshub-refresh--deletes-scheduled-macro-release-never-recreated]
//    a refresh NAMES every row it removed, and why;
//  [qa:dashboard-today-earningshub-refresh-from-finnhub-refresh-silently-supersedes-a-user-added-earnings-row-the-hub]
//    a refresh NAMES every row it hid (superseded), and why.
//
// "Removed" is read off what the cleanup actually deleted: a row that was
// showing before the source's write step and whose source_key is gone after
// it. A row deleted and re-minted under the same key was not removed.
// "Superseded" is a row that was showing when the refresh started and is
// hidden when it ends.
//
// Mocks mirror tests/calendar/sync-new-count.test.ts. The reconciler runs for
// real and reads the ET date, so the week is derived from today rather than
// pinned (a fixed week would fall out of its window and go wall-clock stale).
vi.mock("@/lib/tws/wsh", () => ({
  fetchWshEvents: vi.fn(),
}));
vi.mock("@/lib/calendar/parse-wsh", () => ({
  parseWshEvents: vi.fn(() => [] as CalendarEventInput[]),
}));
vi.mock("@/lib/calendar/macro-events", () => ({
  fetchMacroEvents: vi.fn(),
  buildHardcodedMacroEvents: vi.fn(() => ({ events: [], nonFredKeyPrefixes: new Map() })),
}));
vi.mock("@/lib/calendar/finnhub", () => ({
  fetchFinnhubEarningsForSymbols: vi.fn(),
}));
vi.mock("@/lib/calendar/nasdaq", () => ({
  fetchNasdaqEarningsForSymbols: vi.fn(() => [] as CalendarEventInput[]),
}));
vi.mock("@/lib/queries/briefing-symbols", () => ({
  getHeldStockSymbols: vi.fn(() => ["ZZA", "ZZB"]),
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
import { addDays, getCurrentMonday } from "@/lib/calendar/date-utils";

const WEEK = getCurrentMonday();
const day = (offset: number) => addDays(WEEK, offset);

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.clearAllMocks();
  vi.mocked(fetchMacroEvents).mockResolvedValue([]);
  vi.mocked(fetchNasdaqEarningsForSymbols).mockResolvedValue([]);
  process.env.FINNHUB_API_KEY = "test-key";
});

function macroEvent(date: string, title: string, releaseId: number): CalendarEventInput {
  return {
    source: "claude_macro",
    event_type: "other_macro",
    event_date: date,
    event_time: "08:30",
    title,
    description: null,
    expected_impact: "medium",
    consensus_estimate: null,
    previous_value: null,
    source_key: `fred:${releaseId}:${date}`,
    week_of: WEEK,
  };
}

function earningsEvent(
  source: "finnhub" | "nasdaq",
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

describe("syncCalendarForWeek — names the macro rows it removed", () => {
  it("reports an orphaned release by title, date and reason; a re-listed one is not reported", async () => {
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValue([]);
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      macroEvent(day(1), "Test Release One", 901),
      macroEvent(day(2), "Test Release Two", 902),
    ]);
    const first = await syncCalendarForWeek(db, WEEK);
    expect(first.removed).toEqual([]);

    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      macroEvent(day(1), "Test Release One", 901),
    ]);
    const second = await syncCalendarForWeek(db, WEEK);

    expect(second.removed).toEqual([
      {
        title: "Test Release Two",
        eventDate: day(2),
        source: "claude_macro",
        reason: "no longer on the release schedule the source publishes",
      },
    ]);
    const left = db
      .prepare("SELECT title FROM calendar_events WHERE source = 'claude_macro'")
      .all() as { title: string }[];
    expect(left.map((r) => r.title)).toEqual(["Test Release One"]);
  });

  it("does not report a released (enriched) row the source dropped — it is kept, not removed", async () => {
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValue([]);
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      macroEvent(day(1), "Test Release One", 901),
      macroEvent(day(2), "Test Release Two", 902),
    ]);
    await syncCalendarForWeek(db, WEEK);
    db.prepare(
      "UPDATE calendar_events SET actual_value = '1.0%', enriched_at = datetime('now') WHERE title = 'Test Release Two'",
    ).run();

    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      macroEvent(day(1), "Test Release One", 901),
    ]);
    const second = await syncCalendarForWeek(db, WEEK);

    expect(second.removed).toEqual([]);
    const n = db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get() as { n: number };
    expect(n.n).toBe(2);
  });

  it("reports nothing when the macro fetch fails — the fallback road never deletes", async () => {
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValue([]);
    vi.mocked(fetchMacroEvents).mockResolvedValueOnce([
      macroEvent(day(1), "Test Release One", 901),
    ]);
    await syncCalendarForWeek(db, WEEK);

    vi.mocked(fetchMacroEvents).mockRejectedValueOnce(new Error("source unavailable"));
    const second = await syncCalendarForWeek(db, WEEK);

    expect(second.removed).toEqual([]);
    expect(second.errors).toContain("macro: source unavailable");
  });
});

describe("syncCalendarForWeek — names the earnings rows it removed", () => {
  it("reports a vendor row the vendor no longer returns", async () => {
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce([
      earningsEvent("finnhub", "ZZA", day(1)),
      earningsEvent("finnhub", "ZZB", day(2)),
    ]);
    await syncCalendarForWeek(db, WEEK);

    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce([
      earningsEvent("finnhub", "ZZA", day(1)),
    ]);
    const second = await syncCalendarForWeek(db, WEEK);

    expect(second.removed).toEqual([
      {
        title: "ZZB Earnings",
        eventDate: day(2),
        source: "finnhub",
        reason: "Finnhub did not return this date on this refresh",
      },
    ]);
  });

  it("an unchanged vendor list removes nothing, even though its rows are deleted and re-minted", async () => {
    const list = () => [
      earningsEvent("finnhub", "ZZA", day(1)),
      earningsEvent("finnhub", "ZZB", day(2)),
    ];
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce(list());
    await syncCalendarForWeek(db, WEEK);
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce(list());
    const second = await syncCalendarForWeek(db, WEEK);

    expect(second.removed).toEqual([]);
    expect(second.superseded).toEqual([]);
  });
});

describe("syncCalendarForWeek — names the rows it hid", () => {
  it("reports the losing row of a vendor-vs-vendor date conflict, once", async () => {
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce([
      earningsEvent("finnhub", "ZZA", day(1)),
    ]);
    const first = await syncCalendarForWeek(db, WEEK);
    expect(first.superseded).toEqual([]);

    // The second vendor now lists a different date: its date shows
    // provisionally and the first vendor's row is hidden.
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce([
      earningsEvent("finnhub", "ZZA", day(1)),
    ]);
    vi.mocked(fetchNasdaqEarningsForSymbols).mockResolvedValueOnce([
      earningsEvent("nasdaq", "ZZA", day(3)),
    ]);
    const second = await syncCalendarForWeek(db, WEEK);

    expect(second.superseded).toEqual([
      {
        title: "ZZA Earnings",
        eventDate: day(1),
        source: "finnhub",
        reason: `Nasdaq lists ${day(3)} instead; that date shows until you confirm one`,
      },
    ]);

    // An identical third refresh deletes and re-mints the hidden row, then
    // hides it again. It was already hidden when the refresh started, so it
    // is not reported a second time.
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce([
      earningsEvent("finnhub", "ZZA", day(1)),
    ]);
    vi.mocked(fetchNasdaqEarningsForSymbols).mockResolvedValueOnce([
      earningsEvent("nasdaq", "ZZA", day(3)),
    ]);
    const third = await syncCalendarForWeek(db, WEEK);
    expect(third.superseded).toEqual([]);
    expect(third.removed).toEqual([]);
  });

  it("does not report a duplicate that arrived and was hidden inside the same refresh", async () => {
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce([
      earningsEvent("finnhub", "ZZA", day(1)),
    ]);
    vi.mocked(fetchNasdaqEarningsForSymbols).mockResolvedValueOnce([
      earningsEvent("nasdaq", "ZZA", day(1)),
    ]);
    const first = await syncCalendarForWeek(db, WEEK);

    expect(first.superseded).toEqual([]);
    const hidden = db
      .prepare("SELECT source FROM calendar_events WHERE superseded = 1")
      .all() as { source: string }[];
    expect(hidden.map((r) => r.source)).toEqual(["nasdaq"]);
  });

  it("keeps two hand-entered rows for one name through a refresh and reports neither", async () => {
    const insert = db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of)
       VALUES ('manual', 'earnings', ?, 'ZZA earnings', 'ZZA', ?, ?)`,
    );
    insert.run(day(2), `manual:ZZA:${day(2)}:earnings`, WEEK);
    insert.run(day(3), `manual:ZZA:${day(3)}:earnings`, WEEK);
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce([]);

    const result = await syncCalendarForWeek(db, WEEK);

    expect(result.superseded).toEqual([]);
    expect(result.removed).toEqual([]);
    const live = db
      .prepare(
        "SELECT event_date FROM calendar_events WHERE symbol = 'ZZA' AND COALESCE(superseded, 0) = 0 ORDER BY event_date",
      )
      .all() as { event_date: string }[];
    expect(live.map((r) => r.event_date)).toEqual([day(2), day(3)]);
  });
});

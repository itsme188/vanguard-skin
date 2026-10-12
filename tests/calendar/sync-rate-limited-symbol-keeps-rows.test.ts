import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { CalendarEventInput } from "@/lib/mutations/calendar";

// [qa:dashboard-today-earningshub-refresh-from-finnhub-tsm-conflict-marker-a-refresh-where-finnhub-rate-limited-tsm]
// A symbol Finnhub did not answer (429) on this refresh keeps every stored
// finnhub row, superseded or not. A symbol that was scanned and dropped by the
// vendor is still removed.
vi.mock("@/lib/tws/wsh", () => ({ fetchWshEvents: vi.fn() }));
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
  getHeldStockSymbols: vi.fn(() => ["AAA", "ZZZ"]),
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
  process.env.FINNHUB_API_KEY = "test-key";
});

function earnings(symbol: string, date: string): CalendarEventInput {
  return {
    source: "finnhub",
    event_type: "earnings",
    event_date: date,
    event_time: "16:00",
    title: `${symbol} Earnings`,
    description: null,
    symbol,
    expected_impact: "high",
    consensus_estimate: null,
    previous_value: null,
    source_key: `finnhub:earnings:${symbol}:${date}`,
    week_of: WEEK,
  };
}

const opts = { includeNasdaq: false } as const;

function rowsFor(symbol: string) {
  return db
    .prepare(
      "SELECT event_date, COALESCE(superseded,0) AS superseded FROM calendar_events WHERE source='finnhub' AND symbol = ? ORDER BY event_date",
    )
    .all(symbol) as { event_date: string; superseded: number }[];
}

async function seed() {
  vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce([
    earnings("AAA", day(1)),
    earnings("ZZZ", day(2)),
    earnings("ZZZ", day(3)),
  ]);
  await syncCalendarForWeek(db, WEEK, opts);
  db.prepare(
    "UPDATE calendar_events SET superseded = 1 WHERE source='finnhub' AND symbol='ZZZ' AND event_date = ?",
  ).run(day(3));
}

describe("syncCalendarForWeek — a rate-limited Finnhub symbol keeps its rows", () => {
  it("keeps every stored row (superseded too) for a symbol that returned 429", async () => {
    await seed();
    const before = rowsFor("ZZZ");
    expect(before).toHaveLength(2);

    vi.mocked(fetchFinnhubEarningsForSymbols).mockImplementationOnce(
      async (_db, _s, _a, _b, _w, _p, onFail) => {
        onFail?.({ symbol: "ZZZ", message: "Finnhub 429: Too many requests", rateLimited: true });
        return [earnings("AAA", day(1))];
      },
    );
    const res = await syncCalendarForWeek(db, WEEK, opts);

    expect(rowsFor("ZZZ")).toEqual(before);
    expect(rowsFor("AAA")).toHaveLength(1);
    expect(res.removed.filter((r) => r.title.startsWith("ZZZ"))).toEqual([]);
    expect(res.errors.join(" ")).toMatch(/1 of 2/);
  });

  it("keeps every stored row for a symbol that failed with a non-rate-limit error", async () => {
    await seed();
    const before = rowsFor("ZZZ");
    vi.mocked(fetchFinnhubEarningsForSymbols).mockImplementationOnce(
      async (_db, _s, _a, _b, _w, _p, onFail) => {
        onFail?.({ symbol: "ZZZ", message: "Finnhub 500: Internal server error", rateLimited: false });
        return [earnings("AAA", day(1))];
      },
    );
    const res = await syncCalendarForWeek(db, WEEK, opts);

    expect(rowsFor("ZZZ")).toEqual(before);
    expect(res.removed.filter((r) => r.title.startsWith("ZZZ"))).toEqual([]);
  });

  it("still removes a scanned symbol the vendor dropped", async () => {
    await seed();
    vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce([earnings("AAA", day(1))]);
    const res = await syncCalendarForWeek(db, WEEK, opts);

    expect(rowsFor("ZZZ").filter((r) => r.superseded === 0)).toEqual([]);
    expect(res.removed.some((r) => r.title === "ZZZ Earnings")).toBe(true);
  });

  it("when every symbol failed, the cleanup is skipped and nothing is deleted", async () => {
    await seed();
    const total = (db.prepare("SELECT COUNT(*) n FROM calendar_events WHERE source='finnhub'").get() as { n: number }).n;
    vi.mocked(fetchFinnhubEarningsForSymbols).mockImplementationOnce(
      async (_db, _s, _a, _b, _w, _p, onFail) => {
        for (const symbol of ["AAA", "ZZZ"])
          onFail?.({ symbol, message: "Finnhub 429: Too many requests", rateLimited: true });
        return [];
      },
    );
    const res = await syncCalendarForWeek(db, WEEK, opts);
    const after = (db.prepare("SELECT COUNT(*) n FROM calendar_events WHERE source='finnhub'").get() as { n: number }).n;
    expect(after).toBe(total);
    expect(res.removed).toEqual([]);
  });
});

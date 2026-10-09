/**
 * A feed earnings row (Finnhub / Nasdaq / Wall Street Horizon) written for a
 * symbol and date that a showing hand-entered row already holds is stored
 * hidden (owner ruling 2026-10-08).
 *
 * Why: the reconciler only looks 21 days back and 30 days ahead of today.
 * Refreshing a week outside that window deleted the hidden feed copy and
 * minted it again showing, beside the hand-entered row, and nothing ever
 * folded it. The write itself now applies the reconciler's own fold for the
 * one case that needs no judgement: same symbol, same date.
 *
 * `todayET` is pinned so the three weeks below keep their meaning on every
 * run: one older than the window, one inside it, one beyond it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import type { CalendarEventInput } from "@/lib/mutations/calendar";

vi.mock("@/lib/calendar/date-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/calendar/date-utils")>()),
  todayET: () => "2026-08-31",
}));
vi.mock("@/lib/tws/wsh", () => ({ fetchWshEvents: vi.fn() }));
vi.mock("@/lib/calendar/parse-wsh", () => ({
  parseWshEvents: vi.fn(() => [] as CalendarEventInput[]),
}));
vi.mock("@/lib/calendar/macro-events", () => ({
  fetchMacroEvents: vi.fn(async () => [] as CalendarEventInput[]),
  buildHardcodedMacroEvents: vi.fn(() => ({ events: [], nonFredKeyPrefixes: new Map() })),
}));
vi.mock("@/lib/calendar/finnhub", () => ({ fetchFinnhubEarningsForSymbols: vi.fn() }));
vi.mock("@/lib/calendar/nasdaq", () => ({
  fetchNasdaqEarningsForSymbols: vi.fn(async () => [] as CalendarEventInput[]),
}));
vi.mock("@/lib/queries/briefing-symbols", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/briefing-symbols")>()),
  getHeldStockSymbols: vi.fn(() => ["ZZA"]),
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
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import {
  deleteCalendarEvent,
  insertCalendarEvent,
  updateCalendarEvent,
  upsertCalendarEvents,
} from "@/lib/mutations/calendar";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { fetchFinnhubEarningsForSymbols } from "@/lib/calendar/finnhub";
import { fetchNasdaqEarningsForSymbols } from "@/lib/calendar/nasdaq";
import { fetchWshEvents } from "@/lib/tws/wsh";
import { parseWshEvents } from "@/lib/calendar/parse-wsh";
import { getIbApi } from "@/lib/tws/client";
import { addDays, mondayOf } from "@/lib/calendar/date-utils";

const TODAY = "2026-08-31";
/** Older than the reconciler looks (21 days back). */
const OLD_WEEK = "2026-04-27";
const OLD_DATE = "2026-04-28";
/** Further ahead than the reconciler looks (30 days). */
const FAR_WEEK = "2026-11-02";
const FAR_DATE = "2026-11-04";
/** Inside the reconciler's window. */
const NEAR_WEEK = "2026-09-07";
const NEAR_DATE = "2026-09-08";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.clearAllMocks();
  vi.mocked(getIbApi).mockReturnValue(null);
  process.env.FINNHUB_API_KEY = "test-key";
});

/** A feed row shaped as the real fetchers build it (source_key included). */
function feed(
  source: "finnhub" | "nasdaq" | "wsh",
  symbol: string,
  date: string,
  consensus: string | null = "EPS 1.00",
): CalendarEventInput {
  return {
    source,
    event_type: "earnings",
    event_date: date,
    event_time: null,
    title: `${symbol} Earnings`,
    description: null,
    symbol,
    expected_impact: "high",
    consensus_estimate: consensus,
    previous_value: null,
    raw_json: "{}",
    source_key: `${source}:${symbol}:${date}`,
    week_of: mondayOf(date),
  };
}

/** The hand-entered row, through the app's own writer. */
function addManual(symbol: string, date: string, consensus: string | null = null): number {
  return insertCalendarEvent(db, {
    symbol,
    event_date: date,
    week_of: mondayOf(date),
    consensus_estimate: consensus,
  }).id;
}

interface Row {
  id: number;
  source: string;
  event_date: string;
  superseded: number;
  date_status: string | null;
  consensus_estimate: string | null;
  actual_value: string | null;
}

function rowByKey(sourceKey: string): Row | undefined {
  return db
    .prepare(
      `SELECT id, source, event_date, COALESCE(superseded, 0) AS superseded, date_status,
              consensus_estimate, actual_value
         FROM calendar_events WHERE source_key = ?`,
    )
    .get(sourceKey) as Row | undefined;
}

function rowById(id: number): Row | undefined {
  return db
    .prepare(
      `SELECT id, source, event_date, COALESCE(superseded, 0) AS superseded, date_status,
              consensus_estimate, actual_value
         FROM calendar_events WHERE id = ?`,
    )
    .get(id) as Row | undefined;
}

function outboxRows(): Array<{ supersededEventIds: number[] }> {
  return (
    db.prepare("SELECT payload_json FROM cloud_outbox ORDER BY generation ASC").all() as {
      payload_json: string;
    }[]
  ).map((r) => JSON.parse(r.payload_json) as { supersededEventIds: number[] });
}

async function refresh(week: string, finnhub: CalendarEventInput[], nasdaq: CalendarEventInput[] = []) {
  vi.mocked(fetchFinnhubEarningsForSymbols).mockResolvedValueOnce(finnhub);
  vi.mocked(fetchNasdaqEarningsForSymbols).mockResolvedValueOnce(nasdaq);
  return syncCalendarForWeek(db, week, { includeMacro: false });
}

describe("the reconciler's window is the one the delete path mirrors", () => {
  // lib/mutations/calendar.ts keeps its own copy of the two window lengths
  // (they are private to the reconciler). If the reconciler's window ever
  // changes, this fails and points at that copy.
  it("resolves a lone row 21 days back and 30 days ahead, and not one day further", () => {
    const seed = (symbol: string, date: string) =>
      upsertCalendarEvents(db, [feed("finnhub", symbol, date)]);
    seed("ZZA", addDays(TODAY, -21));
    seed("ZZB", addDays(TODAY, -22));
    seed("ZZC", addDays(TODAY, 30));
    seed("ZZD", addDays(TODAY, 31));

    reconcileEarningsDates(db, { today: TODAY });

    const status = (symbol: string) =>
      (
        db.prepare("SELECT date_status FROM calendar_events WHERE symbol = ?").get(symbol) as {
          date_status: string | null;
        }
      ).date_status;
    expect(status("ZZA")).toBe("single");
    expect(status("ZZB")).toBeNull();
    expect(status("ZZC")).toBe("single");
    expect(status("ZZD")).toBeNull();
  });
});

describe("refreshing a week outside the reconciler's window", () => {
  it("stores the feed row hidden, fills the hand-entered row's empty consensus, reports 0 new", async () => {
    const manual = addManual("ZZA", OLD_DATE);

    const result = await refresh(OLD_WEEK, [feed("finnhub", "ZZA", OLD_DATE, "EPS 1.00")]);

    const feedRow = rowByKey(`finnhub:ZZA:${OLD_DATE}`)!;
    expect(feedRow.superseded).toBe(1);
    expect(rowById(manual)!.superseded).toBe(0);
    expect(rowById(manual)!.consensus_estimate).toBe("EPS 1.00");
    // No confirmation is written on the hand-entered row.
    expect(rowById(manual)!.date_status).toBeNull();
    expect(result.finnhubEvents).toBe(1);
    expect(result.finnhubNew).toBe(0);
    expect(result.newEvents).toBe(0);
    // It was never on screen, so the outcome line does not name it.
    expect(result.superseded).toEqual([]);
  });

  it("covers Nasdaq and Wall Street Horizon rows the same way", async () => {
    addManual("ZZA", OLD_DATE);
    vi.mocked(getIbApi).mockReturnValue({} as never);
    vi.mocked(fetchWshEvents).mockResolvedValue("[]" as never);
    vi.mocked(parseWshEvents).mockReturnValueOnce([feed("wsh", "ZZA", OLD_DATE)]);

    const result = await refresh(OLD_WEEK, [], [feed("nasdaq", "ZZA", OLD_DATE)]);

    expect(rowByKey(`nasdaq:ZZA:${OLD_DATE}`)!.superseded).toBe(1);
    expect(rowByKey(`wsh:ZZA:${OLD_DATE}`)!.superseded).toBe(1);
    expect(result.nasdaqNew).toBe(0);
    expect(result.wshNew).toBe(0);
    expect(result.newEvents).toBe(0);
  });

  it("the same refresh twice changes nothing", async () => {
    const manual = addManual("ZZA", OLD_DATE);
    await refresh(OLD_WEEK, [feed("finnhub", "ZZA", OLD_DATE, "EPS 1.00")]);
    const manualAfterFirst = rowById(manual);

    // A different estimate on the second pass must not replace the one held.
    const second = await refresh(OLD_WEEK, [feed("finnhub", "ZZA", OLD_DATE, "EPS 2.00")]);

    expect(rowByKey(`finnhub:ZZA:${OLD_DATE}`)!.superseded).toBe(1);
    expect(rowById(manual)).toEqual(manualAfterFirst);
    expect(second.finnhubNew).toBe(0);
    expect(second.superseded).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM calendar_events WHERE symbol = 'ZZA' AND COALESCE(superseded, 0) = 0",
        )
        .get(),
    ).toEqual({ n: 1 });
    // An old week is behind the cloud's lookback: nothing to publish.
    expect(outboxRows()).toEqual([]);
  });

  it("never overwrites a consensus the hand-entered row already holds", async () => {
    const manual = addManual("ZZA", OLD_DATE, "EPS 3.00");
    await refresh(OLD_WEEK, [feed("finnhub", "ZZA", OLD_DATE, "EPS 1.00")]);
    expect(rowById(manual)!.consensus_estimate).toBe("EPS 3.00");
  });

  it("leaves a feed row on a different date showing", async () => {
    const manual = addManual("ZZA", OLD_DATE);
    const otherDate = addDays(OLD_DATE, 2);

    const result = await refresh(OLD_WEEK, [feed("finnhub", "ZZA", otherDate)]);

    expect(rowByKey(`finnhub:ZZA:${otherDate}`)!.superseded).toBe(0);
    expect(rowById(manual)!.consensus_estimate).toBeNull();
    expect(result.finnhubNew).toBe(1);
  });

  it("does not pair a share-class sibling", async () => {
    addManual("GOOGL", OLD_DATE);
    upsertCalendarEvents(db, [feed("finnhub", "GOOG", OLD_DATE)]);
    expect(rowByKey(`finnhub:GOOG:${OLD_DATE}`)!.superseded).toBe(0);
  });

  it("behaves as before when no hand-entered row exists", async () => {
    const result = await refresh(OLD_WEEK, [feed("finnhub", "ZZA", OLD_DATE)]);
    expect(rowByKey(`finnhub:ZZA:${OLD_DATE}`)!.superseded).toBe(0);
    expect(result.finnhubNew).toBe(1);
    expect(upsertCalendarEvents(db, [feed("nasdaq", "ZZB", OLD_DATE)])).toEqual({
      total: 1,
      inserted: 1,
      updated: 0,
    });
  });

  it("a HIDDEN hand-entered row does not hide the feed row", async () => {
    const manual = addManual("ZZA", OLD_DATE);
    db.prepare("UPDATE calendar_events SET superseded = 1 WHERE id = ?").run(manual);

    const result = await refresh(OLD_WEEK, [feed("finnhub", "ZZA", OLD_DATE)]);

    expect(rowByKey(`finnhub:ZZA:${OLD_DATE}`)!.superseded).toBe(0);
    expect(rowById(manual)!.consensus_estimate).toBeNull();
    expect(result.finnhubNew).toBe(1);
  });

  it("leaves a feed row the user confirmed in place alone", () => {
    upsertCalendarEvents(db, [feed("finnhub", "ZZA", OLD_DATE)]);
    db.prepare(
      "UPDATE calendar_events SET date_status = 'user_confirmed' WHERE source = 'finnhub'",
    ).run();
    addManual("ZZA", OLD_DATE);

    upsertCalendarEvents(db, [feed("finnhub", "ZZA", OLD_DATE)]);

    const row = rowByKey(`finnhub:ZZA:${OLD_DATE}`)!;
    expect(row.superseded).toBe(0);
    expect(row.date_status).toBe("user_confirmed");
  });

  it("an existing showing feed row is hidden on its next write, and its records move", () => {
    // A pair an older refresh left showing: the feed row is kept by the
    // cleanup (it carries a bogey), so it arrives as an UPDATE.
    upsertCalendarEvents(db, [feed("finnhub", "ZZA", OLD_DATE)]);
    const feedId = rowByKey(`finnhub:ZZA:${OLD_DATE}`)!.id;
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus)
       VALUES (?, 'pdf_upload', 'Weekly note', 1.5)`,
    ).run(feedId);
    db.prepare("UPDATE calendar_events SET actual_value = 'EPS 1.10' WHERE id = ?").run(feedId);
    const manual = addManual("ZZA", OLD_DATE);

    const result = upsertCalendarEvents(db, [feed("finnhub", "ZZA", OLD_DATE)]);

    expect(result.hiddenBehindManual).toEqual([
      {
        sourceKey: `finnhub:ZZA:${OLD_DATE}`,
        title: "ZZA Earnings",
        eventDate: OLD_DATE,
        source: "finnhub",
        wasShowing: true,
      },
    ]);
    expect(rowById(feedId)!.superseded).toBe(1);
    // The hidden row keeps what it holds; the empty actual is filled.
    expect(rowById(feedId)!.actual_value).toBe("EPS 1.10");
    expect(rowById(manual)!.actual_value).toBe("EPS 1.10");
    expect(db.prepare("SELECT event_id FROM earnings_bogeys").all()).toEqual([
      { event_id: manual },
    ]);
  });

  it("names a row that WAS showing when the refresh started", async () => {
    await refresh(OLD_WEEK, [feed("finnhub", "ZZA", OLD_DATE)]);
    addManual("ZZA", OLD_DATE);

    const result = await refresh(OLD_WEEK, [feed("finnhub", "ZZA", OLD_DATE)]);

    expect(result.superseded).toEqual([
      {
        title: "ZZA Earnings",
        eventDate: OLD_DATE,
        source: "finnhub",
        reason: `the date you entered (${OLD_DATE}) takes its place`,
      },
    ]);
  });
});

describe("the cloud hears about a hidden row only when its list changed", () => {
  it("a week ahead of the window publishes the hidden id", async () => {
    addManual("ZZA", FAR_DATE);

    const result = await refresh(FAR_WEEK, [feed("finnhub", "ZZA", FAR_DATE)]);

    const feedRow = rowByKey(`finnhub:ZZA:${FAR_DATE}`)!;
    expect(feedRow.superseded).toBe(1);
    expect(result.finnhubNew).toBe(0);
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].supersededEventIds).toEqual([feedRow.id]);
  });

  it("an armed feed row's arm moves to the hand-entered row and is published", () => {
    upsertCalendarEvents(db, [feed("finnhub", "ZZA", FAR_DATE)]);
    const feedId = rowByKey(`finnhub:ZZA:${FAR_DATE}`)!.id;
    armWorksheet(db, feedId);
    const manual = addManual("ZZA", FAR_DATE);

    upsertCalendarEvents(db, [feed("finnhub", "ZZA", FAR_DATE)]);

    expect(db.prepare("SELECT event_id FROM earnings_worksheet_flags").all()).toEqual([
      { event_id: manual },
    ]);
    const newest = JSON.parse(
      (
        db
          .prepare("SELECT payload_json FROM cloud_outbox ORDER BY generation DESC LIMIT 1")
          .get() as { payload_json: string }
      ).payload_json,
    ) as { entries: Array<{ eventId: number; removed?: true }>; supersededEventIds: number[] };
    expect(newest.entries.filter((e) => !e.removed).map((e) => e.eventId)).toEqual([manual]);
    expect(newest.supersededEventIds).toEqual([feedId]);
  });
});

describe("inside the reconciler's window the outcome is unchanged", () => {
  it("the feed row ends hidden behind the hand-entered row and the row stays unconfirmed", async () => {
    const manual = addManual("ZZA", NEAR_DATE);

    const result = await refresh(NEAR_WEEK, [feed("finnhub", "ZZA", NEAR_DATE, "EPS 1.00")]);

    expect(rowByKey(`finnhub:ZZA:${NEAR_DATE}`)!.superseded).toBe(1);
    expect(rowById(manual)!.superseded).toBe(0);
    expect(rowById(manual)!.date_status).toBeNull();
    expect(rowById(manual)!.consensus_estimate).toBe("EPS 1.00");
    expect(result.finnhubNew).toBe(0);
  });
});

describe("removing the hand-entered row brings the hidden feed row back", () => {
  it("deleting it on an old week un-hides the feed row", async () => {
    const manual = addManual("ZZA", OLD_DATE);
    await refresh(OLD_WEEK, [feed("finnhub", "ZZA", OLD_DATE)]);
    expect(rowByKey(`finnhub:ZZA:${OLD_DATE}`)!.superseded).toBe(1);

    expect(deleteCalendarEvent(db, manual, { today: TODAY })).toBe(true);

    expect(rowById(manual)).toBeUndefined();
    expect(rowByKey(`finnhub:ZZA:${OLD_DATE}`)!.superseded).toBe(0);
  });

  it("deleting it on a week ahead of the window un-hides one row, Finnhub first, and tells the cloud", async () => {
    const manual = addManual("ZZA", FAR_DATE);
    await refresh(
      FAR_WEEK,
      [feed("finnhub", "ZZA", FAR_DATE)],
      [feed("nasdaq", "ZZA", FAR_DATE)],
    );
    expect(rowByKey(`finnhub:ZZA:${FAR_DATE}`)!.superseded).toBe(1);
    expect(rowByKey(`nasdaq:ZZA:${FAR_DATE}`)!.superseded).toBe(1);

    deleteCalendarEvent(db, manual, { today: TODAY });

    const finnhub = rowByKey(`finnhub:ZZA:${FAR_DATE}`)!;
    const nasdaq = rowByKey(`nasdaq:ZZA:${FAR_DATE}`)!;
    expect(finnhub.superseded).toBe(0);
    // One company shows one card per day: the duplicate stays hidden.
    expect(nasdaq.superseded).toBe(1);
    const rows = outboxRows();
    expect(rows[rows.length - 1].supersededEventIds).toEqual([nasdaq.id]);
  });

  it("the row that received the deleted row's records is the one that comes back", () => {
    upsertCalendarEvents(db, [feed("nasdaq", "ZZA", FAR_DATE)]);
    const manual = addManual("ZZA", FAR_DATE);
    upsertCalendarEvents(db, [feed("nasdaq", "ZZA", FAR_DATE)]);
    const nasdaqId = rowByKey(`nasdaq:ZZA:${FAR_DATE}`)!.id;
    expect(rowById(nasdaqId)!.superseded).toBe(1);
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus)
       VALUES (?, 'pdf_upload', 'Weekly note', 1.5)`,
    ).run(manual);

    deleteCalendarEvent(db, manual, { today: TODAY });

    expect(rowById(nasdaqId)!.superseded).toBe(0);
    expect(db.prepare("SELECT event_id FROM earnings_bogeys").all()).toEqual([
      { event_id: nasdaqId },
    ]);
  });

  it("does not bring back a date the user removed", async () => {
    const manual = addManual("ZZA", OLD_DATE);
    await refresh(OLD_WEEK, [feed("finnhub", "ZZA", OLD_DATE)]);
    db.prepare(
      "INSERT INTO calendar_event_suppressions (symbol, event_date, event_type) VALUES ('ZZA', ?, 'earnings')",
    ).run(OLD_DATE);

    deleteCalendarEvent(db, manual, { today: TODAY });

    expect(rowByKey(`finnhub:ZZA:${OLD_DATE}`)!.superseded).toBe(1);
  });

  it("moving the hand-entered row to another date un-hides the feed row on the old date", async () => {
    const manual = addManual("ZZA", OLD_DATE);
    await refresh(OLD_WEEK, [feed("finnhub", "ZZA", OLD_DATE)]);
    const newDate = addDays(OLD_DATE, 1);

    expect(
      updateCalendarEvent(db, { id: manual, event_date: newDate, week_of: mondayOf(newDate) }),
    ).toBe(true);

    expect(rowById(manual)!.event_date).toBe(newDate);
    expect(rowByKey(`finnhub:ZZA:${OLD_DATE}`)!.superseded).toBe(0);
  });

  it("an edit that keeps the date leaves the feed row hidden", async () => {
    const manual = addManual("ZZA", OLD_DATE);
    await refresh(OLD_WEEK, [feed("finnhub", "ZZA", OLD_DATE)]);

    updateCalendarEvent(db, { id: manual, event_time: "BMO" });

    expect(rowByKey(`finnhub:ZZA:${OLD_DATE}`)!.superseded).toBe(1);
  });
});

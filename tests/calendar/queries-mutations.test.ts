import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getUpcomingEvents,
  getEventsByWeek,
  getEventsForSecurity,
  getEventCountBySource,
  getLatestBriefing,
  getBriefingByWeek,
  isBriefingStale,
} from "@/lib/queries/calendar";
import {
  upsertCalendarEvents,
  saveBriefing,
  deleteEventsForWeek,
} from "@/lib/mutations/calendar";
import type { CalendarEventInput } from "@/lib/mutations/calendar";

// ─── Test setup ──────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(db: Database.Database, symbol: string, conId?: number): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, ib_con_id) VALUES (?, ?, 'stock', 'equity', 1, ?)"
    )
    .run(symbol, `${symbol} Corp`, conId ?? null);
  return result.lastInsertRowid as number;
}

function makeEvent(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return {
    source: "claude_macro",
    event_type: "fomc",
    event_date: "2026-04-01",
    event_time: "14:00",
    title: "FOMC Rate Decision",
    description: "Federal Reserve interest rate decision",
    expected_impact: "high",
    source_key: `test:${Math.random().toString(36).slice(2)}`,
    week_of: "2026-03-30",
    ...overrides,
  };
}

// ─── upsertCalendarEvents ────────────────────────────────────────

describe("upsertCalendarEvents", () => {
  it("inserts new events", () => {
    const events = [
      makeEvent({ source_key: "macro:fomc:2026-04-01", title: "FOMC Decision" }),
      makeEvent({ source_key: "macro:cpi:2026-04-02", event_type: "cpi", title: "CPI Release", event_date: "2026-04-02" }),
    ];

    const result = upsertCalendarEvents(db, events);
    expect(result).toEqual({ total: 2, inserted: 2, updated: 0 });

    const rows = getUpcomingEvents(db, { startDate: "2026-04-01", endDate: "2026-04-05" });
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("FOMC Decision");
    expect(rows[1].title).toBe("CPI Release");
  });

  it("updates on duplicate source_key", () => {
    const event = makeEvent({ source_key: "macro:fomc:2026-04-01", title: "Original Title" });
    upsertCalendarEvents(db, [event]);

    const updated = makeEvent({ source_key: "macro:fomc:2026-04-01", title: "Updated Title" });
    const result = upsertCalendarEvents(db, [updated]);
    expect(result).toEqual({ total: 1, inserted: 0, updated: 1 });

    const rows = getUpcomingEvents(db, { startDate: "2026-04-01", endDate: "2026-04-01" });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Updated Title");
  });

  it("returns zeros for empty array", () => {
    expect(upsertCalendarEvents(db, [])).toEqual({ total: 0, inserted: 0, updated: 0 });
  });

  it("stores normalized release_time during upsert", () => {
    upsertCalendarEvents(db, [
      makeEvent({
        source_key: "macro:cpi:release-time",
        event_type: "cpi",
        event_time: null,
      }),
      makeEvent({
        source_key: "manual:custom:release-time",
        event_type: "other",
        event_time: "07:15",
      }),
      makeEvent({
        source_key: "wsh:aapl:earnings:bmo",
        source: "wsh",
        event_type: "earnings",
        event_time: "BMO",
        title: "AAPL Earnings",
      }),
      makeEvent({
        source_key: "finnhub:msft:earnings:amc",
        source: "finnhub",
        event_type: "earnings",
        event_time: null,
        title: "MSFT Earnings",
        raw_json: JSON.stringify({ entry: { hour: "amc" } }),
      }),
      makeEvent({
        source_key: "manual:unknown:release-time",
        event_type: "other",
        event_time: null,
      }),
    ]);

    const rows = db
      .prepare(
        `SELECT source_key, release_time
         FROM calendar_events
         WHERE source_key IN (
           'macro:cpi:release-time',
           'manual:custom:release-time',
           'wsh:aapl:earnings:bmo',
           'finnhub:msft:earnings:amc',
           'manual:unknown:release-time'
         )`,
      )
      .all() as { source_key: string; release_time: string | null }[];
    const byKey = new Map(rows.map((r) => [r.source_key, r.release_time]));

    expect(byKey.get("macro:cpi:release-time")).toBe("08:30");
    expect(byKey.get("manual:custom:release-time")).toBe("07:15");
    expect(byKey.get("wsh:aapl:earnings:bmo")).toBe("08:00");
    expect(byKey.get("finnhub:msft:earnings:amc")).toBe("16:15");
    expect(byKey.get("manual:unknown:release-time")).toBeNull();
  });

  it("distinguishes new inserts from updates in mixed batch", () => {
    // Seed 2 existing events
    upsertCalendarEvents(db, [
      makeEvent({ source_key: "existing:1", title: "Existing 1" }),
      makeEvent({ source_key: "existing:2", title: "Existing 2" }),
    ]);

    // Upsert a batch of 3: 2 existing + 1 new
    const result = upsertCalendarEvents(db, [
      makeEvent({ source_key: "existing:1", title: "Updated 1" }),
      makeEvent({ source_key: "existing:2", title: "Updated 2" }),
      makeEvent({ source_key: "new:3", title: "Brand New" }),
    ]);
    expect(result).toEqual({ total: 3, inserted: 1, updated: 2 });
  });

  it("re-upsert of all existing events shows 0 inserted", () => {
    const events = [
      makeEvent({ source_key: "re:1" }),
      makeEvent({ source_key: "re:2" }),
      makeEvent({ source_key: "re:3" }),
    ];
    upsertCalendarEvents(db, events);

    const result = upsertCalendarEvents(db, events);
    expect(result).toEqual({ total: 3, inserted: 0, updated: 3 });
  });

  it("links security_id for WSH events", () => {
    const secId = seedSecurity(db, "AAPL", 265598);
    const event = makeEvent({
      source: "wsh",
      event_type: "earnings",
      source_key: "wsh:265598:earnings:2026-04-01",
      security_id: secId,
      symbol: "AAPL",
      ib_con_id: 265598,
    });

    upsertCalendarEvents(db, [event]);

    const rows = getEventsForSecurity(db, secId);
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("AAPL");
    expect(rows[0].ib_con_id).toBe(265598);
  });
});

// ─── getUpcomingEvents ───────────────────────────────────────────

describe("getUpcomingEvents", () => {
  it("filters by date range", () => {
    upsertCalendarEvents(db, [
      makeEvent({ source_key: "a", event_date: "2026-04-01" }),
      makeEvent({ source_key: "b", event_date: "2026-04-03" }),
      makeEvent({ source_key: "c", event_date: "2026-04-10" }),
    ]);

    const inRange = getUpcomingEvents(db, { startDate: "2026-04-01", endDate: "2026-04-05" });
    expect(inRange).toHaveLength(2);
  });

  it("filters by source", () => {
    upsertCalendarEvents(db, [
      makeEvent({ source: "claude_macro", source_key: "macro1" }),
      makeEvent({ source: "wsh", source_key: "wsh1", event_type: "earnings" }),
    ]);

    const macroOnly = getUpcomingEvents(db, { source: "claude_macro" });
    expect(macroOnly).toHaveLength(1);
    expect(macroOnly[0].source).toBe("claude_macro");
  });

  it("orders by date ascending", () => {
    upsertCalendarEvents(db, [
      makeEvent({ source_key: "c", event_date: "2026-04-03" }),
      makeEvent({ source_key: "a", event_date: "2026-04-01" }),
      makeEvent({ source_key: "b", event_date: "2026-04-02" }),
    ]);

    const all = getUpcomingEvents(db);
    expect(all[0].event_date).toBe("2026-04-01");
    expect(all[1].event_date).toBe("2026-04-02");
    expect(all[2].event_date).toBe("2026-04-03");
  });

  it("respects limit", () => {
    upsertCalendarEvents(
      db,
      Array.from({ length: 10 }, (_, i) =>
        makeEvent({ source_key: `e${i}`, event_date: `2026-04-${String(i + 1).padStart(2, "0")}` })
      )
    );

    const limited = getUpcomingEvents(db, { limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it("excludes superseded rows (deep-QA 2026-07-16: HOOD/AAPL earnings rendered twice)", () => {
    // One print, two source rows — reconcileEarningsDates marks the loser
    // superseded=1. Every getUpcomingEvents consumer is a display surface
    // (Security Detail Upcoming Events, UpcomingEventsCard, MorningBriefing,
    // GET /api/calendar/events), so superseded rows must never surface —
    // same rule getEventsByWeek already applies.
    upsertCalendarEvents(db, [
      makeEvent({
        source: "finnhub",
        source_key: "finnhub:HOOD:2026-07-29",
        event_type: "earnings",
        event_date: "2026-07-29",
      }),
      makeEvent({
        source: "nasdaq",
        source_key: "nasdaq:HOOD:2026-07-29",
        event_type: "earnings",
        event_date: "2026-07-29",
      }),
    ]);
    db.prepare(
      "UPDATE calendar_events SET superseded = 1 WHERE source_key = 'nasdaq:HOOD:2026-07-29'"
    ).run();

    const rows = getUpcomingEvents(db, { startDate: "2026-07-29", endDate: "2026-07-29" });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("finnhub");
  });
});

// ─── getEventsByWeek ─────────────────────────────────────────────

describe("getEventsByWeek", () => {
  it("returns events for a specific week", () => {
    upsertCalendarEvents(db, [
      makeEvent({ source_key: "w1", week_of: "2026-03-30" }),
      makeEvent({ source_key: "w2", week_of: "2026-03-30" }),
      makeEvent({ source_key: "w3", week_of: "2026-04-06" }),
    ]);

    const week1 = getEventsByWeek(db, "2026-03-30");
    expect(week1).toHaveLength(2);

    const week2 = getEventsByWeek(db, "2026-04-06");
    expect(week2).toHaveLength(1);
  });
});

// ─── getEventCountBySource ───────────────────────────────────────

describe("getEventCountBySource", () => {
  it("counts events by source for a week", () => {
    upsertCalendarEvents(db, [
      makeEvent({ source: "claude_macro", source_key: "m1", week_of: "2026-03-30" }),
      makeEvent({ source: "claude_macro", source_key: "m2", week_of: "2026-03-30" }),
      makeEvent({ source: "wsh", source_key: "w1", week_of: "2026-03-30", event_type: "earnings" }),
    ]);

    const counts = getEventCountBySource(db, "2026-03-30");
    const macroCount = counts.find((c) => c.source === "claude_macro");
    const wshCount = counts.find((c) => c.source === "wsh");
    expect(macroCount?.count).toBe(2);
    expect(wshCount?.count).toBe(1);
  });
});

// ─── deleteEventsForWeek ─────────────────────────────────────────

describe("deleteEventsForWeek", () => {
  it("deletes all events for a week", () => {
    upsertCalendarEvents(db, [
      makeEvent({ source_key: "a", week_of: "2026-03-30" }),
      makeEvent({ source_key: "b", week_of: "2026-03-30" }),
    ]);

    const deleted = deleteEventsForWeek(db, "2026-03-30");
    expect(deleted).toBe(2);
    expect(getEventsByWeek(db, "2026-03-30")).toHaveLength(0);
  });

  it("deletes only specified source", () => {
    upsertCalendarEvents(db, [
      makeEvent({ source: "claude_macro", source_key: "m1", week_of: "2026-03-30" }),
      makeEvent({ source: "wsh", source_key: "w1", week_of: "2026-03-30", event_type: "earnings" }),
    ]);

    const deleted = deleteEventsForWeek(db, "2026-03-30", "claude_macro");
    expect(deleted).toBe(1);

    const remaining = getEventsByWeek(db, "2026-03-30");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source).toBe("wsh");
  });
});

// ─── Briefings ───────────────────────────────────────────────────

describe("briefings", () => {
  it("saves and retrieves a briefing", () => {
    saveBriefing(db, {
      weekOf: "2026-03-30",
      title: "Week of March 30, 2026",
      content: "# Briefing\n\nThis week...",
      eventCount: 5,
      model: "claude-sonnet-4-7",
    });

    const briefing = getBriefingByWeek(db, "2026-03-30");
    expect(briefing).not.toBeNull();
    expect(briefing!.title).toBe("Week of March 30, 2026");
    expect(briefing!.event_count).toBe(5);
    expect(briefing!.content).toContain("This week");
  });

  it("upserts on same week", () => {
    saveBriefing(db, {
      weekOf: "2026-03-30",
      title: "V1",
      content: "old",
      eventCount: 3,
      model: "claude-sonnet-4-7",
    });

    saveBriefing(db, {
      weekOf: "2026-03-30",
      title: "V2",
      content: "new",
      eventCount: 5,
      model: "claude-sonnet-4-7",
    });

    const briefing = getBriefingByWeek(db, "2026-03-30");
    expect(briefing!.title).toBe("V2");
    expect(briefing!.content).toBe("new");
    expect(briefing!.event_count).toBe(5);
  });

  it("getLatestBriefing returns most recent", () => {
    saveBriefing(db, {
      weekOf: "2026-03-23",
      title: "Older",
      content: "old",
      eventCount: 2,
      model: "claude-sonnet-4-7",
    });
    saveBriefing(db, {
      weekOf: "2026-03-30",
      title: "Newer",
      content: "new",
      eventCount: 5,
      model: "claude-sonnet-4-7",
    });

    const latest = getLatestBriefing(db);
    expect(latest!.week_of).toBe("2026-03-30");
    expect(latest!.title).toBe("Newer");
  });

  it("returns null when no briefings exist", () => {
    expect(getLatestBriefing(db)).toBeNull();
    expect(getBriefingByWeek(db, "2026-03-30")).toBeNull();
  });
});

// ─── isBriefingStale ─────────────────────────────────────────────

describe("isBriefingStale", () => {
  it("returns false when no briefing exists", () => {
    expect(isBriefingStale(db, "2026-03-30")).toBe(false);
  });

  it("returns false when briefing exists but no events", () => {
    saveBriefing(db, {
      weekOf: "2026-03-30",
      title: "Empty",
      content: "none",
      eventCount: 0,
      model: "claude-opus-4-7",
    });
    expect(isBriefingStale(db, "2026-03-30")).toBe(false);
  });

  it("returns false when all events were created before the briefing", () => {
    // Insert event with an explicit older timestamp
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, week_of, created_at)
       VALUES ('claude_macro', 'cpi', '2026-04-01', 'Old CPI', 'old:1', '2026-03-30', '2026-03-29T00:00:00Z')`
    ).run();

    saveBriefing(db, {
      weekOf: "2026-03-30",
      title: "After events",
      content: "generated after events landed",
      eventCount: 1,
      model: "claude-opus-4-7",
    });

    expect(isBriefingStale(db, "2026-03-30")).toBe(false);
  });

  it("returns true when a newer event has been added since briefing", () => {
    saveBriefing(db, {
      weekOf: "2026-03-30",
      title: "Pre-event",
      content: "generated before event landed",
      eventCount: 0,
      model: "claude-opus-4-7",
    });

    // Insert event with explicit newer timestamp
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, week_of, created_at)
       VALUES ('finnhub', 'earnings', '2026-04-02', 'AAPL Earnings', 'fh:AAPL:2026-04-02', '2026-03-30', '2099-01-01T00:00:00Z')`
    ).run();

    expect(isBriefingStale(db, "2026-03-30")).toBe(true);
  });

  it("only considers events for the target week", () => {
    saveBriefing(db, {
      weekOf: "2026-03-30",
      title: "Week A",
      content: "for week A",
      eventCount: 0,
      model: "claude-opus-4-7",
    });

    // New event for a DIFFERENT week — should not make week A stale
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, week_of, created_at)
       VALUES ('finnhub', 'earnings', '2026-04-08', 'Other Week', 'fh:other:1', '2026-04-06', '2099-01-01T00:00:00Z')`
    ).run();

    expect(isBriefingStale(db, "2026-03-30")).toBe(false);
  });
});

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
      model: "claude-sonnet-4-6",
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
      model: "claude-sonnet-4-6",
    });

    saveBriefing(db, {
      weekOf: "2026-03-30",
      title: "V2",
      content: "new",
      eventCount: 5,
      model: "claude-sonnet-4-6",
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
      model: "claude-sonnet-4-6",
    });
    saveBriefing(db, {
      weekOf: "2026-03-30",
      title: "Newer",
      content: "new",
      eventCount: 5,
      model: "claude-sonnet-4-6",
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

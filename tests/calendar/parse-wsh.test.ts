import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { parseWshEvents } from "@/lib/calendar/parse-wsh";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(db: Database.Database, symbol: string, conId: number): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, ib_con_id) VALUES (?, ?, 'stock', 'equity', 1, ?)"
    )
    .run(symbol, `${symbol} Corp`, conId);
  return result.lastInsertRowid as number;
}

describe("parseWshEvents", () => {
  it("parses events from wpiFilterData array", () => {
    seedSecurity(db, "AAPL", 265598);
    seedSecurity(db, "MSFT", 272093);

    const json = JSON.stringify({
      wpiFilterData: [
        {
          conid: 265598,
          event_type: "earnings",
          event_date: "20260401",
          event_time: "BMO",
          title: "Apple Q2 Earnings",
          description: "Quarterly earnings report",
        },
        {
          conid: 272093,
          event_type: "analyst_meeting",
          event_date: "2026-04-03",
          title: "Microsoft Analyst Day",
        },
      ],
    });

    const events = parseWshEvents(json, "2026-03-30", db);

    expect(events).toHaveLength(2);

    // First event — AAPL earnings
    expect(events[0].source).toBe("wsh");
    expect(events[0].event_type).toBe("earnings");
    expect(events[0].event_date).toBe("2026-04-01"); // YYYYMMDD → YYYY-MM-DD
    expect(events[0].event_time).toBe("BMO");
    expect(events[0].symbol).toBe("AAPL");
    expect(events[0].security_id).toBeTruthy();
    expect(events[0].week_of).toBe("2026-03-30");

    // Second event — MSFT analyst meeting
    expect(events[1].event_type).toBe("analyst_meeting");
    expect(events[1].event_date).toBe("2026-04-03"); // Already YYYY-MM-DD
    expect(events[1].symbol).toBe("MSFT");
  });

  it("filters out dividend events", () => {
    const json = JSON.stringify({
      wpiFilterData: [
        {
          conid: 100,
          event_type: "dividend",
          event_date: "20260401",
          title: "AAPL Dividend",
        },
        {
          conid: 100,
          event_type: "ex_dividend",
          event_date: "20260402",
          title: "AAPL Ex-Dividend",
        },
        {
          conid: 100,
          event_type: "earnings",
          event_date: "20260403",
          title: "AAPL Earnings",
        },
      ],
    });

    const events = parseWshEvents(json, "2026-03-30", db);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("earnings");
  });

  it("handles unknown event types as 'other'", () => {
    const json = JSON.stringify({
      wpiFilterData: [
        {
          conid: 0,
          event_type: "ipo_lockup_expiry",
          event_date: "20260401",
          title: "Some IPO Lockup",
        },
      ],
    });

    const events = parseWshEvents(json, "2026-03-30", db);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("other");
  });

  it("handles top-level array format", () => {
    const json = JSON.stringify([
      {
        conid: 0,
        event_type: "earnings",
        event_date: "20260401",
        title: "Some Earnings",
      },
    ]);

    const events = parseWshEvents(json, "2026-03-30", db);
    expect(events).toHaveLength(1);
  });

  it("handles events array key", () => {
    const json = JSON.stringify({
      events: [
        {
          conId: 0,
          eventType: "conference",
          eventDate: "2026-04-01",
          event_title: "Tech Conference",
        },
      ],
    });

    const events = parseWshEvents(json, "2026-03-30", db);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("conference");
    expect(events[0].title).toBe("Tech Conference");
  });

  it("returns empty array for invalid JSON", () => {
    const events = parseWshEvents("not json", "2026-03-30", db);
    expect(events).toHaveLength(0);
  });

  it("returns empty array for unknown structure", () => {
    const events = parseWshEvents(JSON.stringify({ foo: "bar" }), "2026-03-30", db);
    expect(events).toHaveLength(0);
  });

  it("skips entries without dates", () => {
    const json = JSON.stringify({
      wpiFilterData: [
        { conid: 0, event_type: "earnings", title: "No Date" },
        { conid: 0, event_type: "earnings", event_date: "20260401", title: "Has Date" },
      ],
    });

    const events = parseWshEvents(json, "2026-03-30", db);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Has Date");
  });

  it("preserves raw_json per event", () => {
    const json = JSON.stringify({
      wpiFilterData: [
        {
          conid: 265598,
          event_type: "earnings",
          event_date: "20260401",
          title: "AAPL Q2",
          extra_field: "preserved",
        },
      ],
    });

    const events = parseWshEvents(json, "2026-03-30", db);
    expect(events[0].raw_json).toBeTruthy();
    const parsed = JSON.parse(events[0].raw_json!);
    expect(parsed.extra_field).toBe("preserved");
  });

  it("maps conId to security from database", () => {
    const secId = seedSecurity(db, "TSLA", 76792991);

    const json = JSON.stringify({
      wpiFilterData: [
        {
          conid: 76792991,
          event_type: "earnings",
          event_date: "20260401",
          title: "Tesla Q1",
        },
      ],
    });

    const events = parseWshEvents(json, "2026-03-30", db);
    expect(events[0].security_id).toBe(secId);
    expect(events[0].symbol).toBe("TSLA");
    expect(events[0].ib_con_id).toBe(76792991);
  });

  it("handles unmapped conId gracefully", () => {
    const json = JSON.stringify({
      wpiFilterData: [
        {
          conid: 999999,
          event_type: "earnings",
          event_date: "20260401",
          title: "Unknown Stock",
          symbol: "XYZ",
        },
      ],
    });

    const events = parseWshEvents(json, "2026-03-30", db);
    expect(events[0].security_id).toBeNull();
    expect(events[0].symbol).toBe("XYZ"); // Falls back to entry's symbol field
  });
});

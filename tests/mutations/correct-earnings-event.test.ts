/**
 * correctEarningsEventDate — extracted from scripts/correct-earnings-date.ts
 * (Task 2 of the earnings date-verification plan). See that script's header
 * comment for the original rationale (the NET case: Finnhub carried
 * 2026-07-30, the real print was Aug 6).
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  correctEarningsEventDate,
  upsertCalendarEvents,
  type CalendarEventInput,
} from "@/lib/mutations/calendar";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// helper: seed a finnhub earnings row
function seedFinnhub(db: Database.Database, symbol: string, date: string): number {
  upsertCalendarEvents(db, [
    {
      source: "finnhub",
      event_type: "earnings",
      event_date: date,
      event_time: null,
      title: `${symbol} earnings`,
      description: null,
      symbol,
      security_id: null,
      expected_impact: "high",
      consensus_estimate: "EPS 1.00",
      previous_value: null,
      raw_json: null,
      source_key: `finnhub:${symbol}:${date}`,
      week_of: "2026-08-03",
      release_time: "16:15",
    } as CalendarEventInput,
  ]);
  return (
    db.prepare(`SELECT id FROM calendar_events WHERE source_key = ?`).get(`finnhub:${symbol}:${date}`) as {
      id: number;
    }
  ).id;
}

describe("correctEarningsEventDate", () => {
  it("moves a wrong date: manual row created, wrong row deleted + suppressed, bogeys migrated", () => {
    const wrongId = seedFinnhub(db, "RKT", "2026-07-30");
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus) VALUES (?, 'manual', 'me', 0.5)`,
    ).run(wrongId);

    const res = correctEarningsEventDate(db, {
      symbol: "RKT",
      wrongDate: "2026-07-30",
      correctDate: "2026-08-06",
      slot: "AMC",
    });

    expect(res.ok).toBe(true);
    expect(res.deletedIds).toEqual([wrongId]);
    expect(res.bogeysMigrated).toBe(1);

    const manual = db
      .prepare(`SELECT id, event_date, event_time FROM calendar_events WHERE source='manual' AND symbol='RKT'`)
      .get() as { id: number; event_date: string; event_time: string };
    expect(manual.event_date).toBe("2026-08-06");
    expect(res.newEventId).toBe(manual.id);

    // bogey re-pointed onto the corrected event
    const bogey = db.prepare(`SELECT event_id FROM earnings_bogeys WHERE source_label='me'`).get() as {
      event_id: number;
    };
    expect(bogey.event_id).toBe(manual.id);

    // suppression recorded → re-sync of the wrong tuple is a no-op
    upsertCalendarEvents(db, []); // no-op sanity
    const beforeCount = (
      db
        .prepare(`SELECT COUNT(*) c FROM calendar_events WHERE symbol='RKT' AND event_date='2026-07-30'`)
        .get() as { c: number }
    ).c;
    expect(beforeCount).toBe(0);
    // re-run the same finnhub seed for the wrong (symbol, date) tuple — the
    // suppression table must block re-insert.
    upsertCalendarEvents(db, [
      {
        source: "finnhub",
        event_type: "earnings",
        event_date: "2026-07-30",
        event_time: null,
        title: "RKT earnings",
        description: null,
        symbol: "RKT",
        security_id: null,
        expected_impact: "high",
        consensus_estimate: "EPS 1.00",
        previous_value: null,
        raw_json: null,
        source_key: "finnhub:RKT:2026-07-30",
        week_of: "2026-08-03",
        release_time: "16:15",
      } as CalendarEventInput,
    ]);
    const afterCount = (
      db
        .prepare(`SELECT COUNT(*) c FROM calendar_events WHERE symbol='RKT' AND event_date='2026-07-30'`)
        .get() as { c: number }
    ).c;
    expect(afterCount).toBe(0);
  });

  it("refuses when the wrong row has captured actuals", () => {
    const id = seedFinnhub(db, "HUN", "2026-07-30");
    db.prepare(`UPDATE calendar_events SET actual_value='EPS 1.00' WHERE id=?`).run(id);

    const res = correctEarningsEventDate(db, { symbol: "HUN", wrongDate: "2026-07-30", correctDate: "2026-08-06" });

    expect(res.ok).toBe(false);
    expect(res.refusedReason).toMatch(/actuals/i);
    expect(db.prepare(`SELECT COUNT(*) c FROM calendar_events WHERE symbol='HUN'`).get()).toMatchObject({ c: 1 });
  });

  it("is idempotent: second call with no wrong rows still returns the manual row id", () => {
    seedFinnhub(db, "NET", "2026-07-30");
    const first = correctEarningsEventDate(db, { symbol: "NET", wrongDate: "2026-07-30", correctDate: "2026-08-06" });
    const second = correctEarningsEventDate(db, {
      symbol: "NET",
      wrongDate: "2026-07-30",
      correctDate: "2026-08-06",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.newEventId).toBe(first.newEventId);
    expect(second.deletedIds).toEqual([]);
  });

  it("defaults the slot to the wrong row's event_time when not passed", () => {
    seedFinnhub(db, "BMO1", "2026-07-30"); // release_time seeded '16:15' but event_time null in upsert path
    db.prepare(`UPDATE calendar_events SET event_time = 'BMO' WHERE symbol = 'BMO1'`).run();

    const res = correctEarningsEventDate(db, { symbol: "BMO1", wrongDate: "2026-07-30", correctDate: "2026-08-06" });

    expect(res.ok).toBe(true);
    const manual = db
      .prepare(`SELECT event_time FROM calendar_events WHERE source='manual' AND symbol='BMO1'`)
      .get() as { event_time: string };
    expect(manual.event_time).toBe("BMO");
  });

  it("falls back to AMC when there is no wrong row and no slot passed", () => {
    const res = correctEarningsEventDate(db, {
      symbol: "ZZZ",
      wrongDate: "2026-07-30",
      correctDate: "2026-08-06",
    });

    expect(res.ok).toBe(true);
    expect(res.deletedIds).toEqual([]);
    const manual = db
      .prepare(`SELECT event_time FROM calendar_events WHERE source='manual' AND symbol='ZZZ'`)
      .get() as { event_time: string };
    expect(manual.event_time).toBe("AMC");
  });
});

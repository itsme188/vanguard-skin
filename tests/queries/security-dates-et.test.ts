import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET } from "@/lib/calendar/date-utils";
import { getSecurityDetail } from "@/lib/queries/security-detail";
import {
  getCachedRegression,
  upsertRegression,
} from "@/lib/queries/security-regressions";

// 23:30 ET on Sep 3, but already Sep 4 in UTC. This is the boundary where
// slicing toISOString() produces the wrong user-facing/cache date.
const AFTER_UTC_MIDNIGHT_BEFORE_ET_MIDNIGHT = new Date(
  "2026-09-04T03:30:00.000Z",
);

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("ET date anchors for security queries", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_UTC_MIDNIGHT_BEFORE_ET_MIDNIGHT);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("includes an event occurring today in ET on Security Detail", () => {
    const securityId = Number(
      db
        .prepare(
          `INSERT INTO securities (symbol, name, security_type)
           VALUES ('AAPL', 'Apple Inc.', 'Stock')`,
        )
        .run().lastInsertRowid,
    );
    const today = todayET(AFTER_UTC_MIDNIGHT_BEFORE_ET_MIDNIGHT);

    db.prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, title, security_id,
          symbol, source_key)
       VALUES ('finnhub', 'earnings', ?, 'AMC', 'AAPL earnings', ?, 'AAPL', ?)`,
    ).run(today, securityId, `test:calendar:AAPL:${today}`);

    const detail = getSecurityDetail(db, securityId);

    expect(detail?.upcomingEvents.map((event) => event.event_date)).toEqual([
      today,
    ]);
  });

  it("stamps regression cache rows with today's ET date", () => {
    const securityId = Number(
      db
        .prepare(
          `INSERT INTO securities (symbol, name, security_type)
           VALUES ('AAPL', 'Apple Inc.', 'Stock')`,
        )
        .run().lastInsertRowid,
    );

    upsertRegression(db, {
      securityId,
      benchmarkSymbol: "SPY",
      result: {
        beta: 1.1,
        vol: 0.2,
        correlation: 0.8,
        rSquared: 0.64,
        dataPoints: 42,
      },
    });

    expect(getCachedRegression(db, securityId, "SPY")?.computedAtDay).toBe(
      todayET(AFTER_UTC_MIDNIGHT_BEFORE_ET_MIDNIGHT),
    );
  });
});

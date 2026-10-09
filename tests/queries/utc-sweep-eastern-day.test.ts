/**
 * The broader UTC sweep: a "today", or the calendar day of a stored instant,
 * is the EASTERN day.
 *
 * The clock is frozen (Date only) at 2026-03-10T01:30:00Z, which is 21:30
 * Eastern on 2026-03-09: the UTC calendar day has rolled over, the Eastern one
 * has not. Each assertion holds only for the Eastern reading.
 *
 * SQLite's own clock cannot be faked. That is what makes the level-scan cases
 * work: a predicate still built on date('now') compares against the real day
 * and fails one of the two directions.
 *
 * Synthetic symbols and round prices only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getSourcePerformance } from "@/lib/queries/level-performance";
import { computeSecurityRegression } from "@/lib/compute/security-regression";
import { getCachedLevelNarrative } from "@/lib/chart/narrate-levels";
import {
  findCrossedLevels,
  getArmedLevels,
  getLatestScanPriceForSecurity,
} from "@/lib/queries/security-levels";
import { upsertLevel } from "@/lib/mutations/security-levels";
import { isLevelPriceStale, LEVEL_PRICE_MAX_AGE_DAYS } from "@/lib/levels/scan-range";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { executeTool } from "@/lib/chat/tools";

const EVENING_ET = new Date("2026-03-10T01:30:00Z");
const ET_TODAY = "2026-03-09";

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(EVENING_ET);
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
});

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedPrice(secId: number, date: string, price: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')",
  ).run(secId, date, price);
}

describe("the frozen clock really straddles the two days", () => {
  it("reads 2026-03-09 in Eastern time and 2026-03-10 in UTC", () => {
    expect(todayET()).toBe(ET_TODAY);
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-03-10");
  });
});

describe("level performance: the forward window starts on the alert's Eastern day", () => {
  it("an alert fired at 21:30 Eastern counts 30 days from THAT day, not the next", () => {
    const sec = seedSecurity("ZZA");
    for (const id of [1, 2, 3]) {
      db.prepare(
        `INSERT INTO security_levels (id, security_id, level_type, price, source, source_author)
         VALUES (?, ?, 'support', 100, 'newsletter', 'Synthetic')`,
      ).run(id, sec);
      // The shape the Mac writer stores (datetime('now'): UTC, space-separated).
      // 02:30 UTC on 01-09 is 21:30 Eastern on 01-08.
      db.prepare(
        `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price, user_response)
         VALUES (?, ?, '2026-01-09 02:30:00', 100, 'acted')`,
      ).run(id, sec);
    }
    // Eastern day 01-08 + 30 = 02-07. A UTC (or local-parse) reading lands on
    // 02-08 and picks up the next day's close.
    seedPrice(sec, "2026-02-07", 110);
    seedPrice(sec, "2026-02-08", 200);

    const rows = getSourcePerformance(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].pnl_acted_30d).toBe(10);
  });

  it("a T/Z-shaped instant (the cloud-reconciled shape) reads the same way", () => {
    const sec = seedSecurity("ZZB");
    for (const id of [1, 2, 3]) {
      db.prepare(
        `INSERT INTO security_levels (id, security_id, level_type, price, source, source_author)
         VALUES (?, ?, 'support', 100, 'newsletter', 'Synthetic')`,
      ).run(id, sec);
      db.prepare(
        `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price, user_response)
         VALUES (?, ?, '2026-01-09T02:30:00.000Z', 100, 'acted')`,
      ).run(id, sec);
    }
    seedPrice(sec, "2026-02-07", 110);
    seedPrice(sec, "2026-02-08", 200);

    expect(getSourcePerformance(db)[0].pnl_acted_30d).toBe(10);
  });
});

describe("security regression: the lookback window starts N Eastern days back", () => {
  it("keeps the price dated exactly N days before the Eastern day", () => {
    const sec = seedSecurity("ZZA");
    const insBench = db.prepare(
      "INSERT INTO benchmark_prices (symbol, date, close_price) VALUES ('ZZBENCH', ?, ?)",
    );
    // 31 daily prices, 02-07 through 03-09: 30 returns when the window opens
    // on 02-07 (Eastern day minus 30), 29 when it opens on 02-08 (UTC).
    let bench = 100;
    let price = 100;
    for (let i = 30; i >= 0; i--) {
      const day = addDays(ET_TODAY, -i);
      const step = 0.01 + 0.005 * Math.sin(i * 0.7);
      bench *= Math.exp(step);
      price *= Math.exp(1.5 * step);
      insBench.run(day, bench);
      seedPrice(sec, day, price);
    }

    const out = computeSecurityRegression(db, sec, "ZZBENCH", 30);
    expect(out).not.toBeNull();
    expect(out!.dataPoints).toBe(30);
  });
});

describe("suggested-level narrative cache: the day key is the Eastern day", () => {
  it("still serves the narrative cached earlier the same Eastern day", () => {
    const sec = seedSecurity("ZZA");
    db.prepare(
      `INSERT INTO suggested_level_narratives
         (security_id, level_price, direction, narrative, computed_at_day)
       VALUES (?, 100, 'support', 'Buyers defended this shelf twice.', ?)`,
    ).run(sec, ET_TODAY);

    expect(
      getCachedLevelNarrative(db, { securityId: sec, levelPrice: 100, direction: "support" }),
    ).toBe("Buyers defended this shelf twice.");
  });

  it("does not serve a row keyed to the UTC day that has not started in Eastern time", () => {
    const sec = seedSecurity("ZZA");
    db.prepare(
      `INSERT INTO suggested_level_narratives
         (security_id, level_price, direction, narrative, computed_at_day)
       VALUES (?, 100, 'support', 'Keyed to tomorrow.', '2026-03-10')`,
    ).run(sec);

    expect(
      getCachedLevelNarrative(db, { securityId: sec, levelPrice: 100, direction: "support" }),
    ).toBeNull();
  });
});

describe("level scan: price freshness counts back from the Eastern day", () => {
  function armLevel(sec: number): number {
    return upsertLevel(db, {
      security_id: sec,
      level_type: "resistance",
      price: 90,
      source: "user",
      review_status: "auto_approved",
    });
  }

  it("a price exactly at the window edge (Eastern day minus the window) is scanned", () => {
    const sec = seedSecurity("ZZA");
    const edge = addDays(ET_TODAY, -LEVEL_PRICE_MAX_AGE_DAYS); // 2026-03-05
    seedPrice(sec, edge, 100);
    armLevel(sec);

    expect(isLevelPriceStale(edge, todayET())).toBe(false);
    expect(getLatestScanPriceForSecurity(db, sec).isFresh).toBe(true);
    expect(findCrossedLevels(db).map((l) => l.security_id)).toEqual([sec]);
    expect(getArmedLevels(db)[0].price_is_stale).toBe(false);
  });

  it("a price one day past the window edge is skipped", () => {
    const sec = seedSecurity("ZZA");
    const past = addDays(ET_TODAY, -LEVEL_PRICE_MAX_AGE_DAYS - 1); // 2026-03-04
    seedPrice(sec, past, 100);
    armLevel(sec);

    expect(isLevelPriceStale(past, todayET())).toBe(true);
    expect(getLatestScanPriceForSecurity(db, sec).isFresh).toBe(false);
    expect(findCrossedLevels(db)).toEqual([]);
    expect(getArmedLevels(db)[0].price_is_stale).toBe(true);
  });

  it("the window follows the app clock, not SQLite's: a far-future clock makes a real-today price stale", () => {
    // Real "today" as SQLite sees it, read before the clock moves.
    const realDay = (db.prepare("SELECT date('now') AS d").get() as { d: string }).d;
    vi.setSystemTime(new Date("2040-01-10T01:30:00Z"));
    const sec = seedSecurity("ZZA");
    seedPrice(sec, realDay, 100);
    armLevel(sec);

    expect(getLatestScanPriceForSecurity(db, sec).isFresh).toBe(false);
    expect(findCrossedLevels(db)).toEqual([]);
  });
});

describe("chat query_calendar_events: the window is anchored on the Eastern day", () => {
  function seedEvent(date: string, title: string): void {
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, week_of)
       VALUES ('manual', 'macro', ?, ?, ?, '2026-03-09')`,
    ).run(date, title, `test:${title}`);
  }

  it("days_ahead 0 returns the Eastern day's events, not the next day's", async () => {
    seedEvent("2026-03-09", "Tonight");
    seedEvent("2026-03-10", "Tomorrow");

    const out = (await executeTool(db, "query_calendar_events", { days_ahead: 0 })) as {
      data: { events: Array<{ title: string }> };
    };
    expect(out.data.events.map((e) => e.title)).toEqual(["Tonight"]);
  });

  it("days_back 1 / days_ahead 1 spans the Eastern yesterday through the Eastern tomorrow", async () => {
    seedEvent("2026-03-08", "Yesterday");
    seedEvent("2026-03-10", "Tomorrow");
    seedEvent("2026-03-11", "Day after");

    const out = (await executeTool(db, "query_calendar_events", { days_ahead: 1, days_back: 1 })) as {
      data: { events: Array<{ title: string }> };
    };
    expect(out.data.events.map((e) => e.title)).toEqual(["Yesterday", "Tomorrow"]);
  });
});

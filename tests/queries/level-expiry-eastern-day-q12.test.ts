/**
 * Q12: a level's expiry date is an EASTERN calendar day on the Mac.
 *
 * SQLite date('now') is the UTC day. After 20:00 Eastern the UTC day is
 * already tomorrow, so a level expiring "today" dropped out of the armed set
 * four to five hours early, while the Worker scan (Eastern day) still watched
 * it. Every Mac reader of the expiry now binds todayET().
 *
 * The clock is pinned with fake timers (Date only). SQLite's own clock cannot
 * be faked, which is the point: a reader still using date('now') compares
 * against the real day and fails one of the two directions below.
 * Synthetic symbols and round prices only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertLevel } from "@/lib/mutations/security-levels";
import {
  countScanCoverage,
  findCrossedLevels,
  getActiveLevelCountsForSecurityIds,
  getActiveLevels,
  getArmedLevels,
  isLevelInArmedUniverse,
} from "@/lib/queries/security-levels";
import { getLevelsNearPrice } from "@/lib/queries/briefing-levels";
import { buildSnapshot } from "@/scripts/snapshot-state-to-r2";
import { todayET, addDays } from "@/lib/calendar/date-utils";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
});

function seedSec(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedPrice(secId: number, date: string, price: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'manual')"
  ).run(secId, date, price);
}

/** Three levels on one security: expiring on `today`, the day before, and never. */
function seedThree(today: string) {
  const sec = seedSec("ZZA");
  seedPrice(sec, today, 100);
  const expiresToday = upsertLevel(db, {
    security_id: sec, level_type: "support", price: 99, expires_at: today,
  });
  const expiredYesterday = upsertLevel(db, {
    security_id: sec, level_type: "support", price: 98, expires_at: addDays(today, -1),
  });
  const neverExpires = upsertLevel(db, {
    security_id: sec, level_type: "support", price: 97,
  });
  return { sec, expiresToday, expiredYesterday, neverExpires };
}

function expectEasternDayEverywhere(ids: ReturnType<typeof seedThree>): void {
  const { sec, expiresToday, expiredYesterday, neverExpires } = ids;
  const want = [expiresToday, neverExpires].sort();

  expect(isLevelInArmedUniverse(db, expiresToday)).toBe(true);
  expect(isLevelInArmedUniverse(db, neverExpires)).toBe(true);
  expect(isLevelInArmedUniverse(db, expiredYesterday)).toBe(false);

  expect(getArmedLevels(db).map((l) => l.id).sort()).toEqual(want);
  expect(countScanCoverage(db).armed).toBe(2);
  expect(getActiveLevelCountsForSecurityIds(db, [sec]).get(sec)).toBe(2);

  expect(getActiveLevels(db).map((l) => l.id).sort()).toEqual(want);
  expect(getActiveLevels(db, { securityId: sec }).map((l) => l.id).sort()).toEqual(want);
  expect(getActiveLevels(db, { includeExpired: true })).toHaveLength(3);

  expect(getLevelsNearPrice(db).map((l) => l.level_id).sort()).toEqual(want);

  const snap = buildSnapshot(db) as unknown as { securityLevels?: Array<{ id: number }> };
  expect((snap.securityLevels ?? []).map((l) => l.id).sort()).toEqual(want);
}

describe("a level's expiry day is the Eastern day", () => {
  it("21:00 Eastern on the expiry day (already tomorrow in UTC): still armed", () => {
    // 2020-03-15T01:00Z is 2020-03-14 21:00 in New York (daylight time).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2020-03-15T01:00:00.000Z"));
    expect(todayET()).toBe("2020-03-14");
    expect(new Date().toISOString().slice(0, 10)).toBe("2020-03-15");

    expectEasternDayEverywhere(seedThree("2020-03-14"));
  });

  it("a level whose expiry day has passed in Eastern time is not armed, whatever SQLite's clock says", () => {
    // Far future: SQLite's real UTC day is long before every date here.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-03-15T01:00:00.000Z"));
    expect(todayET()).toBe("2099-03-14");

    expectEasternDayEverywhere(seedThree("2099-03-14"));
  });

  it("the scan itself keeps a level through its Eastern expiry day and drops it the day after", () => {
    // Real clock: the scan's price-freshness window is SQLite's, so a fresh
    // price has to be dated off the real day.
    const today = todayET();
    const sec = seedSec("ZZB");
    seedPrice(sec, today, 100);
    // Support above the price: the condition holds for both rows.
    const live = upsertLevel(db, {
      security_id: sec, level_type: "support", price: 110, expires_at: today,
    });
    upsertLevel(db, {
      security_id: sec, level_type: "support", price: 120, expires_at: addDays(today, -1),
    });
    expect(findCrossedLevels(db).map((l) => l.id)).toEqual([live]);
  });
});

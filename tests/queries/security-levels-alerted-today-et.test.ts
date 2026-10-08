/**
 * "Alerted today" is the EASTERN day, and the page reads it in one query.
 *
 * hasAlertToday used SQLite date('now'), the UTC day. The UTC day rolls over
 * at 20:00 ET (19:00 in winter), so an alert fired last night at 23:00 ET
 * still read "alerted today" at 00:30 ET, and the "next alert can come
 * tomorrow" wording meant the UTC rollover. The day is now decided in JS in
 * America/New_York from the stored UTC instant.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { runMigrations } from "@/lib/db/migrate";
import {
  getLevelIdsAlertedToday,
  hasAlertToday,
  isLevelInArmedUniverse,
  getActiveLevelCountsForSecurityIds,
} from "@/lib/queries/security-levels";
import {
  deactivateLevel,
  reactivateLevel,
  setLevelReviewStatus,
  triggerLevel,
  upsertLevel,
} from "@/lib/mutations/security-levels";
import { sliceBetween } from "@/tests/helpers/source-anchor";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedLevel(secId: number, price = 100, extra: { expires_at?: string } = {}): number {
  return upsertLevel(db, { security_id: secId, level_type: "entry", price, ...extra });
}

/** Insert an alert row directly, with the stored timestamp exactly as given. */
function seedAlert(levelId: number, secId: number, triggeredAt: string): void {
  db.prepare(
    "INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price) VALUES (?, ?, ?, 100)"
  ).run(levelId, secId, triggeredAt);
}

describe("hasAlertToday — the Eastern day, not the UTC day", () => {
  it("summer: an alert at 21:00 ET still counts at 21:30 ET", () => {
    const sec = seedSecurity("AAA");
    const id = seedLevel(sec);
    seedAlert(id, sec, "2026-07-15T01:00:00.000Z"); // 2026-07-14 21:00 EDT
    expect(hasAlertToday(db, id, new Date("2026-07-15T01:30:00Z"))).toBe(true);
  });

  it("summer: an alert at 19:00 ET still counts at 20:30 ET, after the UTC day rolled", () => {
    const sec = seedSecurity("AAA");
    const id = seedLevel(sec);
    seedAlert(id, sec, "2026-07-14T23:00:00.000Z"); // 2026-07-14 19:00 EDT
    expect(hasAlertToday(db, id, new Date("2026-07-15T00:30:00Z"))).toBe(true);
  });

  it("summer: an alert yesterday at 23:00 ET does not count at 00:30 ET", () => {
    const sec = seedSecurity("AAA");
    const id = seedLevel(sec);
    seedAlert(id, sec, "2026-07-15T03:00:00.000Z"); // 2026-07-14 23:00 EDT
    expect(hasAlertToday(db, id, new Date("2026-07-15T04:30:00Z"))).toBe(false);
    // ...and it did count one minute before Eastern midnight.
    expect(hasAlertToday(db, id, new Date("2026-07-15T03:59:00Z"))).toBe(true);
  });

  it("winter (UTC-5): the boundary is Eastern midnight, 05:00 UTC", () => {
    const sec = seedSecurity("AAA");
    const id = seedLevel(sec);
    seedAlert(id, sec, "2026-01-15T04:00:00.000Z"); // 2026-01-14 23:00 EST
    expect(hasAlertToday(db, id, new Date("2026-01-15T04:59:00Z"))).toBe(true);
    expect(hasAlertToday(db, id, new Date("2026-01-15T05:30:00Z"))).toBe(false);
  });

  it("reads a space-separated SQLite timestamp as UTC", () => {
    const sec = seedSecurity("AAA");
    const id = seedLevel(sec);
    seedAlert(id, sec, "2026-07-15 03:00:00"); // 2026-07-14 23:00 EDT
    expect(hasAlertToday(db, id, new Date("2026-07-15T03:30:00Z"))).toBe(true);
    expect(hasAlertToday(db, id, new Date("2026-07-15T04:30:00Z"))).toBe(false);
  });

  it("an alert from the same Eastern weekday a week ago does not count", () => {
    const sec = seedSecurity("AAA");
    const id = seedLevel(sec);
    seedAlert(id, sec, "2026-07-08T15:00:00.000Z");
    expect(hasAlertToday(db, id, new Date("2026-07-15T15:00:00Z"))).toBe(false);
  });

  it("with no clock passed, a fire just now counts (the live path)", () => {
    const sec = seedSecurity("AAA");
    const id = seedLevel(sec);
    expect(hasAlertToday(db, id)).toBe(false);
    triggerLevel(db, { levelId: id, securityId: sec, triggeredPrice: 99 });
    expect(hasAlertToday(db, id)).toBe(true);
  });
});

describe("getLevelIdsAlertedToday — one read for the page", () => {
  it("returns exactly the levels with an alert in the Eastern day", () => {
    const sec = seedSecurity("AAA");
    const today = seedLevel(sec, 100);
    const lastNight = seedLevel(sec, 110);
    const never = seedLevel(sec, 120);
    const twice = seedLevel(sec, 130);
    const now = new Date("2026-07-15T14:00:00Z"); // 10:00 EDT on 2026-07-15
    seedAlert(today, sec, "2026-07-15T13:00:00.000Z");
    seedAlert(lastNight, sec, "2026-07-15T03:00:00.000Z"); // 23:00 EDT on the 14th
    seedAlert(twice, sec, "2026-07-15T03:30:00.000Z"); // the 14th
    seedAlert(twice, sec, "2026-07-15T04:30:00.000Z"); // 00:30 EDT on the 15th

    const ids = getLevelIdsAlertedToday(db, now);
    expect([...ids].sort((a, b) => a - b)).toEqual([today, twice]);
    // The page read and the single-level read agree on every level.
    for (const id of [today, lastNight, never, twice]) {
      expect(hasAlertToday(db, id, now)).toBe(ids.has(id));
    }
  });

  it("GET /api/levels reads it once, not once per level", () => {
    const route = readFileSync("app/api/levels/route.ts", "utf8");
    const get = sliceBetween(route, "export async function GET", "export async function POST");
    expect(get.split("getLevelIdsAlertedToday(db)").length - 1).toBe(1);
    expect(get).toMatch(/alerted_today: alertedToday\.has\(l\.id\)/);
    expect(route).not.toMatch(/hasAlertToday\(/);
  });
});

describe("getActiveLevelCountsForSecurityIds — the scanner's armed universe", () => {
  it("counts exactly the rows isLevelInArmedUniverse accepts", () => {
    const sec = seedSecurity("AAA");
    const other = seedSecurity("ZZZ");
    const quiet = seedSecurity("QQQQ");
    const utcToday = (db.prepare("SELECT date('now') AS d").get() as { d: string }).d;

    const armed = seedLevel(sec, 100);
    const paused = seedLevel(sec, 110);
    deactivateLevel(db, paused);
    const expired = seedLevel(sec, 120, { expires_at: "2020-01-01" });
    const expiresToday = seedLevel(sec, 125, { expires_at: utcToday });
    const expiresLater = seedLevel(sec, 127, { expires_at: "2099-12-31" });
    const firedOnce = seedLevel(sec, 130);
    triggerLevel(db, { levelId: firedOnce, securityId: sec, triggeredPrice: 129 });
    const firedThenRearmed = seedLevel(sec, 140);
    triggerLevel(db, { levelId: firedThenRearmed, securityId: sec, triggeredPrice: 139 });
    reactivateLevel(db, firedThenRearmed, { force: true });
    const rejected = seedLevel(sec, 150);
    setLevelReviewStatus(db, rejected, "rejected");
    const pending = seedLevel(sec, 160);
    setLevelReviewStatus(db, pending, "pending_review");
    const otherArmed = seedLevel(other, 50);
    const quietPaused = seedLevel(quiet, 60);
    deactivateLevel(db, quietPaused);

    const expectArmed = new Map<number, boolean>([
      [armed, true],
      [paused, false],
      [expired, false],
      [expiresToday, true],
      [expiresLater, true],
      [firedOnce, false],
      [firedThenRearmed, true],
      [rejected, false],
      [pending, false],
      [otherArmed, true],
      [quietPaused, false],
    ]);
    for (const [id, want] of expectArmed) {
      expect(isLevelInArmedUniverse(db, id), `level ${id}`).toBe(want);
    }

    const counts = getActiveLevelCountsForSecurityIds(db, [sec, other, quiet]);
    expect(counts.get(sec)).toBe(4);
    expect(counts.get(other)).toBe(1);
    expect(counts.has(quiet)).toBe(false);
    // A security left out of the id list is left out of the result.
    expect(getActiveLevelCountsForSecurityIds(db, [other]).has(sec)).toBe(false);
    expect(getActiveLevelCountsForSecurityIds(db, []).size).toBe(0);
  });

  it("builds its WHERE from ARMED_UNIVERSE_WHERE_SQL, with no second copy of the predicate", () => {
    const src = readFileSync("lib/queries/security-levels.ts", "utf8");
    const fn = sliceBetween(
      src,
      "export function getActiveLevelCountsForSecurityIds(",
      "export function getPendingReviewCount("
    );
    expect(fn).toContain("${ARMED_UNIVERSE_WHERE_SQL}");
    expect(fn).not.toMatch(/review_status\s*=/);
    expect(fn).not.toMatch(/date\('now'\)/);
  });
});

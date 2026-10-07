/**
 * Reactivation and approval share ONE arm guard (lib/alerts/arm-guard.ts).
 * These tests run the real mutation, the real scan and the real dedupe on an
 * in-memory database. SQLite's own clock cannot be injected, so "an earlier
 * day" is a fixed far-future stamp (never equal to today) and "the next day"
 * is reached by moving the stored alert one day back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAlerts, getLevelById } from "@/lib/queries/security-levels";
import {
  deactivateLevel,
  reactivateLevel,
  setLevelReviewStatus,
  triggerLevel,
  upsertLevel,
} from "@/lib/mutations/security-levels";
import { approveLevelGuarded } from "@/lib/alerts/approve";
import { detectAndFireAlerts } from "@/lib/alerts/detect";

const PRICE_DATE = "2099-01-02";
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.stubEnv("PUSHOVER_APP_TOKEN", "");
  vi.stubEnv("PUSHOVER_USER_KEY", "");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function setPrice(securityId: number, price: number): void {
  db.prepare("DELETE FROM prices WHERE security_id = ?").run(securityId);
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'manual')"
  ).run(securityId, PRICE_DATE, price);
}

/** A paused resistance level at 100 with the price at `price`. */
function pausedLevel(symbol: string, price: number): { secId: number; id: number } {
  const secId = seedSecurity(symbol);
  const id = upsertLevel(db, { security_id: secId, level_type: "resistance", price: 100 });
  setPrice(secId, price);
  deactivateLevel(db, id);
  return { secId, id };
}

describe("reactivateLevel — armed_crossed_at agrees with approval", () => {
  it("a forced reactivate of a crossed level stamps armed_crossed_at, as a forced approval does", () => {
    const a = pausedLevel("ZZRA", 120);
    expect(reactivateLevel(db, a.id, { force: true }).ok).toBe(true);
    expect(getLevelById(db, a.id)!.armed_crossed_at).not.toBeNull();

    const secId = seedSecurity("ZZRB");
    const b = upsertLevel(db, {
      security_id: secId,
      level_type: "resistance",
      price: 100,
      review_status: "pending_review",
    });
    setPrice(secId, 120);
    expect(approveLevelGuarded(db, b, { force: true }).ok).toBe(true);
    expect(getLevelById(db, b)!.armed_crossed_at).not.toBeNull();
  });

  it("a clean reactivate clears a stale stamp left by an earlier forced arm", () => {
    const { secId, id } = pausedLevel("ZZRC", 120);
    reactivateLevel(db, id, { force: true });
    expect(getLevelById(db, id)!.armed_crossed_at).not.toBeNull();

    deactivateLevel(db, id);
    setPrice(secId, 90); // back below the resistance: nothing is crossed now
    const result = reactivateLevel(db, id);

    expect(result.ok).toBe(true);
    const level = getLevelById(db, id)!;
    expect(level.is_active).toBe(1);
    expect(level.armed_crossed_at).toBeNull();
  });

  it("a forced reactivate of a level outside the scan range does not stamp (nothing was crossed)", () => {
    const { id } = pausedLevel("ZZRD", 10);
    expect(reactivateLevel(db, id)).toMatchObject({ ok: false, code: "beyond_scan_range" });
    expect(getLevelById(db, id)!.is_active).toBe(0);

    expect(reactivateLevel(db, id, { force: true }).ok).toBe(true);
    const level = getLevelById(db, id)!;
    expect(level.is_active).toBe(1);
    expect(level.armed_crossed_at).toBeNull();
  });

  it("a refusal writes nothing, updated_at included", () => {
    const { id } = pausedLevel("ZZRE", 120);
    db.prepare("UPDATE security_levels SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(id);
    const before = getLevelById(db, id)!;

    expect(reactivateLevel(db, id)).toMatchObject({
      ok: false,
      code: "would_fire_immediately",
      currentPrice: 120,
      effectivePrice: 100,
    });
    expect(getLevelById(db, id)).toEqual(before);
  });
});

describe("reactivateLevel — the guard only applies to a level the scanner would watch", () => {
  it.each(["rejected", "pending_review"] as const)(
    "a crossed %s level re-activates without a refusal and reports it is not armed",
    (status) => {
      const { id } = pausedLevel(`ZZS${status === "rejected" ? "R" : "P"}`, 120);
      setLevelReviewStatus(db, id, status);

      const result = reactivateLevel(db, id);

      expect(result).toMatchObject({ ok: true, armed: false });
      const level = getLevelById(db, id)!;
      expect(level.is_active).toBe(1);
      expect(level.review_status).toBe(status);
      expect(level.armed_crossed_at).toBeNull();
      // …and the scanner really does ignore it.
      expect(detectAndFireAlerts(db).fired).toBe(0);
    }
  );

  it("a crossed, expired level re-activates without a refusal and reports it is not armed", () => {
    const { id } = pausedLevel("ZZSE", 120);
    db.prepare("UPDATE security_levels SET expires_at = '2000-01-01' WHERE id = ?").run(id);

    expect(reactivateLevel(db, id)).toMatchObject({ ok: true, armed: false });
    expect(getLevelById(db, id)!.is_active).toBe(1);
    expect(detectAndFireAlerts(db).fired).toBe(0);
  });

  it("an auto-approved, unexpired level reports armed: true", () => {
    const { id } = pausedLevel("ZZSA", 90);
    expect(reactivateLevel(db, id)).toMatchObject({ ok: true, armed: true, alertedToday: false });
  });
});

describe("reactivateLevel — same-day honesty", () => {
  it("fire, force re-arm, scan the same day: no second alert and the level stays active; the next day it fires", () => {
    const secId = seedSecurity("ZZSD");
    const id = upsertLevel(db, { security_id: secId, level_type: "resistance", price: 100 });
    setPrice(secId, 120);

    expect(detectAndFireAlerts(db).fired).toBe(1);
    expect(getLevelById(db, id)!.is_active).toBe(0);

    // Without force the refusal already says a fire happened today.
    expect(reactivateLevel(db, id)).toMatchObject({
      ok: false,
      code: "would_fire_immediately",
      alertedToday: true,
    });

    expect(reactivateLevel(db, id, { force: true })).toMatchObject({
      ok: true,
      armed: true,
      alertedToday: true,
    });

    const sameDay = detectAndFireAlerts(db);
    expect(sameDay.fired).toBe(0);
    expect(sameDay.deduped).toBe(1);
    expect(getAlerts(db)).toHaveLength(1);
    expect(getLevelById(db, id)!.is_active).toBe(1);

    // Next day: the stored alert is now yesterday's.
    db.prepare(
      "UPDATE level_alerts SET triggered_at = datetime(triggered_at, '-1 day') WHERE level_id = ?"
    ).run(id);
    const nextDay = detectAndFireAlerts(db);
    expect(nextDay.fired).toBe(1);
    expect(getAlerts(db)).toHaveLength(2);
    expect(getLevelById(db, id)!.is_active).toBe(0);
  });
});

describe("one guard, two callers (source pin)", () => {
  it("approval and reactivation both call evaluateArmGuard and neither evaluates the trigger itself", () => {
    const approve = readFileSync("lib/alerts/approve.ts", "utf8");
    const mutations = readFileSync("lib/mutations/security-levels.ts", "utf8");
    const guard = readFileSync("lib/alerts/arm-guard.ts", "utf8");

    for (const src of [approve, mutations]) {
      expect(src).toMatch(/evaluateArmGuard\(db, /);
      expect(src).not.toMatch(/checkLevelTriggerState\(/);
      expect(src).not.toMatch(/getLatestScanPriceForSecurity\(/);
      expect(src).toContain("ARMED_CROSSED_AT_SET_SQL");
    }
    expect(guard).toMatch(/checkLevelTriggerState\(/);
    // The armed-universe test comes from the scanner's own predicate.
    expect(mutations).toMatch(/isLevelInArmedUniverse\(db, /);
    expect(mutations).not.toMatch(/review_status\s*={1,3}\s*['"]auto_approved/);
  });
});

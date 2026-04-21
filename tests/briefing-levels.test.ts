import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";
import {
  getLevelsTriggeredInWindow,
  getLevelsNearPrice,
} from "@/lib/queries/briefing-levels";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSec(symbol: string): number {
  const r = db.prepare(
    "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
  ).run(symbol, `${symbol} Corp`);
  return r.lastInsertRowid as number;
}

function seedPrice(secId: number, price: number, date = "2026-04-20"): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'manual')"
  ).run(secId, date, price);
}

describe("getLevelsTriggeredInWindow", () => {
  it("returns alerts triggered within the window with enriched context", () => {
    const spy = seedSec("SPY");
    const lvlId = upsertLevel(db, {
      security_id: spy,
      level_type: "support",
      price: 580,
      source: "newsletter",
      source_author: "Eliant Capital",
      thesis: "Breakdown bearish",
    });
    triggerLevel(db, { levelId: lvlId, securityId: spy, triggeredPrice: 578 });

    const rows = getLevelsTriggeredInWindow(db, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("SPY");
    expect(rows[0].source_author).toBe("Eliant Capital");
    expect(rows[0].thesis).toBe("Breakdown bearish");
    expect(rows[0].level_price).toBe(580);
    expect(rows[0].triggered_price).toBe(578);
    expect(rows[0].user_response).toBe("pending");
  });

  it("excludes triggers older than the window", () => {
    const spy = seedSec("SPY");
    const lvlId = upsertLevel(db, { security_id: spy, level_type: "support", price: 580 });

    // Insert an alert with an old triggered_at directly
    db.prepare(
      `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price, user_response)
       VALUES (?, ?, datetime('now', '-30 days'), ?, 'pending')`
    ).run(lvlId, spy, 578);

    const rows = getLevelsTriggeredInWindow(db, 7);
    expect(rows).toHaveLength(0);
  });

  it("orders by triggered_at descending (most recent first)", () => {
    const spy = seedSec("SPY");
    const qqq = seedSec("QQQ");
    const lvl1 = upsertLevel(db, { security_id: spy, level_type: "support", price: 580 });
    const lvl2 = upsertLevel(db, { security_id: qqq, level_type: "support", price: 500 });

    // Insert out of order
    db.prepare(
      `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price, user_response)
       VALUES (?, ?, datetime('now', '-2 days'), 578, 'pending')`
    ).run(lvl1, spy);
    db.prepare(
      `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price, user_response)
       VALUES (?, ?, datetime('now'), 498, 'pending')`
    ).run(lvl2, qqq);

    const rows = getLevelsTriggeredInWindow(db, 7);
    expect(rows).toHaveLength(2);
    expect(rows[0].symbol).toBe("QQQ");  // most recent
    expect(rows[1].symbol).toBe("SPY");
  });
});

describe("getLevelsNearPrice", () => {
  it("returns active levels within the price window with distance_pct", () => {
    const spy = seedSec("SPY");
    seedPrice(spy, 583);

    upsertLevel(db, { security_id: spy, level_type: "support", price: 580, thesis: "Test" });  // 0.5% away
    upsertLevel(db, { security_id: spy, level_type: "exit", price: 620, thesis: "Far" });      // 6.4% away — OUT

    const rows = getLevelsNearPrice(db, 0.05);
    expect(rows).toHaveLength(1);
    expect(rows[0].level_price).toBe(580);
    expect(rows[0].distance_pct).toBeCloseTo((583 - 580) / 580, 4);
  });

  it("returns empty when no active levels are within the window", () => {
    const spy = seedSec("SPY");
    seedPrice(spy, 583);
    upsertLevel(db, { security_id: spy, level_type: "support", price: 500 });  // 16% away

    expect(getLevelsNearPrice(db, 0.05)).toHaveLength(0);
  });

  it("excludes inactive levels", () => {
    const spy = seedSec("SPY");
    seedPrice(spy, 583);
    const id = upsertLevel(db, { security_id: spy, level_type: "support", price: 580 });
    db.prepare("UPDATE security_levels SET is_active = 0 WHERE id = ?").run(id);

    expect(getLevelsNearPrice(db)).toHaveLength(0);
  });

  it("excludes expired levels", () => {
    const spy = seedSec("SPY");
    seedPrice(spy, 583);
    upsertLevel(db, {
      security_id: spy,
      level_type: "support",
      price: 580,
      expires_at: "2020-01-01",
    });

    expect(getLevelsNearPrice(db)).toHaveLength(0);
  });

  it("orders by absolute distance ascending (closest first)", () => {
    const spy = seedSec("SPY");
    seedPrice(spy, 583);
    upsertLevel(db, { security_id: spy, level_type: "support", price: 575 });     // 1.4%
    upsertLevel(db, { security_id: spy, level_type: "resistance", price: 585 });  // 0.3%
    upsertLevel(db, { security_id: spy, level_type: "support", price: 580 });     // 0.5%

    const rows = getLevelsNearPrice(db, 0.05);
    expect(rows).toHaveLength(3);
    expect(rows[0].level_price).toBe(585);  // closest
    expect(rows[1].level_price).toBe(580);
    expect(rows[2].level_price).toBe(575);
  });

  it("signed distance_pct: positive when price is above level, negative when below", () => {
    const spy = seedSec("SPY");
    seedPrice(spy, 583);
    upsertLevel(db, { security_id: spy, level_type: "support", price: 580 });     // price above level
    upsertLevel(db, { security_id: spy, level_type: "resistance", price: 590 });  // price below level

    const rows = getLevelsNearPrice(db, 0.05);
    const support = rows.find((r) => r.level_price === 580)!;
    const resistance = rows.find((r) => r.level_price === 590)!;
    expect(support.distance_pct).toBeGreaterThan(0);
    expect(resistance.distance_pct).toBeLessThan(0);
  });
});

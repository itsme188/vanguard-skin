/**
 * Ledger finding
 * alerts-inbox--ma-alert-card-shows-stale-creation-price-and-ai-repeats-it-regression-1.
 *
 * A moving-average level's trigger threshold is the LIVE MA the scanner
 * resolved, not the `price` snapshot frozen into security_levels when the
 * level was drawn. triggerLevel used to record only the price the security
 * traded at (`triggered_price`), so the threshold half of the event — the
 * number the alert actually fired against — was never written down and the
 * inbox fell back to the creation snapshot forever.
 *
 * These tests pin the write side of the 2026-09-14 ruling: triggerLevel takes
 * the resolved threshold and stores it, NULL stays NULL when no threshold is
 * supplied (an old-shaped call must not forge one), and the existing return
 * shape / dedupe behaviour is untouched. Synthetic symbols and figures only.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function alertRow(alertId: number): {
  triggered_price: number;
  threshold_price: number | null;
} {
  return db
    .prepare("SELECT triggered_price, threshold_price FROM level_alerts WHERE id = ?")
    .get(alertId) as { triggered_price: number; threshold_price: number | null };
}

describe("triggerLevel — fire-time threshold", () => {
  it("stores the resolved threshold alongside the traded price", () => {
    const secId = seedSecurity("QTHRESH1");
    // The stored level price is the creation snapshot; the MA had moved by the
    // time it fired, which is the whole point of recording the threshold.
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 60,
      price_source: "sma_9",
    });

    const res = triggerLevel(db, {
      levelId,
      securityId: secId,
      triggeredPrice: 99,
      thresholdPrice: 100,
    });

    expect(res.deduped).toBe(false);
    expect(res.alertId).not.toBeNull();
    const row = alertRow(res.alertId as number);
    expect(row.triggered_price).toBeCloseTo(99, 6);
    expect(row.threshold_price).toBeCloseTo(100, 6);
    // The creation snapshot is NOT what was recorded.
    expect(row.threshold_price).not.toBeCloseTo(60, 6);
  });

  it("leaves threshold_price NULL when no threshold is supplied", () => {
    const secId = seedSecurity("QTHRESH2");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "resistance",
      price: 120,
    });

    const res = triggerLevel(db, {
      levelId,
      securityId: secId,
      triggeredPrice: 121,
    });

    expect(res.deduped).toBe(false);
    expect(alertRow(res.alertId as number).threshold_price).toBeNull();
  });

  it("treats an explicit null threshold as 'not recorded', never as zero", () => {
    const secId = seedSecurity("QTHRESH3");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 30,
      price_source: "ema_9",
    });

    const res = triggerLevel(db, {
      levelId,
      securityId: secId,
      triggeredPrice: 29,
      thresholdPrice: null,
    });

    expect(alertRow(res.alertId as number).threshold_price).toBeNull();
  });

  it("keeps the level row and the dedupe guard unchanged", () => {
    const secId = seedSecurity("QTHRESH4");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 50,
      price_source: "sma_9",
    });

    const first = triggerLevel(db, {
      levelId,
      securityId: secId,
      triggeredPrice: 48,
      thresholdPrice: 49,
    });
    expect(first.deduped).toBe(false);

    const level = db
      .prepare("SELECT is_active, triggered_price FROM security_levels WHERE id = ?")
      .get(levelId) as { is_active: number; triggered_price: number | null };
    // triggered_price on the LEVEL still means "what it traded at" — only the
    // alert row gained a column.
    expect(level.is_active).toBe(0);
    expect(level.triggered_price).toBeCloseTo(48, 6);

    const second = triggerLevel(db, {
      levelId,
      securityId: secId,
      triggeredPrice: 47,
      thresholdPrice: 49,
    });
    expect(second.deduped).toBe(true);
    expect(second.alertId).toBeNull();
  });
});

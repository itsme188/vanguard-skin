/**
 * Ledger finding
 * alerts-inbox--ma-alert-card-shows-stale-creation-price-and-ai-repeats-it-regression-1
 * — scanner and AI-sentence halves.
 *
 * The scanner already resolves a moving-average level to its live value
 * (`effective_price`) before deciding whether the level was crossed; it just
 * threw that number away. So the alert said "support @ <creation snapshot>"
 * and the one-sentence Claude suggestion repeated the same wrong figure,
 * which is the part that actually misleads — prose outlives the card.
 *
 * Pinned here:
 *   1. detectAndFireAlerts hands triggerLevel the resolved effective price, so
 *      every alert fired from now on records the threshold it fired against.
 *   2. The suggestion context is composed against that recorded threshold, and
 *      for a pre-093 alert against the live resolver — never against
 *      security_levels.price.
 *
 * Existing stored sentences are NOT repaired (ruling: they age out).
 * Synthetic symbols and figures only.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { detectAndFireAlerts } from "@/lib/alerts/detect";
import { buildSuggestionContext } from "@/lib/alerts/generate-suggestion";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";

vi.mock("@/lib/alerts/notify-pushover", () => ({
  sendLevelAlertPush: vi.fn(async () => ({ ok: false, reason: "test" })),
}));

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

function seedPriceToday(securityId: number, price: number): void {
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source)
     VALUES (?, date('now'), ?, 'manual')`,
  ).run(securityId, price);
}

/** `count` consecutive daily bars ending today, every close at `close`. */
function seedDailyBars(securityId: number, count: number, close: number): void {
  const stmt = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, date('now', '-' || ? || ' days'), '1 day', ?, ?, ?, ?, 1000)`,
  );
  for (let i = 0; i < count; i++) {
    stmt.run(securityId, count - 1 - i, close, close + 1, close - 1, close);
  }
}

describe("detectAndFireAlerts — records the threshold it fired against", () => {
  it("stores the live MA, not the level's creation snapshot", () => {
    const secId = seedSecurity("QFIRE1");
    seedDailyBars(secId, 20, 100); // flat series ⇒ sma_9 is exactly 100
    seedPriceToday(secId, 99); // below the MA ⇒ a support crosses
    upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 60, // the snapshot taken when the level was drawn
      price_source: "sma_9",
    });

    const result = detectAndFireAlerts(db);
    expect(result.fired).toBe(1);

    const alert = db
      .prepare("SELECT triggered_price, threshold_price FROM level_alerts")
      .get() as { triggered_price: number; threshold_price: number | null };
    expect(alert.triggered_price).toBeCloseTo(99, 6);
    expect(alert.threshold_price).toBeCloseTo(100, 6);
  });

  it("records a static level's own price as the threshold", () => {
    const secId = seedSecurity("QFIRE2");
    seedPriceToday(secId, 99);
    upsertLevel(db, { security_id: secId, level_type: "support", price: 100 });

    expect(detectAndFireAlerts(db).fired).toBe(1);
    const alert = db
      .prepare("SELECT threshold_price FROM level_alerts")
      .get() as { threshold_price: number | null };
    expect(alert.threshold_price).toBeCloseTo(100, 6);
  });
});

describe("buildSuggestionContext — the AI sentence quotes the real threshold", () => {
  it("uses the recorded fire-time threshold when there is one", () => {
    const secId = seedSecurity("QSUGG1");
    seedDailyBars(secId, 20, 100);
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 60,
      price_source: "sma_9",
    });
    const { alertId } = triggerLevel(db, {
      levelId,
      securityId: secId,
      triggeredPrice: 99,
      thresholdPrice: 97.5,
    });

    const ctx = buildSuggestionContext(db, alertId as number);
    expect(ctx).not.toBeNull();
    expect(ctx?.levelPrice).toBeCloseTo(97.5, 6);
    expect(ctx?.triggeredPrice).toBeCloseTo(99, 6);
    expect(ctx?.levelPriceSource).toBe("sma_9");
  });

  it("falls back to the live MA for a pre-093 alert, never to the creation snapshot", () => {
    const secId = seedSecurity("QSUGG2");
    seedDailyBars(secId, 20, 100);
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 60,
      price_source: "sma_9",
    });
    const { alertId } = triggerLevel(db, {
      levelId,
      securityId: secId,
      triggeredPrice: 99,
    });

    const ctx = buildSuggestionContext(db, alertId as number);
    expect(ctx?.levelPrice).toBeCloseTo(100, 6);
  });

  it("uses the stored price only when nothing better exists (static level, or an MA with no history)", () => {
    const staticSec = seedSecurity("QSUGG3");
    const staticLevel = upsertLevel(db, {
      security_id: staticSec,
      level_type: "resistance",
      price: 120,
    });
    const staticAlert = triggerLevel(db, {
      levelId: staticLevel,
      securityId: staticSec,
      triggeredPrice: 121,
    });
    expect(buildSuggestionContext(db, staticAlert.alertId as number)?.levelPrice).toBeCloseTo(
      120,
      6,
    );

    const maSec = seedSecurity("QSUGG4");
    seedDailyBars(maSec, 3, 100); // fewer bars than the period ⇒ unresolvable
    const maLevel = upsertLevel(db, {
      security_id: maSec,
      level_type: "support",
      price: 60,
      price_source: "sma_9",
    });
    const maAlert = triggerLevel(db, {
      levelId: maLevel,
      securityId: maSec,
      triggeredPrice: 59,
    });
    expect(buildSuggestionContext(db, maAlert.alertId as number)?.levelPrice).toBeCloseTo(60, 6);
  });

  it("returns null for an alert id that does not exist", () => {
    expect(buildSuggestionContext(db, 999999)).toBeNull();
  });
});

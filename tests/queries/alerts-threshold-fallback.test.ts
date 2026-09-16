/**
 * Ledger finding
 * alerts-inbox--ma-alert-card-shows-stale-creation-price-and-ai-repeats-it-regression-1
 * — read side.
 *
 * The alerts inbox renders a threshold next to every fired alert. Pre-fix that
 * number came straight off `security_levels.price`, the snapshot taken when
 * the level was drawn, so a moving-average alert claimed to have fired at a
 * level that was never the live MA.
 *
 * The 2026-09-14 ruling gives the read side a fallback chain:
 *
 *     alert.threshold_price ?? level.effective_price ?? level.price
 *
 * `threshold_price` is the value recorded at fire time (alerts fired from 093
 * onward). `effective_price` is the SAME live resolver the scanner and the
 * Armed view use (resolveLevelPrice — never a second copy of the MA math), so
 * an old row shows today's MA rather than a stale snapshot, and the card
 * captions it as the live value. Synthetic symbols and figures only.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getEnrichedAlerts } from "@/lib/queries/security-levels";
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

describe("getEnrichedAlerts — threshold fallback chain", () => {
  it("returns the fire-time threshold verbatim when one was recorded", () => {
    const secId = seedSecurity("QINBOX1");
    seedDailyBars(secId, 20, 100);
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 60, // stale creation snapshot
      price_source: "sma_9",
    });
    triggerLevel(db, {
      levelId,
      securityId: secId,
      triggeredPrice: 99,
      thresholdPrice: 97.5,
    });

    const [row] = getEnrichedAlerts(db);
    expect(row.threshold_price).toBeCloseTo(97.5, 6);
    expect(row.symbol).toBe("QINBOX1");
    expect(row.level?.price).toBeCloseTo(60, 6);
  });

  it("exposes the live effective_price so an old NULL row has something honest to fall back to", () => {
    const secId = seedSecurity("QINBOX2");
    seedDailyBars(secId, 20, 100);
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 60,
      price_source: "sma_9",
    });
    // An alert fired before 093: no threshold recorded.
    triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 99 });

    const [row] = getEnrichedAlerts(db);
    expect(row.threshold_price).toBeNull();
    expect(row.level?.price_source).toBe("sma_9");
    // The live sma_9 over a flat series at 100 is exactly 100 — the resolver's
    // answer, not the 60 frozen on the level row.
    expect(row.level?.effective_price).toBeCloseTo(100, 6);
  });

  it("reports effective_price null when an MA cannot be resolved (never a stale stand-in)", () => {
    const secId = seedSecurity("QINBOX3");
    seedDailyBars(secId, 3, 100); // fewer bars than the period
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 60,
      price_source: "sma_9",
    });
    triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 99 });

    const [row] = getEnrichedAlerts(db);
    expect(row.threshold_price).toBeNull();
    expect(row.level?.effective_price).toBeNull();
    // The card's last resort — disclosed as such, never presented as the
    // number the alert fired against.
    expect(row.level?.price).toBeCloseTo(60, 6);
  });

  it("gives a static level an effective_price equal to its stored price", () => {
    const secId = seedSecurity("QINBOX4");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "resistance",
      price: 120,
    });
    triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 121 });

    const [row] = getEnrichedAlerts(db);
    expect(row.level?.price_source).toBe("static");
    expect(row.level?.effective_price).toBeCloseTo(120, 6);
  });

  it("keeps the enrichment the inbox already relied on (symbol, name, level metadata, filters)", () => {
    const secId = seedSecurity("QINBOX5");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "entry",
      price: 25,
      source_author: "Synthetic Author",
      thesis: "synthetic thesis",
      direction: "bullish",
    });
    triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 24 });

    const other = seedSecurity("QINBOX6");
    const otherLevel = upsertLevel(db, {
      security_id: other,
      level_type: "entry",
      price: 10,
    });
    triggerLevel(db, { levelId: otherLevel, securityId: other, triggeredPrice: 9 });

    const scoped = getEnrichedAlerts(db, { securityId: secId });
    expect(scoped).toHaveLength(1);
    const row = scoped[0];
    expect(row.symbol).toBe("QINBOX5");
    expect(row.security_name).toBe("QINBOX5 Corp");
    expect(row.level?.level_type).toBe("entry");
    expect(row.level?.source_author).toBe("Synthetic Author");
    expect(row.level?.thesis).toBe("synthetic thesis");
    expect(row.level?.direction).toBe("bullish");
    expect(row.level?.source).toBe("user");

    expect(getEnrichedAlerts(db)).toHaveLength(2);
    expect(getEnrichedAlerts(db, { response: "acted" })).toHaveLength(0);
  });

  it("returns level null when the level row is gone, without throwing", () => {
    const secId = seedSecurity("QINBOX7");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "support",
      price: 15,
    });
    triggerLevel(db, { levelId, securityId: secId, triggeredPrice: 14 });
    // level_alerts.level_id has ON DELETE CASCADE, so the row can only be
    // orphaned with the constraint off — the point is just that a missing
    // level is tolerated by the enricher rather than throwing.
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE level_alerts SET level_id = 99999").run();
    db.pragma("foreign_keys = ON");

    const [row] = getEnrichedAlerts(db);
    expect(row.level).toBeNull();
    expect(row.threshold_price).toBeNull();
  });
});

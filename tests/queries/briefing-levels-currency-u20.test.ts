/**
 * U20 — level prices are stored in the security's NATIVE currency. The two
 * briefing-level reads must carry the currency so a composer can label the
 * figure, and the distance must stay native-vs-native (no conversion on
 * either side). Synthetic security and invented round numbers only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";
import { getLevelsNearPrice, getLevelsTriggeredInWindow } from "@/lib/queries/briefing-levels";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSec(symbol: string, currency?: string): number {
  const id = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  if (currency) db.prepare("UPDATE securities SET currency = ? WHERE id = ?").run(currency, id);
  return id;
}

function seedPrice(secId: number, price: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-04-20', ?, 'manual')"
  ).run(secId, price);
}

describe("briefing-level reads carry the security's currency", () => {
  it("getLevelsNearPrice returns the native currency and a native-vs-native distance", () => {
    const zzz = seedSec("ZZZ", "JPY");
    // An FX rate on file must not leak into either side of the comparison.
    db.prepare(
      "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('JPY', 0.01, '2026-04-20', 'ibkr_ledger')"
    ).run();
    seedPrice(zzz, 1530);
    upsertLevel(db, { security_id: zzz, level_type: "support", price: 1500, source: "user" });

    const rows = getLevelsNearPrice(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].currency).toBe("JPY");
    expect(rows[0].level_price).toBe(1500);
    expect(rows[0].current_price).toBe(1530);
    expect(rows[0].distance_pct).toBeCloseTo(0.02, 10);
  });

  it("getLevelsNearPrice reports USD for a US security", () => {
    const aaa = seedSec("AAA");
    seedPrice(aaa, 102);
    upsertLevel(db, { security_id: aaa, level_type: "support", price: 100, source: "user" });
    expect(getLevelsNearPrice(db)[0].currency).toBe("USD");
  });

  it("getLevelsTriggeredInWindow returns the native currency", () => {
    const zzz = seedSec("ZZZ", "JPY");
    const lvl = upsertLevel(db, { security_id: zzz, level_type: "support", price: 1500, source: "user" });
    triggerLevel(db, { levelId: lvl, securityId: zzz, triggeredPrice: 1490 });

    const rows = getLevelsTriggeredInWindow(db, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0].currency).toBe("JPY");
    expect(rows[0].level_price).toBe(1500);
    expect(rows[0].triggered_price).toBe(1490);
  });
});

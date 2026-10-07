import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findCrossedLevels } from "@/lib/queries/security-levels";
import { reactivateLevel, triggerLevel, upsertLevel } from "@/lib/mutations/security-levels";
import { isLevelCrossed } from "../../workers/cron/src/level-scan";

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

function seedPrice(securityId: number, price: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2099-01-02', ?, 'manual')"
  ).run(securityId, price);
}

describe("Mac scanner and Worker mirror agree for re-armed last-fired levels", () => {
  it("treats last-fired fields as history, not as a scanner block", () => {
    const secId = seedSecurity("ZZG2P");
    const levelId = upsertLevel(db, {
      security_id: secId,
      level_type: "resistance",
      price: 100,
      price_source: "static",
    });
    seedPrice(secId, 120);
    triggerLevel(db, {
      levelId,
      securityId: secId,
      triggeredPrice: 110,
      triggeredAt: "2099-01-01T15:00:00.000Z",
    });
    reactivateLevel(db, levelId, { force: true });

    const macCrossed = findCrossedLevels(db).some((level) => level.id === levelId);
    const workerCrossed = isLevelCrossed(
      { level_type: "resistance", price: 100 },
      120
    );

    expect(macCrossed).toBe(true);
    expect(workerCrossed).toBe(true);
  });
});

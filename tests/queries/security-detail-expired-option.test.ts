import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getHoldingsBySecurity } from "@/lib/queries/security-detail";

/**
 * The Security Detail POSITIONS read must drop an option past its
 * expiration on the ET calendar, the same cutoff the Today IBKR line and
 * the Accounts holdings tables apply via liveOptionExpirationSql
 * (qa: security-detail-positions--expired-option-listed-as-live-position-with-value).
 * The purge keeps a 1-day grace before deleting the holdings row, so a
 * contract that expired yesterday can still be in the table at read time.
 *
 * Dates are far past / far future so the fixture never goes stale against
 * the wall clock.
 */
const VANGUARD = 1; // seeded by migration 002

function seedOption(db: Database.Database, symbol: string, expiration: string | null): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date) VALUES (?, ?, 'Option', 100, ?)"
    )
    .run(symbol, `${symbol} option`, expiration);
  return result.lastInsertRowid as number;
}

function seedHolding(db: Database.Database, securityId: number, quantity: number, sourceKey: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(VANGUARD, securityId, quantity, 500, "2026-01-02", sourceKey);
}

describe("getHoldingsBySecurity drops expired options", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns no position for an option whose expiration is in the past", () => {
    const expired = seedOption(db, "XYZ   200117P00050000", "2000-01-17");
    seedHolding(db, expired, 2, "tws-expired");
    expect(getHoldingsBySecurity(db, expired)).toEqual([]);
  });

  it("still returns a position for an option expiring in the future", () => {
    const live = seedOption(db, "XYZ   991217C00050000", "2999-12-17");
    seedHolding(db, live, 2, "tws-live");
    const rows = getHoldingsBySecurity(db, live);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(2);
  });

  it("still returns a position for a security with no expiration date", () => {
    const stock = seedOption(db, "XYZ", null);
    db.prepare("UPDATE securities SET security_type = 'Stock', multiplier = 1 WHERE id = ?").run(stock);
    seedHolding(db, stock, 10, "tws-stock");
    expect(getHoldingsBySecurity(db, stock)).toHaveLength(1);
  });
});

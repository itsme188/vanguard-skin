import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getHoldingsBySecurity } from "@/lib/queries/security-detail";
import { anchorIndex } from "@/tests/helpers/source-anchor";

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

  describe("ET-calendar boundary", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("an option expiring on ET today stays live, even after UTC midnight", () => {
      const sameDay = seedOption(db, "XYZ   310620C00050000", "2031-06-20");
      seedHolding(db, sameDay, 3, "tws-same-day");
      vi.useFakeTimers({ toFake: ["Date"] });
      // 02:30 UTC on 06-21 = 22:30 EDT on 06-20 — UTC date('now') would
      // already say 06-21 and wrongly expire the contract.
      vi.setSystemTime(new Date("2031-06-21T02:30:00Z"));
      const rows = getHoldingsBySecurity(db, sameDay);
      expect(rows).toHaveLength(1);
      expect(rows[0].quantity).toBe(3);
    });

    it("the same option drops out once the ET calendar rolls past expiration", () => {
      const sameDay = seedOption(db, "XYZ   310620C00050000", "2031-06-20");
      seedHolding(db, sameDay, 3, "tws-same-day");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2031-06-21T16:00:00Z")); // 12:00 EDT on 06-21
      expect(getHoldingsBySecurity(db, sameDay)).toEqual([]);
    });
  });

  it("still returns a position for a security with no expiration date", () => {
    const stock = seedOption(db, "XYZ", null);
    db.prepare("UPDATE securities SET security_type = 'Stock', multiplier = 1 WHERE id = ?").run(stock);
    seedHolding(db, stock, 10, "tws-stock");
    expect(getHoldingsBySecurity(db, stock)).toHaveLength(1);
  });
});

/**
 * The hub's "Related Options" section (a stock's page listing option
 * positions on it) is an inline query in the page server component, so this
 * pins its source: it must apply the same liveOptionExpirationSql guard, or
 * an option that expired yesterday lists beside the live ones.
 * (No DOM test harness here — source-pin, then browser proof.)
 */
describe("Security hub Related Options query applies the expiry guard", () => {
  it("the related-options SQL includes liveOptionExpirationSql", () => {
    const src = readFileSync(
      path.join(process.cwd(), "app/dashboard/security/[id]/page.tsx"),
      "utf8"
    );
    const start = anchorIndex(src, "const relatedOptions = db");
    expect(start).toBeGreaterThan(-1);
    const end = anchorIndex(src, ".all(security.symbol)", start);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).toMatch(/\$\{liveOptionExpirationSql\("s"\)\}/);
  });
});

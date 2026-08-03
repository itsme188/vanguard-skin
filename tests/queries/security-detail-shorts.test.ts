import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getHoldingsBySecurity } from "@/lib/queries/security-detail";

/**
 * Security Detail POSITIONS must surface SHORT positions — "held" means ANY
 * exposure (quantity != 0), the same narrowing class the B7 fix closed for
 * earnings gates and 1c23211 closed for the Analysis allocation universe.
 * Pre-fix the query passed includeShorts: false, so a pure short rendered no
 * POSITIONS section at all and a long+short pair showed only the long
 * (qa: security-detail-positions--shorts-invisible-includeshorts-false).
 */
function seedSecurity(db: Database.Database, symbol: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name) VALUES (?, ?)")
    .run(symbol, `${symbol} Corp`);
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  costBasis: number | null,
  sourceKey: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, costBasis, asOfDate, sourceKey);
}

function seedPrice(
  db: Database.Database,
  securityId: number,
  date: string,
  closePrice: number
): void {
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`
  ).run(securityId, date, closePrice);
}

describe("getHoldingsBySecurity includes shorts", () => {
  let db: Database.Database;
  const VANGUARD = 1; // seeded by migration 002
  const ROTH = 2;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns a pure short position (negative quantity)", () => {
    const gme = seedSecurity(db, "GME");
    seedHolding(db, VANGUARD, gme, -300, "2026-07-10", null, "tws-GME-2026-07-10");
    seedPrice(db, gme, "2026-07-10", 25);

    const rows = getHoldingsBySecurity(db, gme);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(-300);
    // Negative market value — a short is negative exposure, not a phantom.
    expect(rows[0].current_value).toBe(-300 * 25);
  });

  it("returns BOTH legs of a long+short pair across accounts", () => {
    const gme = seedSecurity(db, "GME");
    seedHolding(db, VANGUARD, gme, 100, "2026-07-10", 2000, "tws-GME-v-2026-07-10");
    seedHolding(db, ROTH, gme, -50, "2026-07-10", null, "tws-GME-r-2026-07-10");
    seedPrice(db, gme, "2026-07-10", 25);

    const rows = getHoldingsBySecurity(db, gme);
    expect(rows).toHaveLength(2);
    const quantities = rows.map((r) => r.quantity).sort((a, b) => a - b);
    expect(quantities).toEqual([-50, 100]);
  });

  it("still excludes closed (quantity 0) tombstone rows", () => {
    const gme = seedSecurity(db, "GME");
    seedHolding(db, VANGUARD, gme, 0, "2026-07-10", null, "canonical:hold:GME:2026-07-10");
    seedPrice(db, gme, "2026-07-10", 25);

    expect(getHoldingsBySecurity(db, gme)).toHaveLength(0);
  });
});

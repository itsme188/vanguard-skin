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

  it("scales a stale statement basis per-share for a short whose size changed", () => {
    // PAYC shape (qa:security-detail-positions--short-stale-cost-basis-fallback-impossible-loss):
    // statement row -80 sh with basis stored +10,282.15; current Plaid row
    // -50 sh, basis NULL. The fallback must serve per-share basis x current
    // quantity, signed like the position (short proceeds are negative), never
    // the -80-row's whole basis — which rendered a -170% "loss" 2.4x the
    // position's entire notional.
    const payc = seedSecurity(db, "PAYC");
    seedHolding(db, VANGUARD, payc, -80, "2026-06-30", 10282.15, "canonical:hold:PAYC:2026-06-30");
    seedHolding(db, VANGUARD, payc, -50, "2026-08-03", null, "plaid:1:PAYC:2026-08-03");
    seedPrice(db, payc, "2026-08-03", 144);

    const rows = getHoldingsBySecurity(db, payc);
    expect(rows).toHaveLength(1);
    const perShare = 10282.15 / 80; // 128.53
    expect(rows[0].cost_basis).toBeCloseTo(-perShare * 50, 2); // ~ -6,426.34
    // Loss = liability grew from ~128.53/sh to 144/sh on 50 shares.
    expect(rows[0].unrealized_gain).toBeCloseTo(-50 * 144 - -(perShare * 50), 2); // ~ -773.66
  });

  it("still excludes closed (quantity 0) tombstone rows", () => {
    const gme = seedSecurity(db, "GME");
    seedHolding(db, VANGUARD, gme, 0, "2026-07-10", null, "canonical:hold:GME:2026-07-10");
    seedPrice(db, gme, "2026-07-10", 25);

    expect(getHoldingsBySecurity(db, gme)).toHaveLength(0);
  });
});

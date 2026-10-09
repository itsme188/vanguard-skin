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
    const zza = seedSecurity(db, "ZZA");
    seedHolding(db, VANGUARD, zza, -200, "2026-07-10", null, "tws-ZZA-2026-07-10");
    seedPrice(db, zza, "2026-07-10", 25);

    const rows = getHoldingsBySecurity(db, zza);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(-200);
    // Negative market value — a short is negative exposure, not a phantom.
    expect(rows[0].current_value).toBe(-200 * 25); // -5,000
  });

  it("returns BOTH legs of a long+short pair across accounts", () => {
    const zza = seedSecurity(db, "ZZA");
    seedHolding(db, VANGUARD, zza, 100, "2026-07-10", 2000, "tws-ZZA-v-2026-07-10");
    seedHolding(db, ROTH, zza, -40, "2026-07-10", null, "tws-ZZA-r-2026-07-10");
    seedPrice(db, zza, "2026-07-10", 25);

    const rows = getHoldingsBySecurity(db, zza);
    expect(rows).toHaveLength(2);
    const quantities = rows.map((r) => r.quantity).sort((a, b) => a - b);
    expect(quantities).toEqual([-40, 100]);
  });

  it("scales a stale statement basis per-share for a short whose size changed", () => {
    // Stale-statement short shape (qa:security-detail-positions--short-stale-cost-basis-fallback-impossible-loss),
    // synthetic figures: statement row -60 sh with basis stored +7,500;
    // current Plaid row -40 sh, basis NULL. The fallback must serve per-share
    // basis x current quantity, signed like the position (short proceeds are
    // negative), never the -60-row's whole basis, which would render a
    // "loss" larger than the position's entire notional.
    const zzb = seedSecurity(db, "ZZB");
    seedHolding(db, VANGUARD, zzb, -60, "2026-06-30", 7500, "canonical:hold:ZZB:2026-06-30");
    seedHolding(db, VANGUARD, zzb, -40, "2026-08-03", null, "plaid:1:ZZB:2026-08-03");
    seedPrice(db, zzb, "2026-08-03", 140);

    const rows = getHoldingsBySecurity(db, zzb);
    expect(rows).toHaveLength(1);
    const perShare = 7500 / 60; // 125
    expect(rows[0].cost_basis).toBeCloseTo(-perShare * 40, 2); // -125 x 40 = -5,000
    expect(rows[0].cost_basis).toBeCloseTo(-5000, 2);
    // Loss = liability grew from 125/sh to 140/sh on 40 shares:
    // -40 x 140 - (-5,000) = -5,600 + 5,000 = -600.
    expect(rows[0].unrealized_gain).toBeCloseTo(-40 * 140 - -(perShare * 40), 2);
    expect(rows[0].unrealized_gain).toBeCloseTo(-600, 2);
  });

  it("resolves to NULL when a short's only known-basis sibling is a LONG row (sign flip)", () => {
    // qa:security-detail-positions--short-stale-cost-basis-fallback-impossible-loss-regression-1
    // A live -10 share row with no basis of its own must never borrow a
    // +10-share LONG row's basis — negating a long's purchase cost and
    // presenting it as the short's proceeds fabricates a loss with no
    // short-sale anywhere in the ledger. Unknown basis, not a fabricated one.
    const symbol = "SFLIP";
    const security = seedSecurity(db, symbol);
    seedHolding(db, VANGUARD, security, 10, "2026-06-30", 1000, "canonical:hold:SFLIP:2026-06-30");
    seedHolding(db, VANGUARD, security, -10, "2026-08-03", null, "plaid:1:SFLIP:2026-08-03");
    seedPrice(db, security, "2026-08-03", 50);

    const rows = getHoldingsBySecurity(db, security);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(-10);
    expect(rows[0].cost_basis).toBeNull();
    expect(rows[0].unrealized_gain).toBeNull();
    expect(rows[0].current_value).toBe(-500);
  });

  it("skips a newer opposite-sign row and rescues from the latest SAME-SIGN row instead", () => {
    // A short-sale statement row further back in time is still the right
    // rescue source even when a newer (but opposite-sign) row sits between
    // it and the live row — ranking is by as_of_date WITHIN the matching
    // sign, not by as_of_date overall.
    // Deliberately chosen so the buggy (sign-blind, latest-by-date) answer
    // and the fixed (sign-matched) answer are numerically DIFFERENT — a
    // coincidental match would let this test pass without the fix.
    const symbol = "SSIGN";
    const security = seedSecurity(db, symbol);
    seedHolding(db, VANGUARD, security, -20, "2026-05-31", -3000, "canonical:hold:SSIGN:2026-05-31");
    seedHolding(db, VANGUARD, security, 5, "2026-06-15", 500, "canonical:hold:SSIGN:2026-06-15");
    seedHolding(db, VANGUARD, security, -10, "2026-08-03", null, "plaid:1:SSIGN:2026-08-03");
    seedPrice(db, security, "2026-08-03", 50);

    const rows = getHoldingsBySecurity(db, security);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(-10);
    // Sign-matched scale off the -20/-3000 row: -1 * 3000 * 10/20 = -1500.
    // (The buggy sign-blind fallback would instead pick the newer +5/500 row
    // and yield -1000 — a different number, so this test actually pins the
    // fix rather than passing by coincidence.)
    expect(rows[0].cost_basis).toBeCloseTo(-1500, 6);
    expect(rows[0].unrealized_gain).toBeCloseTo(-10 * 50 - -1500, 6);
  });

  it("long->long rescale is unaffected by the sign-match filter", () => {
    const symbol = "SLONG";
    const security = seedSecurity(db, symbol);
    seedHolding(db, VANGUARD, security, 100, "2026-06-30", 1000, "canonical:hold:SLONG:2026-06-30");
    seedHolding(db, VANGUARD, security, 105, "2026-08-03", null, "plaid:1:SLONG:2026-08-03");
    seedPrice(db, security, "2026-08-03", 20);

    const rows = getHoldingsBySecurity(db, security);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_basis).toBeCloseTo(1050, 6);
    expect(rows[0].unrealized_gain).toBeCloseTo(105 * 20 - 1050, 6);
  });

  it("still excludes closed (quantity 0) tombstone rows", () => {
    const zza = seedSecurity(db, "ZZA");
    seedHolding(db, VANGUARD, zza, 0, "2026-07-10", null, "canonical:hold:ZZA:2026-07-10");
    seedPrice(db, zza, "2026-07-10", 25);

    expect(getHoldingsBySecurity(db, zza)).toHaveLength(0);
  });
});

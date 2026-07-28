import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getHoldingsBySecurity, getSecurityDetail } from "@/lib/queries/security-detail";

/**
 * Security Detail sibling of the F1 Plaid-NULL cost-basis fallback
 * (tests/queries/holdings-cost-basis-fallback.test.ts): getHoldingsBySecurity
 * read raw h.cost_basis, so after the first Plaid sync every Vanguard position
 * row rendered "-" while Open Tax Lots directly below showed the real basis —
 * and the TOTAL row summed the NULLs as $0 cost basis with a green $0 gain
 * (qa: security-detail-positions--total-renders-zero-cost-basis-for-unknowns).
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

describe("getHoldingsBySecurity cost_basis fallback", () => {
  let db: Database.Database;
  const VANGUARD = 1; // seeded by migration 002
  const ROTH = 2;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("falls back to the latest non-null statement cost_basis when the latest (Plaid) row has NULL", () => {
    const intc = seedSecurity(db, "INTC");
    seedHolding(db, VANGUARD, intc, 100, "2026-06-30", 2000, "canonical:hold:INTC:2026-06-30");
    seedHolding(db, VANGUARD, intc, 100, "2026-07-10", null, "plaid:hold:INTC:2026-07-10");
    seedPrice(db, intc, "2026-07-10", 25);

    const rows = getHoldingsBySecurity(db, intc);
    expect(rows).toHaveLength(1);
    // Latest row wins for quantity/as_of_date...
    expect(rows[0].as_of_date).toBe("2026-07-10");
    // ...but cost_basis falls back to the last known non-null value,
    // and unrealized gain computes off the fallback.
    expect(rows[0].cost_basis).toBe(2000);
    expect(rows[0].unrealized_gain).toBe(100 * 25 - 2000);
  });

  it("returns null cost_basis when no prior row has one (never fabricates)", () => {
    const intc = seedSecurity(db, "INTC");
    seedHolding(db, VANGUARD, intc, 100, "2026-07-10", null, "plaid:hold:INTC:2026-07-10");
    seedPrice(db, intc, "2026-07-10", 25);

    const rows = getHoldingsBySecurity(db, intc);
    expect(rows[0].cost_basis).toBeNull();
    expect(rows[0].unrealized_gain).toBeNull();
  });

  it("getSecurityDetail totals are null (not $0) when every constituent cost basis is unknown", () => {
    const intc = seedSecurity(db, "INTC");
    seedHolding(db, VANGUARD, intc, 100, "2026-07-10", null, "plaid:hold:INTC:v:2026-07-10");
    seedHolding(db, ROTH, intc, 50, "2026-07-10", null, "plaid:hold:INTC:r:2026-07-10");
    seedPrice(db, intc, "2026-07-10", 25);

    const detail = getSecurityDetail(db, intc);
    expect(detail).toBeTruthy();
    // A $3,750 position that "cost $0" is a lie — unknown basis stays unknown.
    expect(detail!.totalCostBasis).toBeNull();
    expect(detail!.totalUnrealizedGain).toBeNull();
    // Market value is real regardless of basis.
    expect(detail!.totalValue).toBe(150 * 25);
  });

  it("getSecurityDetail totals sum only the known constituents when some bases are unknown", () => {
    const intc = seedSecurity(db, "INTC");
    seedHolding(db, VANGUARD, intc, 100, "2026-07-10", 2000, "canonical:hold:INTC:v:2026-07-10");
    seedHolding(db, ROTH, intc, 50, "2026-07-10", null, "plaid:hold:INTC:r:2026-07-10");
    seedPrice(db, intc, "2026-07-10", 25);

    const detail = getSecurityDetail(db, intc);
    expect(detail!.totalCostBasis).toBe(2000);
    expect(detail!.totalUnrealizedGain).toBe(100 * 25 - 2000);
  });
});

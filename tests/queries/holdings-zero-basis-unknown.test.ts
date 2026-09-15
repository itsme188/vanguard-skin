import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllHoldings } from "@/lib/queries/holdings";

/**
 * Source pin for the query-side half of the contract that
 * AllHoldingsTable.tsx reads: a stored cost_basis of exactly 0 is
 * "unknown," not "free." The convention lives in lib/queries/holdings.ts
 * (NULLIF(costBasisExpr, 0) IS NOT NULL on unrealized_gain) and is mirrored
 * by hasKnownBasis in AllHoldingsTable.tsx.
 *
 * Since 2026-09-15 the rule also reaches the basis EXPRESSION itself
 * (scaledCostBasisFallbackSQL, lib/valuation.ts): a stored 0 falls through
 * to the same statement-row rescue a NULL gets, and when no known basis
 * exists anywhere the column resolves to NULL rather than to a fabricated
 * "$0.00 cost." So the row this component receives carries cost_basis ===
 * null (not 0) and unrealized_gain === null. Both read as unknown at the
 * render layer; the component's !== 0 guard stays as defence in depth.
 *
 * QA findings this contract prevents from recurring:
 * accounts-holdings--zero-cost-basis-known-in-cost-unknown-in-gain-regression-1
 * accounts-holdings-footer--asserts-zero-gain-unknown-costs-total-mismatch-regression-1
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
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, costBasis, asOfDate, sourceKey);
}

describe("getAllHoldings: a zero cost_basis is unknown in the Cost column and in Gain", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // Vanguard Taxable (seeded by migration 002)

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("reports an unrescuable zero basis as unknown in BOTH cost_basis and unrealized_gain", () => {
    const sym = "ZBAS";
    const security = seedSecurity(db, sym);
    seedHolding(db, ACCOUNT_ID, security, 10, "2026-06-30", 0, `canonical:hold:${sym}:2026-06-30`);
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-06-30', 50, 'tws')"
    ).run(security);

    const rows = getAllHoldings(db);
    const row = rows.find((r) => r.symbol === sym);

    expect(row).toBeTruthy();
    // No known basis anywhere for this pair: unknown, never a claimed $0 cost.
    expect(row!.cost_basis).toBeNull();
    // And the gain is unknown too: a $500 market value against an
    // unreliable zero basis is not a $500 gain.
    expect(row!.current_value).toBe(500);
    expect(row!.unrealized_gain).toBeNull();
  });
});

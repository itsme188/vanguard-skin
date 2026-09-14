import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllHoldings } from "@/lib/queries/holdings";

/**
 * Source pin for the query-side half of the contract that
 * AllHoldingsTable.tsx now reads: a stored cost_basis of exactly 0 is
 * "unknown," not "free." lib/queries/holdings.ts already enforces this via
 * NULLIF(costBasisExpr, 0) IS NOT NULL — this test pins the shape of the
 * row the component receives (cost_basis === 0, unrealized_gain === null)
 * so a future regression to either side shows up here first.
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

describe("getAllHoldings: a zero cost_basis returns cost_basis=0 and unrealized_gain=null", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // Vanguard Taxable (seeded by migration 002)

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("keeps cost_basis at its stored 0 while nulling out unrealized_gain", () => {
    const sym = "ZBAS";
    const security = seedSecurity(db, sym);
    seedHolding(db, ACCOUNT_ID, security, 10, "2026-06-30", 0, `canonical:hold:${sym}:2026-06-30`);
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-06-30', 50, 'tws')"
    ).run(security);

    const rows = getAllHoldings(db);
    const row = rows.find((r) => r.symbol === sym);

    expect(row).toBeTruthy();
    // Basis is a real stored zero, not a NULL — the component must be able
    // to tell "known zero" apart from "no data" using cost_basis alone.
    expect(row!.cost_basis).toBe(0);
    // But the gain is unknown: a $500 market value against an unreliable
    // zero basis is not a $500 gain.
    expect(row!.current_value).toBe(500);
    expect(row!.unrealized_gain).toBeNull();
  });
});

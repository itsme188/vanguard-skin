import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileCostBasis } from "@/lib/compute/cost-basis-reconciliation";

/**
 * The single-account Holdings table leaves out an option contract whose
 * expiration is before today (Eastern) through liveOptionExpirationSql. The
 * cost-basis check must leave it out the same way, or it reports one more
 * position than the table (QA finding
 * dashboard-accounts-id-3-holdings-total-vs-totals-block-...).
 *
 * Synthetic fixtures: ZZ* symbols, round figures. Expirations are far in the
 * past and far in the future so the test does not depend on today's date.
 */
let db: Database.Database;

function insertSecurity(id: number, symbol: string, type: string, expiration: string | null): void {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, expiration_date, multiplier)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, symbol, `${symbol} test`, type, expiration, type === "Option" ? 100 : 1);
}

function insertHolding(secId: number, qty: number, costBasis: number, asOf: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (3, ?, ?, ?, ?, ?)`,
  ).run(secId, qty, costBasis, asOf, `zz-${secId}-${asOf}`);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  insertSecurity(1, "ZZZ", "Stock", null);
  insertSecurity(2, "ZZZ 200117C00100000", "Option", "2020-01-17");
  insertSecurity(3, "ZZZ 991217C00100000", "Option", "2099-12-17");
  // Legacy compact spelling of a past expiration: must read as expired too.
  insertSecurity(4, "ZZY 200117P00050000", "Option", "20200117");
  insertHolding(1, 100, 10000, "2020-01-31");
  insertHolding(2, 2, 400, "2020-01-31");
  insertHolding(3, 1, 300, "2020-01-31");
  insertHolding(4, -1, -200, "2020-01-31");
});

describe("reconcileCostBasis leaves out an expired option, like the holdings table", () => {
  it("reports no row for an expired contract and keeps the live one", () => {
    const result = reconcileCostBasis(db, { accountId: 3 });
    const symbols = result.rows.map((r) => r.symbol).sort();
    expect(symbols).toEqual(["ZZZ", "ZZZ 991217C00100000"]);
    expect(result.totalPositions).toBe(2);
    expect(result.rows.some((r) => r.flagReason?.includes("Quantity mismatch") && r.securityId === 2)).toBe(false);
  });

  it("applies the same rule across every account (no account filter)", () => {
    const result = reconcileCostBasis(db);
    expect(result.rows.map((r) => r.securityId).sort()).toEqual([1, 3]);
    expect(result.totalBrokerCostBasis).toBe(10300);
  });
});

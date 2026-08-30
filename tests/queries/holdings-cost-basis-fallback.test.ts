import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllHoldings, getHoldingsByAccount } from "@/lib/queries/holdings";

/**
 * F1 (final-review): Plaid holdings rows write cost_basis NULL. Because
 * getAllHoldings/getHoldingsByAccount display the per-(account, security)
 * latest as_of_date row, the first Plaid sync makes every subsequent read
 * pick the NULL-cost-basis Plaid row over the real statement-sourced cost
 * basis — every Vanguard holding renders "-" cost basis and NULL
 * unrealized gain.
 *
 * Fix mirrors the COALESCE-to-latest-non-null-statement-row pattern from
 * getCrossAccountPositions (lib/digest/send-earnings-email.ts): quantity /
 * as_of_date still come from the latest row, but cost_basis falls back to
 * the most recent prior row (same account+security) that has one.
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

describe("holdings cost_basis fallback (F1)", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // Vanguard Taxable (seeded by migration 002)

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("getAllHoldings falls back to the latest non-null statement cost_basis when the latest (Plaid) row has NULL", () => {
    const vti = seedSecurity(db, "VTI");

    // Statement holdings row: cost_basis populated, month-end date.
    seedHolding(db, ACCOUNT_ID, vti, 100, "2026-06-30", 1000, "canonical:hold:VTI:2026-06-30");

    // Newer Plaid sync row: cost_basis NULL, today's date, different quantity.
    seedHolding(db, ACCOUNT_ID, vti, 105, "2026-07-10", null, "plaid:hold:VTI:2026-07-10");

    const rows = getAllHoldings(db);
    const row = rows.find((r) => r.symbol === "VTI");

    expect(row).toBeTruthy();
    // Latest-date row wins for quantity/as_of_date (Plaid row).
    expect(row!.quantity).toBe(105);
    expect(row!.as_of_date).toBe("2026-07-10");
    // But cost_basis falls back to the last known non-null value, scaled
    // per-share to the CURRENT quantity (105/100 x 1000) — a stale row's
    // whole basis must never serve a different share count verbatim.
    expect(row!.cost_basis).toBeCloseTo(1050, 6);
  });

  it("getHoldingsByAccount falls back to the latest non-null statement cost_basis when the latest (Plaid) row has NULL", () => {
    const vti = seedSecurity(db, "VTI");

    seedHolding(db, ACCOUNT_ID, vti, 100, "2026-06-30", 1000, "canonical:hold:VTI:2026-06-30");
    seedHolding(db, ACCOUNT_ID, vti, 105, "2026-07-10", null, "plaid:hold:VTI:2026-07-10");

    const rows = getHoldingsByAccount(db, ACCOUNT_ID);
    const row = rows.find((r) => r.symbol === "VTI");

    expect(row).toBeTruthy();
    expect(row!.quantity).toBe(105);
    expect(row!.as_of_date).toBe("2026-07-10");
    expect(row!.cost_basis).toBeCloseTo(1050, 6);
  });

  it("getAllHoldings treats a zero cost_basis as unknown — never renders market value as pure gain", () => {
    // QA 2026-08-05 (accounts-holdings--zero-cost-basis-phantom-gain): one
    // UBER statement row carried cost_basis = 0.0 (not NULL), so the IS NOT
    // NULL guard passed and unrealized_gain evaluated MV − 0 = the whole
    // market value — a +$7,300 phantom gain on a position actually at a loss.
    // A basis of 0 is "unknown", not "free": gain must suppress to NULL,
    // matching the Gain % column's existing !== 0 guard in AllHoldingsTable.
    const uber = seedSecurity(db, "UBER");
    seedHolding(db, ACCOUNT_ID, uber, 100, "2026-03-27", 0, "canonical:hold:UBER:2026-03-27");
    seedHolding(db, ACCOUNT_ID, uber, 100, "2026-07-10", null, "plaid:hold:UBER:2026-07-10");
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-07-10', 73, 'tws')"
    ).run(uber);

    const rows = getAllHoldings(db);
    const row = rows.find((r) => r.symbol === "UBER");

    expect(row).toBeTruthy();
    expect(row!.current_value).toBe(7300);
    expect(row!.unrealized_gain).toBeNull();
  });

  it("getAllHoldings returns null cost_basis when no prior row has one (never fabricates)", () => {
    const bnd = seedSecurity(db, "BND");
    seedHolding(db, ACCOUNT_ID, bnd, 50, "2026-07-10", null, "plaid:hold:BND:2026-07-10");

    const rows = getAllHoldings(db);
    const row = rows.find((r) => r.symbol === "BND");
    expect(row!.cost_basis).toBeNull();
    expect(row!.unrealized_gain).toBeNull();
  });

  it("returns a statement-only bond/fund position with its own cost_basis, even when other securities in the same account have newer Plaid rows", () => {
    // VBTLX only ever has ONE holdings row — a statement-sourced bond/mutual
    // fund position that never picked up a later Plaid/TWS row. Before the
    // per-(account, security) latestHoldingsPredicate fix (QA finding
    // accounts-holdings--global-max-as-of-date-drops-19-live-positions-72k-
    // treasuries), a naive per-account MAX(as_of_date) would have dropped
    // this row entirely — VTI's newer Plaid date would win the account-wide
    // max and VBTLX's single, older-dated row would fall out of the result
    // set. Keying "latest" per-(account, security) instead of per-account
    // means VBTLX's single row IS the latest row for its own pair, so it
    // must surface with its own statement cost_basis untouched — no
    // fallback subquery needed since the row itself is non-null.
    const vbtlx = seedSecurity(db, "VBTLX");
    seedHolding(db, ACCOUNT_ID, vbtlx, 200, "2026-06-30", 20000, "canonical:hold:VBTLX:2026-06-30");

    const vti = seedSecurity(db, "VTI");
    seedHolding(db, ACCOUNT_ID, vti, 105, "2026-07-10", null, "plaid:hold:VTI:2026-07-10");

    const allRows = getAllHoldings(db);
    const bndAll = allRows.find((r) => r.symbol === "VBTLX");
    expect(bndAll).toBeTruthy();
    expect(bndAll!.quantity).toBe(200);
    expect(bndAll!.as_of_date).toBe("2026-06-30");
    expect(bndAll!.cost_basis).toBeCloseTo(20000, 6);

    const acctRows = getHoldingsByAccount(db, ACCOUNT_ID);
    const bndAcct = acctRows.find((r) => r.symbol === "VBTLX");
    expect(bndAcct).toBeTruthy();
    expect(bndAcct!.quantity).toBe(200);
    expect(bndAcct!.as_of_date).toBe("2026-06-30");
    expect(bndAcct!.cost_basis).toBeCloseTo(20000, 6);
  });
});

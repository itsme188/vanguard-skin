import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getHoldingsInBucket } from "@/lib/queries/drill-down";

// Migration 002 seeds: 1=Vanguard Taxable, 2=Vanguard Roth IRA, 3=IBKR.

function seedPortfolio(db: Database.Database) {
  // USD control: AAPL, Technology sector.
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, currency) VALUES (1, 'AAPL', 'Apple Inc.', 'Stock', 'Technology', 'USD')`
  ).run();
  // KRW holding, same Technology sector so both land in one drill-down bucket.
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, currency) VALUES (2, '000000', 'ZZ Korea Co', 'Stock', 'Technology', 'KRW')`
  ).run();

  const today = new Date().toISOString().slice(0, 10);
  // AAPL: 10,000 sh @ $208 -> $2,080,000.
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (1, ?, 208, 'tws')`).run(today);
  // 000000: 10 sh @ ₩1,500,000 -> ₩15,000,000 notional.
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (2, ?, 1500000, 'tws')`).run(today);

  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 1, ?, 10000, 'tws-aapl')`
  ).run(today);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 2, ?, 10, 'tws-000000')`
  ).run(today);
}

describe("getHoldingsInBucket FX conversion", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedPortfolio(db);
  });

  it("KRW holding's marketValue + weight are in USD, not the won phantom", () => {
    upsertFxRate(db, {
      currency: "KRW",
      usdPerUnit: 0.000734,
      asOf: new Date().toISOString().slice(0, 10),
      source: "test",
    });

    const rows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "sector",
      bucket: "Technology",
    });

    const usdRow = rows.find((r) => r.symbol === "AAPL");
    const krwRow = rows.find((r) => r.symbol === "000000");

    expect(usdRow).toBeTruthy();
    expect(krwRow).toBeTruthy();

    // USD control unaffected.
    expect(usdRow!.marketValue).toBe(2_080_000);

    // KRW row valued in USD (₩15,000,000 * 0.000734 ≈ $11,010.00), NOT the
    // won notional ($15,000,000 if FX were never applied).
    const expectedUsdMv = 10 * 1_500_000 * 0.000734;
    expect(krwRow!.marketValue).toBeCloseTo(expectedUsdMv, 5);
    expect(krwRow!.marketValue).toBeLessThan(20_000);

    // Weight is a fraction of the scope total, which must also be in USD:
    // 11,010.00 / (2,080,000 + 11,010.00).
    const scopeTotal = 2_080_000 + expectedUsdMv;
    expect(krwRow!.weight).toBeCloseTo(expectedUsdMv / scopeTotal, 5);
  });
});

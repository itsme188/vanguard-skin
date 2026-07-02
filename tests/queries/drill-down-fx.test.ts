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
    `INSERT INTO securities (id, symbol, name, security_type, sector, currency) VALUES (2, '402340', 'SK Hynix', 'Stock', 'Technology', 'KRW')`
  ).run();

  const today = new Date().toISOString().slice(0, 10);
  // AAPL: 10,000 sh @ $208 -> $2,080,000.
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (1, ?, 208, 'tws')`).run(today);
  // 402340: 10 sh @ ₩1,731,000 -> ₩17,310,000 notional.
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (2, ?, 1731000, 'tws')`).run(today);

  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 1, ?, 10000, 'tws-aapl')`
  ).run(today);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 2, ?, 10, 'tws-402340')`
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
    const krwRow = rows.find((r) => r.symbol === "402340");

    expect(usdRow).toBeTruthy();
    expect(krwRow).toBeTruthy();

    // USD control unaffected.
    expect(usdRow!.marketValue).toBe(2_080_000);

    // KRW row valued in USD (₩17,310,000 * 0.000734 ≈ $12,705.54), NOT the
    // won notional ($17,310,000 if FX were never applied).
    const expectedUsdMv = 10 * 1_731_000 * 0.000734;
    expect(krwRow!.marketValue).toBeCloseTo(expectedUsdMv, 5);
    expect(krwRow!.marketValue).toBeLessThan(20_000);

    // Weight is a fraction of the scope total, which must also be in USD:
    // 12,705.54 / (2,080,000 + 12,705.54).
    const scopeTotal = 2_080_000 + expectedUsdMv;
    expect(krwRow!.weight).toBeCloseTo(expectedUsdMv / scopeTotal, 5);
  });
});

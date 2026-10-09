// tests/queries/analysis-sector-lookthrough-drilldown-parity.test.ts
//
// QA finding: "sector rows carry value but 0 positions and open an empty
// drill-down". A sector that exists ONLY through a fund's look-through weights
// (no directly held stock in it) must still count the fund as a position in
// the Analysis breakdown, and the drill-down for that sector must return the
// fund with its slice value, the slices summing to the row value.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllocationByDimension } from "@/lib/queries/analysis";
import { getHoldingsInBucket } from "@/lib/queries/drill-down";

let db: Database.Database;

function seedSecurity(symbol: string, type: string, sector: string | null, fundCategory: string | null): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, sector, fund_category, multiplier) VALUES (?, ?, ?, ?, ?, 1)"
    )
    .run(symbol, `${symbol} Inc`, type, sector, fundCategory).lastInsertRowid as number;
}

function hold(accountId: number, securityId: number, quantity: number, price: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, '2026-06-01', 'test:' || ?)"
  ).run(accountId, securityId, quantity, securityId);
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-06-01', 'test')"
  ).run(securityId, price);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("sector look-through: breakdown row and drill-down agree", () => {
  it("a sector held only through funds counts the funds and drills into them", () => {
    const acct = db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run().lastInsertRowid as number;
    // Two funds with weights into Financials; the only direct stock is Technology.
    const fundA = seedSecurity("ZZFA", "ETF", null, "US Equity");
    const fundB = seedSecurity("ZZFB", "ETF", null, "US Equity");
    const stock = seedSecurity("ZZS", "Stock", "Technology", null);
    hold(acct, fundA, 10, 100); // 1,000
    hold(acct, fundB, 20, 50); // 1,000
    hold(acct, stock, 5, 100); // 500
    const w = db.prepare(
      "INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES (?, ?, ?, '2026-06-01', 'manual')"
    );
    w.run("ZZFA", "Financials", 40);
    w.run("ZZFA", "Technology", 60);
    w.run("ZZFB", "Financials", 25);
    w.run("ZZFB", "Technology", 75);

    const rows = getAllocationByDimension(db, "sector");
    const fin = rows.find((r) => r.group_name === "Financials");
    expect(fin).toBeDefined();
    expect(fin!.position_count).toBeGreaterThanOrEqual(1);
    expect(fin!.total_market_value).toBeCloseTo(400 + 250);

    const drill = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "sector",
      bucket: "Financials",
    });
    expect(drill.map((d) => d.symbol).sort()).toEqual(["ZZFA", "ZZFB"]);
    expect(drill.length).toBe(fin!.position_count);
    const bySymbol = Object.fromEntries(drill.map((d) => [d.symbol, d.marketValue]));
    expect(bySymbol.ZZFA).toBeCloseTo(400);
    expect(bySymbol.ZZFB).toBeCloseTo(250);
    expect(drill.reduce((s, d) => s + d.marketValue, 0)).toBeCloseTo(fin!.total_market_value);
  });
});

// tests/queries/analysis-sector-lookthrough.test.ts
//
// Pins ETF sector look-through in getAllocationByDimension("sector"): an
// ETF/mutual fund WITH etf_sector_weights rows distributes its market value
// across sectors (same explodeHoldingBySector single source cash-deploy
// uses) instead of landing in one fund_category/Unknown bucket. Funds
// without weights and non-funds keep the old single-bucket behavior.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllocationByDimension } from "@/lib/queries/analysis";

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedSecurity(
  symbol: string,
  opts: { security_type?: string; sector?: string | null; fund_category?: string | null } = {}
): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, sector, fund_category, multiplier) VALUES (?, ?, ?, ?, ?, 1)"
    )
    .run(symbol, `${symbol} Inc`, opts.security_type ?? "Stock", opts.sector ?? null, opts.fund_category ?? null)
    .lastInsertRowid as number;
}

function seedHolding(accountId: number, securityId: number, quantity: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, '2026-06-01', 'test:' || ?)"
  ).run(accountId, securityId, quantity, securityId);
}

function seedPrice(securityId: number, price: number) {
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-06-01', 'test')"
  ).run(securityId, price);
}

function seedWeights(etf: string, weights: Array<[string, number]>) {
  const stmt = db.prepare(
    "INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES (?, ?, ?, '2026-06-01', 'manual')"
  );
  for (const [sector, pct] of weights) stmt.run(etf, sector, pct);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getAllocationByDimension('sector') ETF look-through", () => {
  it("distributes an ETF's value across sectors by weight", () => {
    const acct = seedAccount("Test");
    const etf = seedSecurity("XLK2", { security_type: "ETF", fund_category: "US Equity" });
    seedHolding(acct, etf, 10);
    seedPrice(etf, 100); // $1,000
    seedWeights("XLK2", [
      ["Technology", 60],
      ["Financials", 40],
    ]);

    const rows = getAllocationByDimension(db, "sector");
    const tech = rows.find((r) => r.group_name === "Technology");
    const fin = rows.find((r) => r.group_name === "Financials");
    expect(tech?.total_market_value).toBeCloseTo(600);
    expect(fin?.total_market_value).toBeCloseTo(400);
    // No bucket left under the fund_category fallback
    expect(rows.find((r) => r.group_name === "US Equity")).toBeUndefined();
  });

  it("keeps single-bucket behavior for funds without weights and plain stocks", () => {
    const acct = seedAccount("Test");
    const stock = seedSecurity("AAPL2", { sector: "Technology" });
    const fund = seedSecurity("MYSTERY", { security_type: "ETF", fund_category: "US Equity" });
    seedHolding(acct, stock, 5);
    seedPrice(stock, 200); // $1,000
    seedHolding(acct, fund, 10);
    seedPrice(fund, 50); // $500

    const rows = getAllocationByDimension(db, "sector");
    expect(rows.find((r) => r.group_name === "Technology")?.total_market_value).toBeCloseTo(1000);
    // Weight-less fund falls back to fund_category (pre-existing COALESCE semantics)
    expect(rows.find((r) => r.group_name === "US Equity")?.total_market_value).toBeCloseTo(500);
  });

  it("buckets sectorless bonds as Fixed Income", () => {
    const acct = seedAccount("Test");
    const bond = seedSecurity("912797XX", { security_type: "Bond" });
    seedHolding(acct, bond, 1000);
    seedPrice(bond, 99); // bond par-adjust: 1000 × 99 / 100 = $990

    const rows = getAllocationByDimension(db, "sector");
    expect(rows.find((r) => r.group_name === "Fixed Income")?.total_market_value).toBeCloseTo(990);
  });

  it("percentages still sum to ~100 with look-through applied", () => {
    const acct = seedAccount("Test");
    const etf = seedSecurity("XLK2", { security_type: "ETF" });
    const stock = seedSecurity("AAPL2", { sector: "Technology" });
    seedHolding(acct, etf, 10);
    seedPrice(etf, 100);
    seedHolding(acct, stock, 5);
    seedPrice(stock, 200);
    seedWeights("XLK2", [
      ["Technology", 50],
      ["Healthcare", 50],
    ]);

    const rows = getAllocationByDimension(db, "sector");
    const pctSum = rows.reduce((s, r) => s + (r.percentage ?? 0), 0);
    expect(pctSum).toBeCloseTo(100, 1);
    // Technology = 500 (ETF half) + 1000 (stock) = 1500 of 2000 total
    expect(rows.find((r) => r.group_name === "Technology")?.percentage).toBeCloseTo(75, 1);
  });

  it("non-sector dimensions are unaffected", () => {
    const acct = seedAccount("Test");
    const etf = seedSecurity("XLK2", { security_type: "ETF" });
    seedHolding(acct, etf, 10);
    seedPrice(etf, 100);
    seedWeights("XLK2", [["Technology", 100]]);

    const rows = getAllocationByDimension(db, "security_type");
    expect(rows.find((r) => r.group_name === "ETF")?.total_market_value).toBeCloseTo(1000);
  });
});

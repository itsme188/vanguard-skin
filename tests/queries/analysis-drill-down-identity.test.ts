import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllocationByDimension } from "@/lib/queries/analysis";
import { getHoldingsInBucket } from "@/lib/queries/drill-down";

let db: Database.Database;

function seedAccount(): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES ('Identity')").run();
  return (db.prepare("SELECT id FROM accounts WHERE name = 'Identity'").get() as { id: number }).id;
}

function seedSecurity(
  symbol: string,
  opts: {
    security_type?: string;
    sector?: string | null;
    fund_category?: string | null;
    underlying_symbol?: string | null;
    multiplier?: number;
  } = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities
        (symbol, name, security_type, sector, fund_category, underlying_symbol, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      `${symbol} Inc`,
      opts.security_type ?? "Stock",
      opts.sector ?? null,
      opts.fund_category ?? null,
      opts.underlying_symbol ?? null,
      opts.multiplier ?? 1
    ).lastInsertRowid as number;
}

function seedHolding(accountId: number, securityId: number, quantity: number, price: number) {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, '2026-06-01', ?)`
  ).run(accountId, securityId, quantity, `identity:${securityId}`);
  db.prepare(
    `INSERT INTO prices (security_id, close_price, date, source)
     VALUES (?, ?, '2026-06-01', 'test')`
  ).run(securityId, price);
}

function seedWeights(symbol: string, rows: Array<[string, number]>) {
  const stmt = db.prepare(
    `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source)
     VALUES (?, ?, ?, '2026-06-01', 'test')`
  );
  for (const [sector, pct] of rows) stmt.run(symbol, sector, pct);
}

function seedFactor(securityId: number, factor: string, source = "csv_import") {
  db.prepare(
    `INSERT INTO security_factors (security_id, ai_exposure, factor_source)
     VALUES (?, ?, ?)`
  ).run(securityId, factor, source);
}

function assertIdentity(
  breakdown: { total_market_value: number; position_count: number },
  rows: Array<{ marketValue: number }>
) {
  expect(rows).toHaveLength(breakdown.position_count);
  expect(rows.reduce((sum, r) => sum + r.marketValue, 0)).toBeCloseTo(
    breakdown.total_market_value,
    6
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("analysis drill-down identity", () => {
  it("sector, asset-class, and factor drill-down rows sum back to their breakdown row", () => {
    const account = seedAccount();
    const mix = seedSecurity("MIXETF", { security_type: "ETF", fund_category: "US Equity" });
    const short = seedSecurity("SHORTX", { security_type: "Stock", sector: "Technology" });
    const underlying = seedSecurity("UNDX", { security_type: "Stock", sector: "Technology" });
    const option = seedSecurity("UNDX  260320C00100000", {
      security_type: "Option",
      sector: "Technology",
      underlying_symbol: "UNDX",
      multiplier: 100,
    });
    const cash = seedSecurity("CASHX", {
      security_type: "Mutual Fund",
      fund_category: "Cash Equivalent",
    });

    seedHolding(account, mix, 10, 100); // 1000 split 60/40
    seedWeights("MIXETF", [
      ["Technology", 60],
      ["Financials", 40],
    ]);
    seedHolding(account, short, -5, 20); // -100 in Technology
    seedHolding(account, option, 1, 2); // 200 in Technology
    seedHolding(account, cash, 50, 1); // cash-equivalent fund, own bucket
    seedFactor(mix, "High", "csv_import");
    seedFactor(underlying, "High", "auto_underlying");

    const sectorBreakdown = getAllocationByDimension(db, "sector");
    const tech = sectorBreakdown.find((r) => r.group_name === "Technology")!;
    const financials = sectorBreakdown.find((r) => r.group_name === "Financials")!;
    const cashBucket = sectorBreakdown.find((r) => r.group_name === "Cash Equivalent")!;

    assertIdentity(
      tech,
      getHoldingsInBucket(db, "all", {
        kind: "classification",
        dimension: "sector",
        bucket: "Technology",
      })
    );
    assertIdentity(
      financials,
      getHoldingsInBucket(db, "all", {
        kind: "classification",
        dimension: "sector",
        bucket: "Financials",
      })
    );
    assertIdentity(
      cashBucket,
      getHoldingsInBucket(db, "all", {
        kind: "classification",
        dimension: "sector",
        bucket: "Cash Equivalent",
      })
    );

    const asset = getAllocationByDimension(db, "asset_class").find(
      (r) => r.group_name === "Option"
    )!;
    assertIdentity(
      asset,
      getHoldingsInBucket(db, "all", {
        kind: "classification",
        dimension: "asset_class",
        bucket: "Option",
      })
    );

    const factor = getAllocationByDimension(db, "ai_exposure").find(
      (r) => r.group_name === "High"
    )!;
    assertIdentity(
      factor,
      getHoldingsInBucket(db, "all", {
        kind: "factor",
        factor: "ai_exposure",
        bucket: "High",
      })
    );
  });
});

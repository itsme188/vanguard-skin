// tests/queries/analysis-option-lookthrough.test.ts
//
// Pins option→underlying look-through in getAllocationByDimension for the
// standard classification dimensions (fund_category, geography,
// market_cap_category, style): an option's market value is attributed to its
// UNDERLYING's classification — the same inheritance the factor dimensions
// already apply — so category exposure includes option positions instead of
// lumping 100% of them into one 'Options' bucket. Falls back to the option's
// own value when the underlying is missing/unclassified. asset_class and
// security_type dimensions intentionally keep the Options grouping.
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
  opts: {
    security_type?: string;
    fund_category?: string | null;
    geography?: string | null;
    market_cap_category?: string | null;
    style?: string | null;
    asset_class?: string | null;
    underlying_symbol?: string | null;
    multiplier?: number;
  } = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities
         (symbol, name, security_type, fund_category, geography, market_cap_category, style, asset_class, underlying_symbol, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      `${symbol} Inc`,
      opts.security_type ?? "Stock",
      opts.fund_category ?? null,
      opts.geography ?? null,
      opts.market_cap_category ?? null,
      opts.style ?? null,
      opts.asset_class ?? null,
      opts.underlying_symbol ?? null,
      opts.multiplier ?? 1
    ).lastInsertRowid as number;
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

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getAllocationByDimension option→underlying classification look-through", () => {
  it("attributes an option's value to the underlying's fund_category", () => {
    const acct = seedAccount("Test");
    const intc = seedSecurity("INTC", {
      fund_category: "US Sector Equity (Semiconductors)",
    });
    seedHolding(acct, intc, 10);
    seedPrice(intc, 100); // $1,000 stock

    const opt = seedSecurity("INTC  280121C00050000", {
      security_type: "Option",
      fund_category: "Options",
      underlying_symbol: "INTC",
      multiplier: 100,
    });
    seedHolding(acct, opt, 1);
    seedPrice(opt, 5); // 1 × 5 × 100 = $500 option

    const rows = getAllocationByDimension(db, "fund_category");
    const semis = rows.find((r) => r.group_name === "US Sector Equity (Semiconductors)");
    expect(semis?.total_market_value).toBeCloseTo(1500); // stock + option
    expect(rows.find((r) => r.group_name === "Options")).toBeUndefined();
  });

  it("falls back to the option's own fund_category when the underlying is unclassified or missing", () => {
    const acct = seedAccount("Test");
    // Underlying exists but has no fund_category
    seedSecurity("FOO", { fund_category: null });
    const opt1 = seedSecurity("FOO   280121C00010000", {
      security_type: "Option",
      fund_category: "Options",
      underlying_symbol: "FOO",
      multiplier: 100,
    });
    seedHolding(acct, opt1, 1);
    seedPrice(opt1, 2); // $200

    // No underlying row at all
    const opt2 = seedSecurity("BAR   280121C00010000", {
      security_type: "Option",
      fund_category: "Options",
      underlying_symbol: "BAR",
      multiplier: 100,
    });
    seedHolding(acct, opt2, 1);
    seedPrice(opt2, 3); // $300

    const rows = getAllocationByDimension(db, "fund_category");
    const options = rows.find((r) => r.group_name === "Options");
    expect(options?.total_market_value).toBeCloseTo(500);
  });

  it("inherits geography, market cap, and style from the underlying", () => {
    const acct = seedAccount("Test");
    seedSecurity("MSFT", {
      geography: "US",
      market_cap_category: "Large Cap",
      style: "Growth",
    });
    const opt = seedSecurity("MSFT  280121C00400000", {
      security_type: "Option",
      underlying_symbol: "MSFT",
      multiplier: 100,
    });
    seedHolding(acct, opt, 2);
    seedPrice(opt, 10); // $2,000

    const geo = getAllocationByDimension(db, "geography");
    expect(geo.find((r) => r.group_name === "US")?.total_market_value).toBeCloseTo(2000);
    expect(geo.find((r) => r.group_name === "Unknown")).toBeUndefined();

    const mcap = getAllocationByDimension(db, "market_cap_category");
    expect(mcap.find((r) => r.group_name === "Large Cap")?.total_market_value).toBeCloseTo(2000);

    const style = getAllocationByDimension(db, "style");
    expect(style.find((r) => r.group_name === "Growth")?.total_market_value).toBeCloseTo(2000);
  });

  it("keeps the Options grouping in the asset_class and security_type dimensions", () => {
    const acct = seedAccount("Test");
    seedSecurity("NVDA", { asset_class: "equity", fund_category: "US Large Cap Equity" });
    const opt = seedSecurity("NVDA  280121C00150000", {
      security_type: "Option",
      asset_class: "option",
      fund_category: "Options",
      underlying_symbol: "NVDA",
      multiplier: 100,
    });
    seedHolding(acct, opt, 1);
    seedPrice(opt, 4); // $400

    const byClass = getAllocationByDimension(db, "asset_class");
    expect(byClass.find((r) => r.group_name === "option")?.total_market_value).toBeCloseTo(400);

    const byType = getAllocationByDimension(db, "security_type");
    expect(byType.find((r) => r.group_name === "Option")?.total_market_value).toBeCloseTo(400);
  });

  it("leaves non-option securities untouched in the inherited dimensions", () => {
    const acct = seedAccount("Test");
    const aapl = seedSecurity("AAPL", { fund_category: "US Large Cap Equity", geography: "US" });
    seedHolding(acct, aapl, 5);
    seedPrice(aapl, 200); // $1,000

    const rows = getAllocationByDimension(db, "fund_category");
    expect(rows.find((r) => r.group_name === "US Large Cap Equity")?.total_market_value).toBeCloseTo(1000);
  });
});

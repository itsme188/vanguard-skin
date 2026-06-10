// tests/queries/analysis-exposure.test.ts
//
// Pins the net_exposure / exposure_pct fields on AllocationEntry: every
// allocation bucket carries delta-adjusted exposure alongside market value.
// A bucket holding stock + a long put reads LOWER exposure than MV (the put
// hedges); a bucket with a long call reads HIGHER (delta-notional ≫ premium).
// exposure_pct shares the MV denominator so the two columns are comparable.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllocationByDimension } from "@/lib/queries/analysis";

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedStock(symbol: string, fundCategory: string, sector?: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, fund_category, sector, multiplier) VALUES (?, ?, 'Stock', ?, ?, 1)"
    )
    .run(symbol, `${symbol} Inc`, fundCategory, sector ?? null).lastInsertRowid as number;
}

function seedOption(
  symbol: string,
  underlying: string,
  optionType: "CALL" | "PUT",
  strike: number,
  expiration: string,
  opts: { fund_category?: string; sector?: string } = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, fund_category, sector, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, 'Option', ?, ?, ?, ?, ?, ?, 100)`
    )
    .run(
      symbol,
      symbol,
      opts.fund_category ?? "Options",
      opts.sector ?? null,
      underlying,
      optionType,
      strike,
      expiration
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

function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("AllocationEntry delta-adjusted exposure", () => {
  it("stock-only buckets have exposure equal to market value", () => {
    const acct = seedAccount("Test");
    const stock = seedStock("AAPL", "US Large Cap Equity");
    seedHolding(acct, stock, 10);
    seedPrice(stock, 100);

    const rows = getAllocationByDimension(db, "fund_category");
    const bucket = rows.find((r) => r.group_name === "US Large Cap Equity")!;
    expect(bucket.net_exposure).toBeCloseTo(1_000);
    expect(bucket.exposure_pct).toBeCloseTo(100);
  });

  it("a long put reduces its bucket's exposure below market value", () => {
    const acct = seedAccount("Test");
    const stock = seedStock("HOOD", "US Sector Equity (Financial)");
    seedHolding(acct, stock, 100);
    seedPrice(stock, 80); // $8,000

    const put = seedOption("HOOD  P90", "HOOD", "PUT", 90, futureDate(365));
    seedHolding(acct, put, 1);
    seedPrice(put, 14); // $1,400 MV, negative delta exposure

    const rows = getAllocationByDimension(db, "fund_category");
    const bucket = rows.find((r) => r.group_name === "US Sector Equity (Financial)")!;
    // MV stacks both legs; exposure nets the hedge against the stock
    expect(bucket.total_market_value).toBeCloseTo(9_400);
    expect(bucket.net_exposure).toBeLessThan(8_000);
    expect(bucket.exposure_pct).toBeLessThan(bucket.percentage);
  });

  it("a long call's exposure exceeds its premium in the bucket", () => {
    const acct = seedAccount("Test");
    seedStock("INTC", "US Sector Equity (Semiconductors)");
    const intc = db.prepare("SELECT id FROM securities WHERE symbol='INTC'").get() as { id: number };
    seedPrice(intc.id, 100);

    const call = seedOption("INTC  C90", "INTC", "CALL", 90, futureDate(365));
    seedHolding(acct, call, 1);
    seedPrice(call, 18); // $1,800 premium

    const rows = getAllocationByDimension(db, "fund_category");
    const bucket = rows.find((r) => r.group_name === "US Sector Equity (Semiconductors)")!;
    expect(bucket.total_market_value).toBeCloseTo(1_800);
    expect(bucket.net_exposure).toBeGreaterThan(5_000); // Δ ≥ 0.5 × $10k notional
  });

  it("sector dimension carries exposure through ETF look-through proportionally", () => {
    const acct = seedAccount("Test");
    const etf = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, fund_category, multiplier) VALUES ('XLK2', 'XLK2', 'ETF', 'US Equity', 1)"
      )
      .run().lastInsertRowid as number;
    seedHolding(acct, etf, 10);
    seedPrice(etf, 100); // $1,000
    const w = db.prepare(
      "INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES ('XLK2', ?, ?, '2026-06-01', 'manual')"
    );
    w.run("Technology", 60);
    w.run("Financials", 40);

    const rows = getAllocationByDimension(db, "sector");
    const tech = rows.find((r) => r.group_name === "Technology")!;
    expect(tech.net_exposure).toBeCloseTo(600);
    expect(rows.find((r) => r.group_name === "Financials")!.net_exposure).toBeCloseTo(400);
  });
});

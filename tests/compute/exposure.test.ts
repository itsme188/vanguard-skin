// tests/compute/exposure.test.ts
//
// Pins delta-adjusted exposure: stocks/funds count at market value
// (delta = 1); options count at Δ × spot × multiplier × qty — signed, so a
// long put is NEGATIVE exposure that offsets common shares, and a long call
// contributes its underlying-equivalent dollars (≫ premium). Options whose
// Greeks can't compute (no underlying price / expired) fall back to
// ±2.5 × market value — the same DEFAULT_OPTION_ELASTICITY convention the
// scenario engine uses — negative for puts.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getOptionExposureMap,
  optionExposureFallback,
  getPortfolioExposureSummary,
} from "@/lib/compute/exposure";

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedStock(symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, multiplier) VALUES (?, ?, 'Stock', 1)")
    .run(symbol, `${symbol} Inc`).lastInsertRowid as number;
}

function seedOption(
  symbol: string,
  underlying: string,
  optionType: "CALL" | "PUT",
  strike: number,
  expiration: string
): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, 'Option', ?, ?, ?, ?, 100)`
    )
    .run(symbol, `${symbol}`, underlying, optionType, strike, expiration).lastInsertRowid as number;
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

describe("getOptionExposureMap", () => {
  it("computes signed delta-notional for priced options: calls positive, puts negative", () => {
    const acct = seedAccount("Test");
    const stock = seedStock("AAPL");
    seedPrice(stock, 100);

    const exp = futureDate(365);
    const call = seedOption("AAPL  C90", "AAPL", "CALL", 90, exp); // ITM call, Δ > 0.5
    seedHolding(acct, call, 1);
    seedPrice(call, 18);

    const put = seedOption("AAPL  P110", "AAPL", "PUT", 110, exp); // ITM put, Δ < -0.5
    seedHolding(acct, put, 2);
    seedPrice(put, 16);

    const map = getOptionExposureMap(db);
    const callExp = map.get(call)!;
    const putExp = map.get(put)!;

    // Call: Δ × 100 × 100 × 1 — ITM so between half and full notional
    expect(callExp).toBeGreaterThan(5_000);
    expect(callExp).toBeLessThan(10_000);
    // Put: negative, scaled by qty 2 (near-ATM-forward, so |Δ| ≈ 0.5)
    expect(putExp).toBeLessThan(-8_000);
    expect(putExp).toBeGreaterThan(-20_000);
  });

  it("flips sign for short option positions", () => {
    const acct = seedAccount("Test");
    const stock = seedStock("MSFT");
    seedPrice(stock, 100);
    const call = seedOption("MSFT  C90", "MSFT", "CALL", 90, futureDate(365));
    seedHolding(acct, call, -1); // short call
    seedPrice(call, 18);

    const map = getOptionExposureMap(db);
    expect(map.get(call)!).toBeLessThan(0); // short call = negative exposure
  });

  it("omits options whose Greeks cannot compute (caller falls back)", () => {
    const acct = seedAccount("Test");
    // No underlying security/price at all
    const orphan = seedOption("ZZZ   C10", "ZZZ", "CALL", 10, futureDate(100));
    seedHolding(acct, orphan, 1);
    seedPrice(orphan, 2);

    const map = getOptionExposureMap(db);
    expect(map.has(orphan)).toBe(false);
  });
});

describe("optionExposureFallback", () => {
  it("uses ±2.5× market value, negative for puts", () => {
    expect(optionExposureFallback("CALL", 1000)).toBe(2500);
    expect(optionExposureFallback("PUT", 1000)).toBe(-2500);
    // Short positions carry negative MV — direction composes
    expect(optionExposureFallback("CALL", -1000)).toBe(-2500);
    expect(optionExposureFallback("PUT", -1000)).toBe(2500);
    expect(optionExposureFallback(null, 1000)).toBe(2500);
  });
});

describe("getPortfolioExposureSummary", () => {
  it("stocks at MV; net sums signed exposure; gross sums absolute per security", () => {
    const acct = seedAccount("Test");
    const stock = seedStock("HOOD");
    seedHolding(acct, stock, 100);
    seedPrice(stock, 80); // $8,000 long stock

    const put = seedOption("HOOD  P90", "HOOD", "PUT", 90, futureDate(365)); // ITM put hedge
    seedHolding(acct, put, 1);
    seedPrice(put, 14);

    const s = getPortfolioExposureSummary(db);
    expect(s.total_market_value).toBeCloseTo(8_000 + 1_400);
    // Put exposure is negative → net < total MV
    expect(s.net_exposure).toBeLessThan(8_000);
    // Gross counts the hedge's magnitude
    expect(s.gross_exposure).toBeGreaterThan(s.net_exposure);
    expect(s.gross_exposure).toBeGreaterThan(8_000);
  });

  it("scopes to accountIds", () => {
    const a1 = seedAccount("A1");
    const a2 = seedAccount("A2");
    const s1 = seedStock("AAA");
    const s2 = seedStock("BBB");
    seedHolding(a1, s1, 10);
    seedPrice(s1, 100); // $1,000 in A1
    seedHolding(a2, s2, 10);
    seedPrice(s2, 50); // $500 in A2

    const s = getPortfolioExposureSummary(db, [a1]);
    expect(s.total_market_value).toBeCloseTo(1_000);
    expect(s.net_exposure).toBeCloseTo(1_000);
  });
});

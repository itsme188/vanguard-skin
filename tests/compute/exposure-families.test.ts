// tests/compute/exposure-families.test.ts
//
// Pins getNetExposureForSymbolFamilies: per-input-symbol net exposure for the
// earnings cockpit. Rolls up issuer-family siblings (GOOG holding answers a
// GOOGL query), attributes options to their underlying, threads FX, and
// returns 0 for watchlist-only (unheld) names.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getNetExposureForSymbolFamilies } from "@/lib/compute/exposure";

let db: Database.Database;
let acctId: number;

function seedSecurity(symbol: string, opts: Partial<{
  type: string; underlying: string | null; optionType: string | null;
  multiplier: number; currency: string;
}> = {}): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, multiplier, currency, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol, symbol, opts.type ?? "Stock", opts.underlying ?? null,
      opts.optionType ?? null, opts.multiplier ?? 1, opts.currency ?? "USD", `t:${symbol}`
    ).lastInsertRowid as number;
}

function seedHolding(secId: number, qty: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, '2026-07-01', ?)"
  ).run(acctId, secId, qty, `h:${secId}:${qty}`);
}

function seedPrice(secId: number, price: number) {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-07-07', ?, 'manual')"
  ).run(secId, price);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  acctId = db
    .prepare("INSERT INTO accounts (name) VALUES ('t')")
    .run().lastInsertRowid as number;
});

describe("getNetExposureForSymbolFamilies", () => {
  it("long stock counts at market value; short counts negative", () => {
    const long = seedSecurity("NVDA");
    seedHolding(long, 100);
    seedPrice(long, 128);
    const short = seedSecurity("TSLA");
    seedHolding(short, -50);
    seedPrice(short, 300);
    const result = getNetExposureForSymbolFamilies(db, ["NVDA", "TSLA"]);
    expect(result.NVDA ?? result["NVDA"]).toBeCloseTo(12800, 0);
    expect(result.TSLA).toBeCloseTo(-15000, 0);
  });

  it("dual-class family rolls up: GOOG holding answers a GOOGL query", () => {
    const goog = seedSecurity("GOOG");
    seedHolding(goog, 10);
    seedPrice(goog, 180);
    const result = getNetExposureForSymbolFamilies(db, ["GOOGL"]);
    expect(result.GOOGL).toBeCloseTo(1800, 0);
  });

  it("options attribute to the underlying via the ±elasticity fallback when Greeks unavailable", () => {
    const put = seedSecurity("NVDA  261218P00120000", {
      type: "Option", underlying: "NVDA", optionType: "PUT", multiplier: 100,
    });
    seedHolding(put, 2);
    seedPrice(put, 5); // MV = 2 × 5 × 100 = 1000 → put fallback = −2.5 × 1000
    const stock = seedSecurity("NVDA");
    seedHolding(stock, 100);
    seedPrice(stock, 128);
    const result = getNetExposureForSymbolFamilies(db, ["NVDA"]);
    // Expect the ±2.5x fallback (12800 - 2500 = 10300): the option has no
    // expiration_date seeded, so computePortfolioGreeks treats it as expired
    // and it's absent from getOptionExposureMap, forcing the fallback path.
    // Bounded assertion per brief Step 4 guidance in case Greeks do compute.
    expect(result.NVDA).toBeLessThan(12800);
    expect(result.NVDA).toBeGreaterThan(0);
  });

  it("unheld symbol (watchlist-only) returns 0; empty input returns {}", () => {
    expect(getNetExposureForSymbolFamilies(db, ["AMD"])).toEqual({ AMD: 0 });
    expect(getNetExposureForSymbolFamilies(db, [])).toEqual({});
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";

// Migration 002_seed_accounts.sql seeds accounts with IDs:
//   1 = Vanguard Taxable, 2 = Vanguard Roth IRA, 3 = IBKR
// The holdings table has no "source" column — only "source_key".

describe("computePortfolioGreeks — multi-account data freshness", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    // Underlying stocks
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (10, 'AAPL', 'Stock')`).run();
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (11, 'MSFT', 'Stock')`).run();

    // Options on each underlying
    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (100, 'AAPL  260120C00200000', 'Option', 'CALL', 200, '2026-01-20', 'AAPL', 100)`).run();
    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (101, 'MSFT  260120C00400000', 'Option', 'CALL', 400, '2026-01-20', 'MSFT', 100)`).run();

    // Underlying prices (today)
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (10, ?, 195, 'tws')`).run(today);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (11, ?, 410, 'tws')`).run(today);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (100, ?, 5.20, 'tws')`).run(today);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (101, ?, 18.50, 'tws')`).run(today);

    // Account 1 (Vanguard Taxable): AAPL option, as_of 2026-04-30 (last statement)
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 100, '2026-04-30', 1, 'vg-1')`).run();
    // Account 3 (IBKR): MSFT option, as_of today (TWS auto-refresh)
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (3, 101, ?, 1, 'tws-3')`).run(today);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces options from BOTH accounts despite different as_of_dates", () => {
    const result = computePortfolioGreeks(db);
    const symbols = result.positions.map((p) => p.symbol).sort();
    expect(symbols).toEqual(["AAPL  260120C00200000", "MSFT  260120C00400000"]);
  });

  it("surfaces short option positions (negative quantity)", () => {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (102, 'MSFT  260120P00380000', 'Option', 'PUT', 380, '2026-01-20', 'MSFT', 100)`).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (102, ?, 4.10, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (3, 102, ?, -1, 'tws-3-short')`).run(today);

    const result = computePortfolioGreeks(db);
    const shortPut = result.positions.find((p) => p.symbol.endsWith("P00380000"));
    expect(shortPut).toBeDefined();
    expect(shortPut!.quantity).toBe(-1);
  });

  it("filters by accountId when provided", () => {
    const result = computePortfolioGreeks(db, { accountId: 1 });
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].symbol).toContain("AAPL");
  });

  it("returns diagnostics for positions that can't compute Greeks", () => {
    // Add an option whose underlying has no price
    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (200, 'XYZ   260120C00100000', 'Option', 'CALL', 100, '2026-01-20', 'XYZ', 100)`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 200, '2026-04-30', 1, 'vg-200')`).run();
    // No prices for XYZ underlying

    const result = computePortfolioGreeks(db);
    const diag = result.diagnostics.find((d) => d.symbol.startsWith("XYZ"));
    expect(diag).toBeDefined();
    expect(diag!.reason).toBe("no_underlying_price");
  });

  it("emits missing_option_price diagnostic when option price is zero", () => {
    const today = new Date().toISOString().slice(0, 10);
    // Option security with an underlying price but option close_price = 0
    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (300, 'AAPL  270120C00300000', 'Option', 'CALL', 300, '2027-01-20', 'AAPL', 100)`).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (300, ?, 0, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 300, '2026-04-30', 1, 'vg-300')`).run();

    const result = computePortfolioGreeks(db);
    const diag = result.diagnostics.find((d) => d.symbol === "AAPL  270120C00300000");
    expect(diag).toBeDefined();
    expect(diag!.reason).toBe("missing_option_price");
    // Greeks should still be computed using 30% vol fallback
    const pos = result.positions.find((p) => p.symbol === "AAPL  270120C00300000");
    expect(pos).toBeDefined();
    expect(pos!.greeks).not.toBeNull();
  });

  it("emits missing_iv diagnostic when IV solver can't converge", () => {
    const today = new Date().toISOString().slice(0, 10);
    // Deep ITM call: underlying $500, strike $1, market option price $0.01.
    // Intrinsic value ≈ $499 so BS price at any vol >> 0.01 — bisection sees
    // fLo < 0 AND fHi < 0 (both market prices above the bracket), returns null.
    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (400, 'DEEP  270120C00001000', 'Option', 'CALL', 1, '2027-01-20', 'DEEP', 100)`).run();
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (41, 'DEEP', 'Stock')`).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (41, ?, 500, 'tws')`).run(today);
    // Option price $0.01 — impossibly low for a deep-ITM call (intrinsic ~$499)
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (400, ?, 0.01, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 400, '2026-04-30', 1, 'vg-400')`).run();

    const result = computePortfolioGreeks(db);
    const diag = result.diagnostics.find((d) => d.symbol === "DEEP  270120C00001000");
    expect(diag).toBeDefined();
    expect(diag!.reason).toBe("missing_iv");
    // Greeks still computed with 30% vol fallback
    const pos = result.positions.find((p) => p.symbol === "DEEP  270120C00001000");
    expect(pos).toBeDefined();
    expect(pos!.greeks).not.toBeNull();
    expect(pos!.greeks!.iv).toBeNull(); // IV is null since solver failed
  });

  it("reports 0 DTE in late-evening ET after the previous UTC derivation has advanced to tomorrow", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T23:30:00-04:00"));
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-08-29");

    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (500, 'AAPL  260828C00200000', 'Option', 'CALL', 200, '2026-08-28', 'AAPL', 100)`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 500, '2026-08-28', 1, 'et-today')`).run();

    const result = computePortfolioGreeks(db);
    expect(result.positions.find((position) => position.securityId === 500)?.daysToExpiry).toBe(0);
  });
});

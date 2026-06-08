import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";
import { upsertSecurityQuote } from "@/lib/mutations/security-quotes";

// When an option has no market price, Greeks previously fell back to a blind 30%
// vol. With an IBKR market-data snapshot stored for the underlying, the
// underlying's implied vol should be used instead. Far-future expiry so the
// position isn't 'expired' relative to the real test-run date.

let db: Database.Database;
const FUTURE_EXP = "2027-12-17";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  // Underlying AAPL stock + a current price so underlying_price resolves.
  db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (10, 'AAPL', 'Stock')`).run();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (10, ?, 205, 'tws')`).run(today);

  // AAPL call, far-future expiry. No price row → option_price is null.
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
     VALUES (100, 'AAPL  271217C00200000', 'Option', 'CALL', 200, '${FUTURE_EXP}', 'AAPL', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
     VALUES (3, 100, '2026-04-30', 1, 'tws-3')`,
  ).run();
});

describe("computePortfolioGreeks — IBKR underlying IV fallback", () => {
  it("uses the stored underlying IV when the option has no price", () => {
    upsertSecurityQuote(db, {
      securityId: 10,
      asOfDate: "2026-06-08",
      ivUnderlying: 0.42, // 42%
      hv30d: 0.4,
      week52High: 316.94,
      week52Low: 194.47,
      dividendYield: null,
    });

    const result = computePortfolioGreeks(db);
    const pos = result.positions.find((p) => p.symbol.startsWith("AAPL  27"));
    expect(pos).toBeDefined();
    expect(pos!.greeks).not.toBeNull();
    expect(pos!.greeks!.iv).toBeCloseTo(0.42, 4);
    expect(pos!.greeks!.ivSource).toBe("ibkr");
    // Recovered → no missing_option_price diagnostic for this name.
    expect(result.diagnostics.find((d) => d.symbol.startsWith("AAPL  27"))).toBeUndefined();
  });

  it("falls back to the 30% default (iv null) when no stored quote exists", () => {
    const result = computePortfolioGreeks(db);
    const pos = result.positions.find((p) => p.symbol.startsWith("AAPL  27"));
    expect(pos!.greeks).not.toBeNull();
    expect(pos!.greeks!.iv).toBeNull(); // we don't claim 30% as a real IV
    expect(pos!.greeks!.ivSource).toBe("default");
    expect(result.diagnostics.find((d) => d.symbol.startsWith("AAPL  27"))!.reason).toBe(
      "missing_option_price",
    );
  });

  it("prefers the computed IV from the option price over the stored quote", () => {
    // Give the option a real price → IV is solved, stored quote ignored.
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (100, ?, 25.0, 'tws')`).run(today);
    upsertSecurityQuote(db, {
      securityId: 10,
      asOfDate: "2026-06-08",
      ivUnderlying: 0.42,
      hv30d: 0.4,
      week52High: 316.94,
      week52Low: 194.47,
      dividendYield: null,
    });

    const result = computePortfolioGreeks(db);
    const pos = result.positions.find((p) => p.symbol.startsWith("AAPL  27"));
    expect(pos!.greeks!.ivSource).toBe("computed");
    expect(pos!.greeks!.iv).not.toBeCloseTo(0.42, 4); // solved from price, not the 0.42 quote
  });
});

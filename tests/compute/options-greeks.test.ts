import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { buildOCCSymbol } from "@/lib/import/occ-symbol";
import {
  normCdf,
  normPdf,
  callPrice,
  putPrice,
  delta,
  gamma,
  theta,
  vega,
  impliedVolatility,
  computePortfolioGreeks,
} from "@/lib/compute/options-greeks";

// ─── Known values for Black-Scholes verification ────────────────
// Reference: Hull, "Options, Futures, and Other Derivatives"
// S=100, K=100, T=1yr, r=5%, σ=20% → Call ≈ $10.45, Put ≈ $5.57

const S = 100;
const K = 100;
const T = 1;
const r = 0.05;
const sigma = 0.2;

describe("normCdf", () => {
  it("returns 0.5 at x=0", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
  });

  it("returns ~0.8413 at x=1", () => {
    expect(normCdf(1)).toBeCloseTo(0.8413, 3);
  });

  it("returns ~0.0228 at x=-2", () => {
    expect(normCdf(-2)).toBeCloseTo(0.0228, 3);
  });

  it("handles extreme values", () => {
    expect(normCdf(-10)).toBe(0);
    expect(normCdf(10)).toBe(1);
  });
});

describe("callPrice / putPrice", () => {
  it("computes ATM call price matching Hull textbook", () => {
    const price = callPrice(S, K, T, r, sigma);
    expect(price).toBeCloseTo(10.45, 1);
  });

  it("computes ATM put price matching Hull textbook", () => {
    const price = putPrice(S, K, T, r, sigma);
    expect(price).toBeCloseTo(5.57, 1);
  });

  it("satisfies put-call parity: C - P = S - K*e^(-rT)", () => {
    const C = callPrice(S, K, T, r, sigma);
    const P = putPrice(S, K, T, r, sigma);
    const parity = S - K * Math.exp(-r * T);
    expect(C - P).toBeCloseTo(parity, 4);
  });

  it("returns intrinsic value when expired (T=0)", () => {
    expect(callPrice(110, 100, 0, r, sigma)).toBe(10);
    expect(callPrice(90, 100, 0, r, sigma)).toBe(0);
    expect(putPrice(90, 100, 0, r, sigma)).toBe(10);
    expect(putPrice(110, 100, 0, r, sigma)).toBe(0);
  });

  it("deep ITM call approaches intrinsic + time value", () => {
    const deepItm = callPrice(150, 100, T, r, sigma);
    expect(deepItm).toBeGreaterThan(50); // at least intrinsic
    expect(deepItm).toBeLessThan(60); // but not much more
  });

  it("deep OTM put is near zero", () => {
    const deepOtm = putPrice(200, 100, T, r, sigma);
    expect(deepOtm).toBeLessThan(0.01);
  });
});

describe("delta", () => {
  it("ATM call delta is approximately 0.5-0.6", () => {
    const d = delta(S, K, T, r, sigma, "CALL");
    expect(d).toBeGreaterThan(0.5);
    expect(d).toBeLessThan(0.7);
  });

  it("ATM put delta is approximately -0.5 to -0.4", () => {
    const d = delta(S, K, T, r, sigma, "PUT");
    expect(d).toBeGreaterThan(-0.5);
    expect(d).toBeLessThan(-0.3);
  });

  it("deep ITM call delta approaches 1", () => {
    const d = delta(200, 100, T, r, sigma, "CALL");
    expect(d).toBeGreaterThan(0.99);
  });

  it("deep OTM call delta approaches 0", () => {
    const d = delta(50, 100, T, r, sigma, "CALL");
    expect(d).toBeLessThan(0.01);
  });

  it("call delta - put delta = 1 (at same strike)", () => {
    const callD = delta(S, K, T, r, sigma, "CALL");
    const putD = delta(S, K, T, r, sigma, "PUT");
    expect(callD - putD).toBeCloseTo(1, 4);
  });
});

describe("gamma", () => {
  it("is positive and highest ATM", () => {
    const atmGamma = gamma(S, K, T, r, sigma);
    const itmGamma = gamma(130, K, T, r, sigma);
    const otmGamma = gamma(70, K, T, r, sigma);
    expect(atmGamma).toBeGreaterThan(0);
    expect(atmGamma).toBeGreaterThan(itmGamma);
    expect(atmGamma).toBeGreaterThan(otmGamma);
  });

  it("returns 0 when expired", () => {
    expect(gamma(S, K, 0, r, sigma)).toBe(0);
  });
});

describe("theta", () => {
  it("is negative for long ATM call (time decay)", () => {
    const th = theta(S, K, T, r, sigma, "CALL");
    expect(th).toBeLessThan(0);
  });

  it("is negative for long ATM put (time decay)", () => {
    const th = theta(S, K, T, r, sigma, "PUT");
    expect(th).toBeLessThan(0);
  });

  it("magnitude increases as expiration approaches", () => {
    const theta1y = Math.abs(theta(S, K, 1, r, sigma, "CALL"));
    const theta1m = Math.abs(theta(S, K, 30 / 365, r, sigma, "CALL"));
    expect(theta1m).toBeGreaterThan(theta1y);
  });
});

describe("vega", () => {
  it("is positive and highest ATM", () => {
    const atmVega = vega(S, K, T, r, sigma);
    const itmVega = vega(130, K, T, r, sigma);
    expect(atmVega).toBeGreaterThan(0);
    expect(atmVega).toBeGreaterThan(itmVega);
  });

  it("returns 0 when expired", () => {
    expect(vega(S, K, 0, r, sigma)).toBe(0);
  });
});

describe("impliedVolatility", () => {
  it("recovers known volatility from call price", () => {
    const price = callPrice(S, K, T, r, sigma);
    const iv = impliedVolatility(price, S, K, T, r, "CALL");
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(sigma, 4);
  });

  it("recovers known volatility from put price", () => {
    const price = putPrice(S, K, T, r, sigma);
    const iv = impliedVolatility(price, S, K, T, r, "PUT");
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(sigma, 4);
  });

  it("handles high volatility (80%)", () => {
    const highVol = 0.8;
    const price = callPrice(S, K, T, r, highVol);
    const iv = impliedVolatility(price, S, K, T, r, "CALL");
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(highVol, 3);
  });

  it("handles low volatility (5%)", () => {
    const lowVol = 0.05;
    const price = callPrice(S, K, T, r, lowVol);
    const iv = impliedVolatility(price, S, K, T, r, "CALL");
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(lowVol, 3);
  });

  it("returns null for expired options", () => {
    expect(impliedVolatility(5, S, K, 0, r, "CALL")).toBeNull();
  });

  it("returns null for zero/negative market price", () => {
    expect(impliedVolatility(0, S, K, T, r, "CALL")).toBeNull();
    expect(impliedVolatility(-1, S, K, T, r, "CALL")).toBeNull();
  });

  it("works for deep ITM put", () => {
    const price = putPrice(80, 100, 0.5, r, 0.25);
    const iv = impliedVolatility(price, 80, 100, 0.5, r, "PUT");
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(0.25, 3);
  });
});

// ─── Coverage counters (computedPositions / totalPositions) ─────
//
// Finding: a scope whose only option position couldn't be priced still
// reported totalDelta/Gamma/Theta/Vega as 0.0, which the card then read as
// an affirmative "delta-neutral" / "negligible" verdict. The fix threads a
// coverage pair through PortfolioGreeks so the UI can tell "flat because
// priced flat" apart from "flat because nothing was priced".

describe("computePortfolioGreeks — coverage counters", () => {
  let db: Database.Database;
  let today: string;
  let farExpiry: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    today = todayET();
    farExpiry = addDays(today, 180);
  });

  it("reports computedPositions=0, totalPositions=1 when the only position has no underlying price", () => {
    const symbol = buildOCCSymbol("QAAA", farExpiry, "CALL", 50);
    // Underlying security exists but has NO price row → underlying_price is null.
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (10, 'QAAA', 'Stock')`).run();
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
       VALUES (100, ?, 'Option', 'CALL', 50, ?, 'QAAA', 100)`,
    ).run(symbol, farExpiry);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
       VALUES (1, 100, '2026-04-30', 1, 'qaaa-1')`,
    ).run();

    const result = computePortfolioGreeks(db);

    expect(result.totalPositions).toBe(1);
    expect(result.computedPositions).toBe(0);
    expect(result.totalDelta).toBe(0);
    expect(result.totalGamma).toBe(0);
    expect(result.totalTheta).toBe(0);
    expect(result.totalVega).toBe(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].reason).toBe("no_underlying_price");
  });

  it("reports computedPositions=1, totalPositions=2 in a mixed priceable / unpriceable scope", () => {
    const priceableSymbol = buildOCCSymbol("QBBB", farExpiry, "CALL", 100);
    const unpriceableSymbol = buildOCCSymbol("QCCC", farExpiry, "CALL", 50);

    // Priceable: underlying has a price.
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (20, 'QBBB', 'Stock')`).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (20, ?, 120, 'tws')`).run(today);
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
       VALUES (200, ?, 'Option', 'CALL', 100, ?, 'QBBB', 100)`,
    ).run(priceableSymbol, farExpiry);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
       VALUES (1, 200, '2026-04-30', 1, 'qbbb-1')`,
    ).run();

    // Unpriceable: underlying exists, no price row.
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (21, 'QCCC', 'Stock')`).run();
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
       VALUES (201, ?, 'Option', 'CALL', 50, ?, 'QCCC', 100)`,
    ).run(unpriceableSymbol, farExpiry);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
       VALUES (1, 201, '2026-04-30', 1, 'qccc-1')`,
    ).run();

    const result = computePortfolioGreeks(db);

    expect(result.totalPositions).toBe(2);
    expect(result.computedPositions).toBe(1);
    const priced = result.positions.find((p) => p.symbol === priceableSymbol);
    const unpriced = result.positions.find((p) => p.symbol === unpriceableSymbol);
    expect(priced?.greeks).not.toBeNull();
    expect(unpriced?.greeks).toBeNull();
  });

  it("reports computedPositions === totalPositions when every position is priceable", () => {
    const symbolA = buildOCCSymbol("QDDD", farExpiry, "CALL", 100);
    const symbolB = buildOCCSymbol("QEEE", farExpiry, "PUT", 200);

    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (30, 'QDDD', 'Stock')`).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (30, ?, 110, 'tws')`).run(today);
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
       VALUES (300, ?, 'Option', 'CALL', 100, ?, 'QDDD', 100)`,
    ).run(symbolA, farExpiry);
    // Real option price so the IV solver converges — no missing_iv /
    // missing_option_price diagnostic for a position that DID compute.
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (300, ?, 15.0, 'tws')`).run(today);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
       VALUES (1, 300, '2026-04-30', 1, 'qddd-1')`,
    ).run();

    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (31, 'QEEE', 'Stock')`).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (31, ?, 190, 'tws')`).run(today);
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
       VALUES (301, ?, 'Option', 'PUT', 200, ?, 'QEEE', 100)`,
    ).run(symbolB, farExpiry);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (301, ?, 25.0, 'tws')`).run(today);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
       VALUES (1, 301, '2026-04-30', 1, 'qeee-1')`,
    ).run();

    const result = computePortfolioGreeks(db);

    expect(result.totalPositions).toBe(2);
    expect(result.computedPositions).toBe(2);
    expect(result.diagnostics).toHaveLength(0);
  });
});

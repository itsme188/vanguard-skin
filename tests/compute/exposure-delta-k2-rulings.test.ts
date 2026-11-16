import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { runMigrations } from "@/lib/db/migrate";
import { computeExposureDelta, BOND_EQUITY_BETA_ESTIMATE } from "@/lib/compute/exposure-delta";
import { todayET } from "@/lib/calendar/date-utils";
import { BETA_LOOKBACK_DAYS } from "@/lib/queries/security-betas";

// What-if owner rulings of 2026-11-15 (unit K2). Synthetic symbols and round
// figures only.
//  K2a: a holding with no stored beta takes a type-based estimate, not 1.0;
//       the result says how much of the beta rests on estimates.
//  K2b: sector weights look through funds (stored sector weights), and a
//       fund whose weights fall short of 100 puts the rest in its own sector.
//  K2c: a sectorless bond is "Fixed Income", a cash equivalent "Cash
//       Equivalent" (the Cash-deploy names).
//  K2d: a known security with no usable price is dropped as "no_price".

let db: Database.Database;
const today = todayET();
let nextId = 1;

function addSecurity(
  symbol: string,
  opts: {
    type: string;
    sector?: string | null;
    fundCategory?: string | null;
    price?: number | null;
    qty?: number;
    beta?: number;
    underlying?: string;
    optionType?: string;
    strike?: number;
    expiration?: string;
    multiplier?: number;
  },
): number {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector, fund_category, currency, multiplier,
       underlying_symbol, option_type, strike_price, expiration_date)
     VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    symbol,
    opts.type,
    opts.sector ?? null,
    opts.fundCategory ?? null,
    opts.multiplier ?? null,
    opts.underlying ?? null,
    opts.optionType ?? null,
    opts.strike ?? null,
    opts.expiration ?? null,
  );
  if (opts.price !== undefined && opts.price !== null) {
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(
      id,
      today,
      opts.price,
    );
  }
  if (opts.qty !== undefined) {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, ?, ?, ?)`,
    ).run(id, today, opts.qty, `k2-${symbol}`);
  }
  if (opts.beta !== undefined) {
    db.prepare(
      `INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, ?, ?, ?)`,
    ).run(id, BETA_LOOKBACK_DAYS, opts.beta, `${today} 12:00:00`);
  }
  return id;
}

function addFundWeights(symbol: string, weights: Array<[string, number]>) {
  const ins = db.prepare(
    `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES (?, ?, ?, ?, 'manual')`,
  );
  for (const [sector, pct] of weights) ins.run(symbol, sector, pct, today);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 1;
});

describe("K2a: beta fallback by type", () => {
  it("a cash equivalent with no stored beta counts at 0, not 1.0", () => {
    addSecurity("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 10, beta: 1 }); // 1,000
    addSecurity("ZZMM", { type: "Mutual Fund", fundCategory: "Cash Equivalent", price: 1, qty: 1000 }); // 1,000
    const d = computeExposureDelta(db, "all", undefined, []);
    expect(d.before.beta).toBeCloseTo(0.5, 9);
    // A cash equivalent's zero is definitional, not an estimate.
    expect(d.before.betaEstimatedWeight).toBeCloseTo(0, 9);
  });

  it("a bond with no stored beta takes the scenario engine's bond estimate, flagged as estimated", () => {
    addSecurity("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 10, beta: 1 }); // 1,000
    addSecurity("912ZZ0001", { type: "Bond", price: 100, qty: 10 }); // per-100-face: 10 × 100 / 100 × ... valued by marketValue
    const d = computeExposureDelta(db, "all", undefined, []);
    const bondValue = d.before.totalValue - 1000;
    expect(bondValue).toBeGreaterThan(0);
    const expected = (1000 * 1 + bondValue * BOND_EQUITY_BETA_ESTIMATE) / d.before.totalValue;
    expect(d.before.beta).toBeCloseTo(expected, 9);
    expect(d.before.betaEstimatedWeight).toBeCloseTo(bondValue / d.before.totalValue, 9);
  });

  it("the bond estimate is the scenario engine's own figure (parity pin)", () => {
    const src = readFileSync("lib/compute/scenarios.ts", "utf8");
    expect(src).toContain(`if (type === "bond") return ${BOND_EQUITY_BETA_ESTIMATE};`);
  });

  it("a stock with no stored beta keeps 1.0 and is counted as estimated", () => {
    addSecurity("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 10, beta: 2 });
    addSecurity("ZZB", { type: "Stock", sector: "Industrials", price: 100, qty: 10 });
    const d = computeExposureDelta(db, "all", undefined, []);
    expect(d.before.beta).toBeCloseTo(1.5, 9);
    expect(d.before.betaEstimatedWeight).toBeCloseTo(0.5, 9);
  });

  it("an option with no greeks takes its underlying's stored beta on its market value", () => {
    addSecurity("ZZU", { type: "Stock", sector: "Technology", price: 50, beta: 2 }); // not held
    addSecurity("ZZA", { type: "Stock", sector: "Industrials", price: 100, qty: 10, beta: 1 }); // 1,000
    // No strike / expiry: greeks cannot compute, so the market value is used.
    addSecurity("ZZU OPT", { type: "Option", sector: "Technology", price: 10, qty: 1, multiplier: 100, underlying: "ZZU" }); // 1,000
    const d = computeExposureDelta(db, "all", undefined, []);
    expect(d.before.beta).toBeCloseTo((1000 * 1 + 1000 * 2) / 2000, 9);
    expect(d.before.betaEstimatedWeight).toBeCloseTo(0, 9);
  });

  it("an option whose underlying has no stored beta takes the underlying's own fallback, estimated", () => {
    addSecurity("ZZBF", { type: "Mutual Fund", fundCategory: "Cash Equivalent", price: 1 }); // underlying is cash-like
    addSecurity("ZZA", { type: "Stock", sector: "Industrials", price: 100, qty: 10, beta: 1 });
    addSecurity("ZZBF OPT", { type: "Option", price: 10, qty: 1, multiplier: 100, underlying: "ZZBF" });
    const d = computeExposureDelta(db, "all", undefined, []);
    expect(d.before.beta).toBeCloseTo(0.5, 9);
  });

  it("an option with greeks is weighted at its delta-adjusted exposure", () => {
    addSecurity("ZZU", { type: "Stock", sector: "Technology", price: 100, beta: 2 }); // not held
    addSecurity("ZZA", { type: "Stock", sector: "Industrials", price: 100, qty: 100, beta: 1 }); // 10,000
    // A deep in-the-money call a year out: delta near 1, so its exposure is
    // close to 100 × 100 = 10,000 against a premium of about 5,000.
    const expiry = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
    addSecurity("ZZU   CALL50", {
      type: "Option",
      sector: "Technology",
      price: 52,
      qty: 1,
      multiplier: 100,
      underlying: "ZZU",
      optionType: "CALL",
      strike: 50,
      expiration: expiry,
    });
    const d = computeExposureDelta(db, "all", undefined, []);
    const total = d.before.totalValue; // 10,000 + 5,200
    expect(total).toBeCloseTo(15200, 6);
    // At market value the beta would be (10,000 + 5,200 × 2) / 15,200 ≈ 1.34;
    // at a delta near 1 it is (10,000 + ~10,000 × 2) / 15,200 ≈ 1.97.
    expect(d.before.beta).toBeGreaterThan(1.8);
  });

  it("the beta flag reads the estimated figure: a cash-heavy book no longer trips the cap", () => {
    addSecurity("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 10, beta: 1.5 }); // 1,000
    addSecurity("ZZMM", { type: "Mutual Fund", fundCategory: "Cash Equivalent", price: 1, qty: 1000 });
    const d = computeExposureDelta(db, "all", undefined, []);
    // 0.75 sits inside the default 0.7-1.2 range; at 1.0-for-cash it was 1.25.
    expect(d.flags.some((f) => f.metric === "beta")).toBe(false);
  });
});

describe("K2b: sector weights look through funds", () => {
  it("a fund with stored weights is split across them, before and after", () => {
    addSecurity("ZZA", { type: "Stock", sector: "Industrials", price: 100, qty: 10, beta: 1 }); // 1,000
    addSecurity("ZZIX", { type: "ETF", sector: "Diversified", price: 100, qty: 10, beta: 1 }); // 1,000
    addFundWeights("ZZIX", [["Technology", 60], ["Healthcare", 40]]);
    const d = computeExposureDelta(db, "all", undefined, [{ symbol: "ZZIX", action: "buy", dollarAmount: 2000 }]);
    expect(d.before.sectorWeights).toEqual({ Industrials: 0.5, Technology: 0.3, Healthcare: 0.2 });
    expect(d.after.sectorWeights.Technology).toBeCloseTo(0.45, 9);
    expect(d.after.sectorWeights.Healthcare).toBeCloseTo(0.3, 9);
    expect(d.after.sectorWeights.Diversified).toBeUndefined();
  });

  it("weights short of 100 put the rest in the fund's own sector; the total is conserved", () => {
    addSecurity("ZZIX", { type: "ETF", sector: "Diversified", price: 100, qty: 10, beta: 1 });
    addFundWeights("ZZIX", [["Technology", 50], ["Energy", 30]]);
    addSecurity("ZZNF", { type: "ETF", sector: null, price: 100, qty: 10, beta: 1 });
    addFundWeights("ZZNF", [["Utilities", 90]]);
    const d = computeExposureDelta(db, "all", undefined, []);
    const sum = Object.values(d.before.sectorWeights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 12);
    expect(d.before.sectorWeights.Diversified).toBeCloseTo(0.1, 9);
    expect(d.before.sectorWeights.Unknown).toBeCloseTo(0.05, 9);
    expect(d.before.sectorWeights.Utilities).toBeCloseTo(0.45, 9);
  });

  it("weights over 100 are scaled down so the total is conserved", () => {
    addSecurity("ZZIX", { type: "ETF", sector: "Diversified", price: 100, qty: 10, beta: 1 });
    addFundWeights("ZZIX", [["Technology", 80], ["Energy", 40]]);
    const d = computeExposureDelta(db, "all", undefined, []);
    const sum = Object.values(d.before.sectorWeights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 12);
    expect(d.before.sectorWeights.Technology).toBeCloseTo(2 / 3, 9);
  });

  it("the Diversified cap skip stays for a fund with NO weights, and not for a weighted fund's remainder", () => {
    // An unweighted broad fund at 80%: still not a sector bet.
    addSecurity("ZZBR", { type: "ETF", sector: "Diversified", price: 100, qty: 80, beta: 1 });
    addSecurity("ZZA", { type: "Stock", sector: "Industrials", price: 100, qty: 20, beta: 1 });
    let d = computeExposureDelta(db, "all", undefined, []);
    expect(d.flags.some((f) => f.metric === "sector:Diversified")).toBe(false);

    // A weighted fund whose weights cover 20%: its 80% Diversified remainder
    // is a known unclassified slice the cap now reads.
    addFundWeights("ZZBR", [["Technology", 20]]);
    d = computeExposureDelta(db, "all", undefined, []);
    expect(d.before.sectorWeights.Diversified).toBeCloseTo(0.64, 9);
    expect(d.flags.some((f) => f.metric === "sector:Diversified")).toBe(true);
  });
});

describe("K2c: bond and cash bucket names match Cash deploy", () => {
  it("a sectorless bond is Fixed Income and a cash equivalent is Cash Equivalent", () => {
    addSecurity("912ZZ0001", { type: "Bond", price: 100, qty: 10 });
    addSecurity("ZZMM", { type: "Mutual Fund", sector: "Diversified", fundCategory: "Cash Equivalent", price: 1, qty: 1000 });
    const d = computeExposureDelta(db, "all", undefined, []);
    expect(Object.keys(d.before.sectorWeights).sort()).toEqual(["Cash Equivalent", "Fixed Income"]);
    expect(d.before.sectorWeights.Unknown).toBeUndefined();
  });
});

describe("K2d: a known security with no price", () => {
  it("a held name with price 0 is dropped as no_price on a buy", () => {
    addSecurity("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 10, beta: 1 });
    addSecurity("ZZZ", { type: "Stock", sector: "Technology", price: 0, qty: 10 });
    const d = computeExposureDelta(db, "all", undefined, [{ symbol: "ZZZ", action: "buy", dollarAmount: 500 }]);
    expect(d.droppedLegs).toEqual([{ symbol: "ZZZ", reason: "no_price" }]);
  });

  it("a known security with no price row at all is no_price; an unknown ticker stays unknown_symbol", () => {
    addSecurity("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 10, beta: 1 });
    addSecurity("ZZN", { type: "Stock", sector: "Technology" });
    const d = computeExposureDelta(db, "all", undefined, [
      { symbol: "ZZN", action: "buy", dollarAmount: 500 },
      { symbol: "ZZQQ", action: "buy", dollarAmount: 500 },
    ]);
    expect(d.droppedLegs).toEqual([
      { symbol: "ZZN", reason: "no_price" },
      { symbol: "ZZQQ", reason: "unknown_symbol" },
    ]);
  });
});

/**
 * Owner rulings 2026-11-15 (unit K3).
 *
 * K3a: a FUND that is the scenario's subject moves exactly the headline;
 * single stocks may still move more. The semis preset used to move the fund
 * that tracks the semis index by headline x max(1, tariff + 0.6 x AI) = 2.24x,
 * and a put on that fund was repriced off the inflated move.
 *
 * K3b: a custom rate move gets the same equity rate leg the +25bp preset
 * uses (one rule, scaled by the size and sign of the move), on top of the
 * market leg; bonds keep their duration leg.
 *
 * Synthetic symbols; round prices.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeRecipeScenario, findRecipe } from "@/lib/compute/scenario-recipes";
import { computeScenario, type ScenarioResult } from "@/lib/compute/scenarios";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";

type Buckets = Partial<Record<FactorColumn, string>>;

let db: Database.Database;
let nextId = 500;

function seed(opts: {
  symbol: string;
  type?: string;
  sector?: string | null;
  industry?: string | null;
  fundCategory?: string | null;
  factors?: Buckets;
  qty?: number;
  price?: number;
  leverage?: number | null;
  durationYears?: number | null;
}): number {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector, industry, fund_category, geography, currency, leverage_factor, duration_years)
     VALUES (?, ?, ?, ?, ?, ?, 'US', 'USD', ?, ?)`
  ).run(
    id,
    opts.symbol,
    opts.type ?? "Stock",
    opts.sector ?? null,
    opts.industry ?? null,
    opts.fundCategory ?? null,
    opts.leverage ?? null,
    opts.durationYears ?? null
  );
  if (opts.factors) {
    const f = opts.factors;
    db.prepare(
      `INSERT INTO security_factors (security_id, ${FACTOR_COLUMNS.join(", ")}) VALUES (?, ${FACTOR_COLUMNS.map(() => "?").join(", ")})`
    ).run(id, ...FACTOR_COLUMNS.map((c) => f[c] ?? null));
  }
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(
    id,
    todayET(),
    opts.price ?? 100
  );
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, '2026-04-30', ?, ?)`
  ).run(id, opts.qty ?? 10, `h-${opts.symbol}`);
  return id;
}

function seedPut(underlying: string, strike: number): string {
  const id = nextId++;
  const symbol = `${underlying.padEnd(6)}270115P${String(strike * 1000).padStart(8, "0")}`;
  // Eastern-day arithmetic (house rule): a UTC slice of the wall clock is
  // already tomorrow from 20:00 Eastern.
  const expiry = addDays(todayET(), 180);
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier, currency)
     VALUES (?, ?, 'Option', ?, ?, ?, 'PUT', 100, 'USD')`
  ).run(id, symbol, underlying, strike, expiry);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 3, 'tws')`).run(id, todayET());
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, '2026-04-30', 1, ?)`
  ).run(id, `h-${id}`);
  return symbol;
}

const HOT: Buckets = {
  tariff_exposure: "Very High",
  ai_exposure: "Very High",
  regulatory_risk: "Very High",
  cyclical: "Very High",
  crypto_adjacent: "Very High",
  interest_rate_sensitive: "Very High",
  growth_vs_value: "Growth",
};

const impact = (r: ScenarioResult, symbol: string) => r.positionImpacts.find((p) => p.symbol === symbol)!;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 500;
});

describe("K3a — a fund that is the scenario's subject moves exactly the headline", () => {
  it("semis: the semis fund moves -15%, a put on it reprices off -15%, a hot semis stock still moves more", () => {
    seed({ symbol: "ZSEMF", type: "ETF", sector: "Technology", fundCategory: "US Sector Equity (Semiconductors)", factors: HOT });
    seed({ symbol: "ZSEMS", sector: "Technology", industry: "Semiconductors", factors: HOT });
    const put = seedPut("ZSEMF", 90);
    const r = computeRecipeScenario(db, findRecipe("semi_cycle_minus_15pct")!);
    expect(impact(r, "ZSEMF").changePercent).toBeCloseTo(-0.15, 10);
    expect(impact(r, "ZSEMF").subjectShare).toBe(1);
    expect(impact(r, put).underlyingMove).toBeCloseTo(-0.15, 10);
    expect(impact(r, "ZSEMS").changePercent).toBeCloseTo(-0.336, 6);
  });

  it("a stored 3x semis fund tracks the headline index move times its factor", () => {
    seed({ symbol: "ZSEM3", type: "ETF", fundCategory: "Trading--Leveraged Equity (Semiconductors)", factors: HOT, leverage: 3 });
    const r = computeRecipeScenario(db, findRecipe("semi_cycle_minus_15pct")!);
    expect(impact(r, "ZSEM3").changePercent).toBeCloseTo(-0.45, 10);
  });

  it.each([
    ["ai_capex_pause", { fundCategory: "US Sector Equity (Semiconductors)" }, -0.15],
    ["healthcare_reg_shock", { sector: "Healthcare", fundCategory: "Health" }, -0.12],
    ["oil_shock_10dollar", { sector: "Energy", fundCategory: "Equity Energy" }, 0.12],
    ["crypto_minus_30pct", { fundCategory: "Digital Assets (Crypto)" }, -0.3],
    ["rate_shock_up_25bp", { sector: "Real Estate", fundCategory: "Real Estate" }, -0.025],
  ] as const)("%s: the subject fund moves exactly the headline", (id, fields, headline) => {
    seed({ symbol: "ZFUND", type: "ETF", ...fields, factors: HOT });
    const r = computeRecipeScenario(db, findRecipe(id)!);
    expect(impact(r, "ZFUND").changePercent).toBeCloseTo(headline, 10);
  });

  // Superseded by owner ruling 2026-11-16 (26 = A): only a fund that IS the
  // subject is capped; a factor-only subject fund keeps its multiplier
  // (tests/compute/scenario-subject-fund-cap-structural-only.test.ts).
  it("a fund that is a subject only through a factor bucket keeps its factor multiplier", () => {
    seed({ symbol: "ZTHEME", type: "ETF", sector: "Technology", factors: { ai_exposure: "Very High" } });
    const r = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
    expect(impact(r, "ZTHEME").changePercent).toBeCloseTo(-0.15 * 1.4, 10);
  });
});

describe("K3b — a custom rate move carries the preset's equity rate leg", () => {
  const custom = (marketMove: number, rateMove?: number) =>
    computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove, rateMove });

  beforeEach(() => {
    seed({ symbol: "ZGROW", sector: "Technology", factors: { interest_rate_sensitive: "High", growth_vs_value: "Growth" } });
    seed({ symbol: "ZVAL", sector: "Industrials", factors: { interest_rate_sensitive: "Low", growth_vs_value: "Value" } });
    seed({ symbol: "ZREIT", type: "ETF", sector: "Real Estate", fundCategory: "Real Estate", factors: { interest_rate_sensitive: "Very High" } });
    seed({ symbol: "ZBOND", type: "Bond", durationYears: 5, price: 98, qty: 100 });
    seed({ symbol: "ZCASH", type: "Mutual Fund", fundCategory: "Cash Equivalent", factors: { interest_rate_sensitive: "High" } });
    seedPut("ZGROW", 90);
  });

  it("custom +25bp with no market move equals the +25bp preset, position by position", () => {
    const preset = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    const c = custom(0, 25);
    expect(c.estimatedChange).toBeCloseTo(preset.estimatedChange, 8);
    for (const p of preset.positionImpacts) {
      expect(impact(c, p.symbol).changePercent, p.symbol).toBeCloseTo(p.changePercent, 10);
    }
    expect(impact(c, "ZGROW").changePercent).toBeLessThan(0);
  });

  it("a 0/0 custom scenario is exactly zero", () => {
    const c = custom(0, 0);
    expect(c.estimatedChange).toBe(0);
    for (const p of c.positionImpacts) expect(p.estimatedChange, p.symbol).toBe(0);
  });

  it("the equity rate leg scales with the size and sign of the move", () => {
    const up25 = impact(custom(0, 25), "ZGROW").changePercent;
    expect(impact(custom(0, 100), "ZGROW").changePercent).toBeCloseTo(4 * up25, 10);
    expect(impact(custom(0, -25), "ZGROW").changePercent).toBeCloseTo(-up25, 10);
  });

  it("legs add: market and rate together equal market alone plus rate alone; rates 0 leaves the market-only result", () => {
    const both = custom(-0.1, 25);
    const market = custom(-0.1, 0);
    const marketOnly = custom(-0.1);
    const rate = custom(0, 25);
    for (const sym of ["ZGROW", "ZVAL", "ZREIT", "ZBOND", "ZCASH"]) {
      expect(impact(market, sym).changePercent, sym).toBe(impact(marketOnly, sym).changePercent);
      expect(impact(both, sym).changePercent, sym).toBeCloseTo(
        impact(market, sym).changePercent + impact(rate, sym).changePercent,
        12
      );
    }
    // The bond keeps its duration leg, never also an equity rate leg.
    expect(impact(rate, "ZBOND").changePercent).toBeCloseTo(Math.exp(-5 * 0.0025) - 1, 10);
    expect(impact(rate, "ZCASH").changePercent).toBe(0);
  });
});

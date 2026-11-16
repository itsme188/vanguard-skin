/**
 * Owner rulings 2026-11-16 for the scenario engine (Analysis Diagnostics).
 *
 * 26 = A: only a fund that IS the recipe's subject (a structural selector:
 * the slice's sector, or the fund's industry, fund category or domicile)
 * moves exactly the headline. A fund that is a subject only through its
 * factor buckets keeps its multiplier, as before the 2026-11-15 cap (the
 * build had capped a regional-bank fund in the rate preset and a broad tech
 * fund in the AI preset at 1.0x). Leveraged funds keep the existing rule:
 * leverage times the headline.
 *
 * 26b = A: a single-stock leveraged fund keeps moving leverage times the
 * headline, and the method text says it is approximated by the index move.
 *
 * Synthetic symbols; round prices.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  computeRecipeScenario,
  findRecipe,
  FUND_SUBJECT_NOTE,
  SCENARIO_RECIPES,
} from "@/lib/compute/scenario-recipes";
import { computeScenario, type ScenarioResult } from "@/lib/compute/scenarios";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";

type Buckets = Partial<Record<FactorColumn, string>>;

let db: Database.Database;
let nextId = 700;

function seed(opts: {
  symbol: string;
  name?: string;
  type?: string;
  sector?: string | null;
  industry?: string | null;
  fundCategory?: string | null;
  factors?: Buckets;
  leverage?: number | null;
}): void {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, industry, fund_category, geography, currency, leverage_factor)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'US', 'USD', ?)`
  ).run(
    id,
    opts.symbol,
    opts.name ?? `${opts.symbol} Synthetic`,
    opts.type ?? "ETF",
    opts.sector ?? null,
    opts.industry ?? null,
    opts.fundCategory ?? null,
    opts.leverage ?? null
  );
  if (opts.factors) {
    const f = opts.factors;
    db.prepare(
      `INSERT INTO security_factors (security_id, ${FACTOR_COLUMNS.join(", ")}) VALUES (?, ${FACTOR_COLUMNS.map(() => "?").join(", ")})`
    ).run(id, ...FACTOR_COLUMNS.map((c) => f[c] ?? null));
  }
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'tws')`).run(id, todayET());
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, '2026-04-30', 10, ?)`
  ).run(id, `cap-${opts.symbol}`);
}

function seedPut(underlying: string, strike: number): string {
  const id = nextId++;
  const symbol = `${underlying.padEnd(6)}270115P${String(strike * 1000).padStart(8, "0")}`;
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier, currency)
     VALUES (?, ?, 'Option', ?, ?, ?, 'PUT', 100, 'USD')`
  ).run(id, symbol, underlying, strike, addDays(todayET(), 180));
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 3, 'tws')`).run(id, todayET());
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, '2026-04-30', 1, ?)`
  ).run(id, `cap-${id}`);
  return symbol;
}

const HOT: Buckets = {
  tariff_exposure: "Very High",
  ai_exposure: "Very High",
  interest_rate_sensitive: "Very High",
  growth_vs_value: "Growth",
};

const impact = (r: ScenarioResult, symbol: string) => r.positionImpacts.find((p) => p.symbol === symbol)!;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 700;
});

describe("26 = A: only the subject fund is capped at the headline", () => {
  it("semis: the fund whose category IS semiconductors moves exactly the headline", () => {
    seed({ symbol: "ZSEMI", sector: "Technology", fundCategory: "US Sector Equity (Semiconductors)", factors: HOT });
    const r = computeRecipeScenario(db, findRecipe("semi_cycle_minus_15pct")!);
    expect(impact(r, "ZSEMI").changePercent).toBeCloseTo(-0.15, 12);
  });

  it("rate +25bp: a regional-bank fund, a subject only by its rate bucket, keeps 1.5x the headline", () => {
    seed({
      symbol: "ZBANK",
      sector: "Financials",
      fundCategory: "US Sector Equity (Regional Banks)",
      factors: { interest_rate_sensitive: "Very High", growth_vs_value: "Value" },
    });
    const r = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    expect(impact(r, "ZBANK").changePercent).toBeCloseTo(-0.025 * 1.5, 12);
  });

  it("rate +25bp: a real-estate fund (subject sector) is still capped at the headline", () => {
    seed({ symbol: "ZREIT", sector: "Real Estate", fundCategory: "US Sector Equity (Real Estate)", factors: HOT });
    const r = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    expect(impact(r, "ZREIT").changePercent).toBeCloseTo(-0.025, 12);
  });

  it("look-through: a real-estate fund with a small non-REIT sleeve still moves exactly the headline", () => {
    seed({ symbol: "ZREIT", sector: "Real Estate", factors: HOT });
    db.prepare(`INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES ('ZREIT', 'Real Estate', 95, '2026-04-30', 'manual'), ('ZREIT', 'Financials', 5, '2026-04-30', 'manual')`).run();
    const r = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    expect(impact(r, "ZREIT").changePercent).toBeCloseTo(-0.025, 12);
  });

  // Review fix B2 (2026-11-16) superseded "every sleeve keeps the fund's
  // multiplier": the REIT sleeve IS the subject, so that slice is capped at
  // the headline; the other sleeve keeps the fund's multiplier.
  it("look-through: a broad fund with a REIT sleeve has only that sleeve capped; the rest keeps the fund's multiplier", () => {
    seed({ symbol: "ZBROD", sector: "Diversified", factors: { interest_rate_sensitive: "Very High", growth_vs_value: "Value" } });
    db.prepare(`INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES ('ZBROD', 'Real Estate', 10, '2026-04-30', 'manual'), ('ZBROD', 'Industrials', 90, '2026-04-30', 'manual')`).run();
    const r = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    expect(impact(r, "ZBROD").changePercent).toBeCloseTo(-0.025 * (0.1 * 1 + 0.9 * 1.5), 12);
  });

  it("AI pause: a broad tech fund, a subject only by its AI bucket, keeps 1.4x the headline; a put on it reprices off that move", () => {
    seed({ symbol: "ZTECH", sector: "Technology", fundCategory: "US Sector Equity (Technology)", factors: { ai_exposure: "Very High" } });
    const put = seedPut("ZTECH", 90);
    const r = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
    expect(impact(r, "ZTECH").changePercent).toBeCloseTo(-0.15 * 1.4, 12);
    expect(impact(r, put).underlyingMove).toBeCloseTo(-0.15 * 1.4, 12);
  });

  it("AI pause: a fund whose category IS semiconductors is capped at the headline", () => {
    seed({ symbol: "ZSEMI", sector: "Technology", fundCategory: "US Sector Equity (Semiconductors)", factors: HOT });
    const r = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
    expect(impact(r, "ZSEMI").changePercent).toBeCloseTo(-0.15, 12);
  });

  it("a leveraged index fund keeps leverage x headline, even when it is a subject only by a factor bucket", () => {
    seed({ symbol: "ZTEC3", name: "ZZ DAILY TECH BULL 3X", sector: "Technology", factors: { ai_exposure: "Very High" }, leverage: 3 });
    const r = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
    expect(impact(r, "ZTEC3").changePercent).toBeCloseTo(3 * -0.15, 12);
  });
});

describe("26b = A: a single-stock leveraged fund moves leverage x headline", () => {
  it.each([
    ["semi_cycle_minus_15pct", { industry: "Semiconductors" }, -0.15],
    ["ai_capex_pause", {}, -0.15],
  ] as const)("%s: a 2x single-stock fund moves 2x the headline", (id, fields, headline) => {
    seed({ symbol: "ZZA2", name: "ZZ 2X LONG ZZA DAILY ETF", sector: "Technology", ...fields, factors: HOT, leverage: 2 });
    const r = computeRecipeScenario(db, findRecipe(id)!);
    expect(impact(r, "ZZA2").changePercent).toBeCloseTo(2 * headline, 12);
  });
});

describe("the custom +25bp rate move still equals the preset with a thematic fund held", () => {
  it("position by position, the factor-only bank fund at its own multiplier", () => {
    seed({
      symbol: "ZBANK",
      sector: "Financials",
      fundCategory: "US Sector Equity (Regional Banks)",
      factors: { interest_rate_sensitive: "Very High", growth_vs_value: "Value" },
    });
    seed({ symbol: "ZREIT", sector: "Real Estate", fundCategory: "US Sector Equity (Real Estate)", factors: HOT });
    seed({ symbol: "ZGROW", type: "Stock", sector: "Technology", factors: HOT });
    const preset = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    const custom = computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: 0, rateMove: 25 });
    for (const p of preset.positionImpacts) {
      expect(impact(custom, p.symbol).changePercent, p.symbol).toBeCloseTo(p.changePercent, 12);
    }
    expect(impact(custom, "ZBANK").changePercent).toBeCloseTo(-0.025 * 1.5, 12);
  });
});

describe("method text follows the rule", () => {
  it("every recipe's methodology carries the structural-only fund note, with the single-stock line", () => {
    // Wording revised by review fixes B4/B5 (2026-11-16): capped AT the headline.
    expect(FUND_SUBJECT_NOTE).toContain("A fund is capped at the headline where it is the subject");
    expect(FUND_SUBJECT_NOTE).toContain("only through its factor buckets keeps its factor multiplier");
    expect(FUND_SUBJECT_NOTE).toContain("leverage factor times its capped move");
    expect(FUND_SUBJECT_NOTE).toContain("single-stock leveraged fund is approximated by that index move");
    for (const r of SCENARIO_RECIPES) {
      expect(r.methodology, r.id).toContain(FUND_SUBJECT_NOTE);
      // The superseded blanket cap wording is gone.
      expect(r.methodology, r.id).not.toContain("never scaled past the headline");
      expect(r.methodology, r.id).not.toContain("Only single names move further");
    }
  });
});

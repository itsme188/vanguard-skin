/**
 * Review fixes to the 2026-11-16 subject-fund cap (unit FX3-SCENARIOS).
 *
 * B1: an option on a fund reprices off the move the FUND takes under the same
 * recipe. The equity path used to read the option's own symbol and type, so
 * the fund's sector look-through was skipped and the option's underlying move
 * differed from the fund's own move.
 *
 * B2: the subject cap is decided per look-through slice. A slice in one of the
 * recipe's subject sectors is capped at the headline; every slice is capped
 * (and every slice is the subject) when the fund matches structurally by
 * industry, fund category or domicile, or when at least
 * FUND_WHOLE_SUBJECT_SECTOR_SHARE of it sits in the subject sectors. The
 * fund's own sector LABEL no longer decides the cap for the whole fund.
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
  FUND_WHOLE_SUBJECT_SECTOR_SHARE,
  SCENARIO_RECIPES,
} from "@/lib/compute/scenario-recipes";
import { computeScenario, type ScenarioResult } from "@/lib/compute/scenarios";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";

type Buckets = Partial<Record<FactorColumn, string>>;

let db: Database.Database;
let nextId = 800;

function seed(opts: {
  symbol: string;
  name?: string;
  type?: string;
  sector?: string | null;
  industry?: string | null;
  fundCategory?: string | null;
  geography?: string;
  factors?: Buckets;
  leverage?: number | null;
  lookThrough?: Array<[string, number]>;
}): void {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, industry, fund_category, geography, currency, leverage_factor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?)`
  ).run(
    id,
    opts.symbol,
    opts.name ?? `${opts.symbol} Synthetic`,
    opts.type ?? "ETF",
    opts.sector ?? null,
    opts.industry ?? null,
    opts.fundCategory ?? null,
    opts.geography ?? "US",
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
  ).run(id, `fx3-${opts.symbol}`);
  for (const [sector, weight] of opts.lookThrough ?? []) {
    db.prepare(
      `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES (?, ?, ?, '2026-04-30', 'manual')`
    ).run(opts.symbol, sector, weight);
  }
}

/**
 * An option row as the broker sync stores it: its own sector is the
 * maintained copy of the underlying's, its fund category is the auto-classify
 * 'Options' label, and it has no factor row of its own.
 */
function seedOption(underlying: string, kind: "PUT" | "CALL", strike: number, ownSector: string | null): string {
  const id = nextId++;
  const symbol = `${underlying.padEnd(6)}270115${kind[0]}${String(strike * 1000).padStart(8, "0")}`;
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector, fund_category, underlying_symbol, strike_price, expiration_date, option_type, multiplier, currency)
     VALUES (?, ?, 'Option', ?, 'Options', ?, ?, ?, ?, 100, 'USD')`
  ).run(id, symbol, ownSector, underlying, strike, addDays(todayET(), 180), kind);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 3, 'tws')`).run(id, todayET());
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, '2026-04-30', 1, ?)`
  ).run(id, `fx3-${id}`);
  return symbol;
}

const impact = (r: ScenarioResult, symbol: string) => r.positionImpacts.find((p) => p.symbol === symbol)!;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 800;
});

const MIXED: Buckets = {
  tariff_exposure: "High",
  ai_exposure: "Moderate",
  interest_rate_sensitive: "High",
  growth_vs_value: "Growth",
  cyclical: "Moderate",
  international_exposure: "Moderate",
  regulatory_risk: "High",
  crypto_adjacent: "Low",
};

describe("B1: an option on a fund reprices off the fund's own move", () => {
  for (const withLookThrough of [true, false]) {
    it.each(SCENARIO_RECIPES.map((r) => r.id))(
      `%s (${withLookThrough ? "with" : "without"} look-through): put and call underlying move == the fund's move`,
      (id) => {
        seed({
          symbol: "ZTCF",
          sector: "Technology",
          industry: "Large-Cap Tech ETF",
          fundCategory: "US Large Cap Equity",
          factors: MIXED,
          lookThrough: withLookThrough
            ? [["Technology", 50], ["Healthcare", 20], ["Real Estate", 10], ["Energy", 10], ["Industrials", 10]]
            : undefined,
        });
        // The option's own sector label is deliberately different from the
        // fund's, as a stale copy would be: the fund's identity must win.
        const put = seedOption("ZTCF", "PUT", 90, "Communication Services");
        const call = seedOption("ZTCF", "CALL", 110, "Communication Services");
        const r = computeRecipeScenario(db, findRecipe(id)!);
        const fundMove = impact(r, "ZTCF").changePercent;
        expect(impact(r, put).underlyingMove, "put").toBeCloseTo(fundMove, 12);
        expect(impact(r, call).underlyingMove, "call").toBeCloseTo(fundMove, 12);
        expect(impact(r, put).subjectShare).toBeCloseTo(impact(r, "ZTCF").subjectShare ?? Number.NaN, 12);
      }
    );
  }

  it.each(SCENARIO_RECIPES.map((r) => r.id))("%s: leverage is applied once to an option on a 3x fund", (id) => {
    seed({
      symbol: "ZLV3",
      name: "ZZ DAILY TECH BULL 3X",
      sector: "Technology",
      factors: MIXED,
      leverage: 3,
      lookThrough: [["Technology", 70], ["Healthcare", 30]],
    });
    const put = seedOption("ZLV3", "PUT", 90, "Technology");
    const call = seedOption("ZLV3", "CALL", 110, "Technology");
    const r = computeRecipeScenario(db, findRecipe(id)!);
    const fundMove = impact(r, "ZLV3").changePercent;
    expect(impact(r, put).underlyingMove).toBeCloseTo(fundMove, 12);
    expect(impact(r, call).underlyingMove).toBeCloseTo(fundMove, 12);
  });

  it("semis preset: the measured case — a tech fund with a semis sleeve; the option no longer skips the sleeves", () => {
    seed({
      symbol: "ZTCF",
      sector: "Technology",
      factors: { tariff_exposure: "Moderate", ai_exposure: "High" },
      lookThrough: [["Technology", 60], ["Communication Services", 40]],
    });
    const put = seedOption("ZTCF", "PUT", 90, "Technology");
    const r = computeRecipeScenario(db, findRecipe("semi_cycle_minus_15pct")!);
    expect(impact(r, put).underlyingMove).toBeCloseTo(impact(r, "ZTCF").changePercent, 12);
  });

  it("the custom +25bp rate move reprices an option on a look-through fund off the same move as the preset", () => {
    seed({
      symbol: "ZTCF",
      sector: "Technology",
      factors: { interest_rate_sensitive: "High", growth_vs_value: "Growth" },
      lookThrough: [["Technology", 70], ["Real Estate", 30]],
    });
    const put = seedOption("ZTCF", "PUT", 90, "Technology");
    const preset = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    const custom = computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: 0, rateMove: 25 });
    for (const p of preset.positionImpacts) {
      expect(impact(custom, p.symbol).changePercent, p.symbol).toBeCloseTo(p.changePercent, 12);
    }
    expect(impact(preset, put).underlyingMove).toBeCloseTo(impact(preset, "ZTCF").changePercent, 12);
  });
});

describe("B2: the subject cap is decided per slice", () => {
  const HOT: Buckets = { interest_rate_sensitive: "Very High", growth_vs_value: "Growth" }; // blend 2.0

  it("a 30% real estate / 70% technology fund moves the same whether labelled Real Estate or Diversified", () => {
    const lt: Array<[string, number]> = [["Real Estate", 30], ["Technology", 70]];
    seed({ symbol: "ZLAB", sector: "Real Estate", factors: HOT, lookThrough: lt });
    seed({ symbol: "ZDIV", sector: "Diversified", factors: HOT, lookThrough: lt });
    const r = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    // Real estate sleeve capped at the headline; the technology sleeve keeps
    // the fund's 2.0x factor multiplier (a subject only by its buckets).
    const expected = -0.025 * (0.3 * 1 + 0.7 * 2);
    expect(impact(r, "ZLAB").changePercent).toBeCloseTo(expected, 12);
    expect(impact(r, "ZDIV").changePercent).toBeCloseTo(expected, 12);
  });

  it("a 99% real estate fund is the subject as a whole and moves exactly the headline", () => {
    seed({ symbol: "ZR99", sector: "Real Estate", factors: HOT, lookThrough: [["Real Estate", 99], ["Technology", 1]] });
    seed({ symbol: "ZR99C", sector: "Real Estate", lookThrough: [["Real Estate", 99], ["Financials", 1]] });
    const r = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    expect(impact(r, "ZR99").changePercent).toBeCloseTo(-0.025, 12);
    expect(impact(r, "ZR99").subjectShare).toBeCloseTo(1, 12);
    // No factor buckets at all: still the whole subject, still the headline.
    expect(impact(r, "ZR99C").changePercent).toBeCloseTo(-0.025, 12);
  });

  it("the whole-subject threshold is the named constant: just below it, the other sleeve takes its own path", () => {
    expect(FUND_WHOLE_SUBJECT_SECTOR_SHARE).toBe(0.95);
    seed({ symbol: "ZR94", sector: "Real Estate", lookThrough: [["Real Estate", 94], ["Financials", 6]] });
    const r = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    // No buckets: the financials sleeve takes a zero spillover.
    expect(impact(r, "ZR94").changePercent).toBeCloseTo(-0.025 * 0.94, 12);
  });

  it("a fund matching by industry is capped on every slice, whatever its look-through", () => {
    seed({
      symbol: "ZSMH",
      sector: "Technology",
      industry: "Semiconductor ETF",
      factors: { tariff_exposure: "Very High", ai_exposure: "Very High" },
      lookThrough: [["Technology", 80], ["Industrials", 20]],
    });
    const r = computeRecipeScenario(db, findRecipe("semi_cycle_minus_15pct")!);
    expect(impact(r, "ZSMH").changePercent).toBeCloseTo(-0.15, 12);
  });

  it("a single stock in a subject sector still scales past the headline", () => {
    seed({ symbol: "ZSTK", type: "Stock", sector: "Real Estate", factors: HOT });
    const r = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    expect(impact(r, "ZSTK").changePercent).toBeCloseTo(-0.025 * 2, 12);
  });
});

describe("B4/B5: the method text says what the engine does", () => {
  it("says capped AT the headline, never 'exactly', and the leverage floor", () => {
    expect(FUND_SUBJECT_NOTE).not.toMatch(/exactly/i);
    expect(FUND_SUBJECT_NOTE).toContain("capped at the headline");
    expect(FUND_SUBJECT_NOTE).toContain("at least 95%");
    expect(FUND_SUBJECT_NOTE).toContain("leverage factor times its capped move");
    expect(FUND_SUBJECT_NOTE).toContain("100%");
    expect(FUND_SUBJECT_NOTE).toContain("repriced off the move the fund itself takes");
    for (const r of SCENARIO_RECIPES) {
      expect(r.methodology, r.id).toContain(FUND_SUBJECT_NOTE);
    }
  });
});

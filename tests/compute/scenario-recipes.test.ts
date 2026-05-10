import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  SCENARIO_RECIPES,
  findRecipe,
  computeRecipeScenario,
  FACTOR_SHOCK_SENSITIVITIES,
} from "@/lib/compute/scenario-recipes";
import { computeScenario, PRESET_SCENARIOS } from "@/lib/compute/scenarios";

// Migration 002 seeds: 1=Vanguard Taxable, 2=Vanguard Roth IRA, 3=IBKR.

describe("SCENARIO_RECIPES catalog", () => {
  it("contains exactly 8 recipes", () => {
    expect(SCENARIO_RECIPES).toHaveLength(8);
  });

  it("every recipe has a methodology string", () => {
    for (const r of SCENARIO_RECIPES) {
      expect(r.methodology.length).toBeGreaterThan(20);
    }
  });

  it("findRecipe locates by id", () => {
    expect(findRecipe("rate_shock_up_25bp")).toBeDefined();
    expect(findRecipe("does-not-exist")).toBeUndefined();
  });

  it("FACTOR_SHOCK_SENSITIVITIES covers all 9 factor columns", () => {
    expect(Object.keys(FACTOR_SHOCK_SENSITIVITIES).sort()).toEqual([
      "ai_exposure",
      "crypto_adjacent",
      "cyclical",
      "geopolitical_onshoring",
      "growth_vs_value",
      "interest_rate_sensitive",
      "international_exposure",
      "regulatory_risk",
      "tariff_exposure",
    ]);
  });

  it("PRESET_SCENARIOS exposes all 8 recipes for back-compat", () => {
    expect(PRESET_SCENARIOS).toHaveLength(8);
    const ids = PRESET_SCENARIOS.map((s) => s.id).sort();
    const recipeIds = SCENARIO_RECIPES.map((r) => r.id).sort();
    expect(ids).toEqual(recipeIds);
  });
});

describe("computeRecipeScenario", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    // Three securities with explicit factor classifications.
    // NVDA  — Very-High AI exposure, Growth, Technology
    // JNJ   — No AI, Value, Healthcare, Moderate regulatory_risk
    // BOND1 — Bond with 5y duration, Moderate interest_rate_sensitive
    db.prepare(`INSERT INTO securities (id, symbol, security_type, sector, duration_years) VALUES (1, 'NVDA', 'Stock', 'Technology', NULL)`).run();
    db.prepare(`INSERT INTO securities (id, symbol, security_type, sector, duration_years) VALUES (2, 'JNJ', 'Stock', 'Healthcare', NULL)`).run();
    db.prepare(`INSERT INTO securities (id, symbol, security_type, sector, duration_years) VALUES (3, 'BOND1', 'Bond', NULL, 5)`).run();

    db.prepare(`
      INSERT INTO security_factors (security_id, ai_exposure, growth_vs_value, tariff_exposure, interest_rate_sensitive, regulatory_risk, cyclical, crypto_adjacent, international_exposure, geopolitical_onshoring)
      VALUES (1, 'Very High', 'Growth', 'Moderate', 'Low', 'Low', 'Moderate', 'No', 'Moderate', 'No')
    `).run();
    db.prepare(`
      INSERT INTO security_factors (security_id, ai_exposure, growth_vs_value, tariff_exposure, interest_rate_sensitive, regulatory_risk, cyclical, crypto_adjacent, international_exposure, geopolitical_onshoring)
      VALUES (2, 'No', 'Value', 'No', 'Moderate', 'Moderate', 'Low', 'No', 'High', 'No')
    `).run();
    db.prepare(`
      INSERT INTO security_factors (security_id, ai_exposure, growth_vs_value, tariff_exposure, interest_rate_sensitive, regulatory_risk, cyclical, crypto_adjacent, international_exposure, geopolitical_onshoring)
      VALUES (3, 'No', 'Blend', 'No', 'High', 'No', 'Defensive', 'No', 'No', 'No')
    `).run();

    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (1, ?, 1000, 'tws')`).run(today);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (2, ?, 150, 'tws')`).run(today);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (3, ?, 98, 'tws')`).run(today);

    // Holdings: 10 NVDA ($10k), 20 JNJ ($3k), 10000 face BOND1 ($9.8k)
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 1, '2026-04-30', 10, 'h-nvda')`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 2, '2026-04-30', 20, 'h-jnj')`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 3, '2026-04-30', 10000, 'h-bond')`).run();
  });

  it("ai_capex_pause: NVDA (Very High AI) takes the brunt; JNJ (No) is flat", () => {
    const result = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
    const nvda = result.positionImpacts.find((p) => p.symbol === "NVDA")!;
    const jnj = result.positionImpacts.find((p) => p.symbol === "JNJ")!;
    // NVDA: Very High (1.40) × -0.15 = -0.21
    expect(nvda.changePercent).toBeCloseTo(-0.21, 3);
    // JNJ: No (0) × -0.15 = 0
    expect(jnj.changePercent).toBeCloseTo(0, 4);
  });

  it("rate_shock_up_25bp: bond moves by duration × Δy/100", () => {
    const result = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    const bond = result.positionImpacts.find((p) => p.symbol === "BOND1")!;
    // shockMagnitude -0.025 → rateBpsMove = 25bp; duration 5y → -5 * 25 / 10000 = -0.0125
    expect(bond.changePercent).toBeCloseTo(-0.0125, 4);
  });

  it("rate_shock_up_25bp: growth equity takes both rate-sensitive and growth tilt hits", () => {
    const result = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    const nvda = result.positionImpacts.find((p) => p.symbol === "NVDA")!;
    // NVDA: interest_rate_sensitive=Low (0.10) × -0.025 + growth_vs_value=Growth (1.00) × 0.5 × -0.025
    //     = -0.0025 + -0.0125 = -0.015
    expect(nvda.changePercent).toBeCloseTo(-0.015, 4);
  });

  it("crypto_minus_30pct: non-crypto names are untouched", () => {
    const result = computeRecipeScenario(db, findRecipe("crypto_minus_30pct")!);
    for (const p of result.positionImpacts) {
      expect(p.changePercent).toBeCloseTo(0, 4); // none of our positions are crypto-adjacent
    }
    expect(result.estimatedChange).toBeCloseTo(0, 2);
  });

  it("tariff_escalation_10pt: tariff-exposed Moderate name (NVDA) hits, no-tariff name (JNJ) untouched", () => {
    const result = computeRecipeScenario(db, findRecipe("tariff_escalation_10pt")!);
    const nvda = result.positionImpacts.find((p) => p.symbol === "NVDA")!;
    const jnj = result.positionImpacts.find((p) => p.symbol === "JNJ")!;
    // NVDA: tariff_exposure=Moderate (0.60) × -0.08 + geopolitical_onshoring=No (0) × -0.4 × -0.08 = -0.048
    expect(nvda.changePercent).toBeCloseTo(-0.048, 3);
    expect(jnj.changePercent).toBeCloseTo(0, 4);
  });

  it("healthcare_reg_shock: Healthcare sector override applies regardless of regulatory bucket", () => {
    const result = computeRecipeScenario(db, findRecipe("healthcare_reg_shock")!);
    const jnj = result.positionImpacts.find((p) => p.symbol === "JNJ")!;
    // Healthcare sector override: -0.10
    expect(jnj.changePercent).toBeCloseTo(-0.10, 3);
  });

  it("oil_shock_10dollar: Energy sector positive, defaulting falls back to cyclical bucket", () => {
    // No energy holdings in our portfolio; verify Tech NVDA gets cyclical=Moderate hit
    const result = computeRecipeScenario(db, findRecipe("oil_shock_10dollar")!);
    const nvda = result.positionImpacts.find((p) => p.symbol === "NVDA")!;
    // NVDA: cyclical=Moderate (0.50) × -0.04 = -0.02
    expect(nvda.changePercent).toBeCloseTo(-0.02, 3);
  });

  it("usd_strength_5pct: high-international-exposure JNJ takes the hit", () => {
    const result = computeRecipeScenario(db, findRecipe("usd_strength_5pct")!);
    const jnj = result.positionImpacts.find((p) => p.symbol === "JNJ")!;
    // JNJ: international_exposure=High (1.00) × -0.05 = -0.05
    expect(jnj.changePercent).toBeCloseTo(-0.05, 3);
  });

  it("semi_cycle_minus_15pct: Tech sector floor of -10% applies", () => {
    const result = computeRecipeScenario(db, findRecipe("semi_cycle_minus_15pct")!);
    const nvda = result.positionImpacts.find((p) => p.symbol === "NVDA")!;
    // Technology sector override: -0.10
    expect(nvda.changePercent).toBeCloseTo(-0.10, 3);
  });

  it("portfolio P&L sums per-position impacts correctly", () => {
    const result = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
    const sum = result.positionImpacts.reduce((s, p) => s + p.estimatedChange, 0);
    expect(result.estimatedChange).toBeCloseTo(sum, 2);
    expect(result.estimatedChangePercent).toBeCloseTo(
      result.estimatedChange / result.currentPortfolioValue,
      4
    );
  });

  it("sorts biggestLosers by estimatedChange ascending", () => {
    const result = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
    for (let i = 1; i < result.biggestLosers.length; i++) {
      expect(result.biggestLosers[i].estimatedChange).toBeGreaterThanOrEqual(
        result.biggestLosers[i - 1].estimatedChange
      );
    }
  });

  it("respects accountId filter", () => {
    // Add an IBKR holding
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 1, ?, 5, 'h-ibkr-nvda')`).run(today);
    const vanguardOnly = computeRecipeScenario(db, findRecipe("ai_capex_pause")!, { accountId: 1 });
    const ibkrOnly = computeRecipeScenario(db, findRecipe("ai_capex_pause")!, { accountId: 3 });
    expect(vanguardOnly.currentPortfolioValue).toBeGreaterThan(ibkrOnly.currentPortfolioValue);
  });

  it("computeScenario dispatches to recipe when scenario.id matches", () => {
    const recipe = findRecipe("ai_capex_pause")!;
    const scenarioDef = PRESET_SCENARIOS.find((s) => s.id === "ai_capex_pause")!;
    const direct = computeRecipeScenario(db, recipe);
    const viaScenario = computeScenario(db, scenarioDef);
    expect(viaScenario.estimatedChangePercent).toBeCloseTo(direct.estimatedChangePercent, 6);
  });

  it("custom (non-recipe) scenario still flows through legacy path", () => {
    const customScenario = {
      id: "custom-test",
      name: "Custom Test",
      description: "test",
      category: "custom" as const,
      marketMove: -0.10,
    };
    const result = computeScenario(db, customScenario);
    // Legacy path uses beta heuristics; positions should be hit ~10% × beta
    expect(result.estimatedChangePercent).toBeLessThan(0);
  });

  it("zero-value scenario (shockMagnitude 0 conceptually) leaves portfolio flat", () => {
    // Simulate with crypto recipe on portfolio with no crypto exposure
    const result = computeRecipeScenario(db, findRecipe("crypto_minus_30pct")!);
    expect(result.estimatedChange).toBeCloseTo(0, 2);
    expect(result.estimatedPortfolioValue).toBeCloseTo(result.currentPortfolioValue, 2);
  });

  it("missing factor classification defaults bucket multiplier to 0", () => {
    // Insert a security with NULL factor row
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (4, 'NOCLASS', 'Stock', 'Industrials')`).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (4, ?, 50, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 4, ?, 100, 'h-noclass')`).run(today);
    const result = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
    const noclass = result.positionImpacts.find((p) => p.symbol === "NOCLASS")!;
    expect(noclass.changePercent).toBeCloseTo(0, 4);
  });
});

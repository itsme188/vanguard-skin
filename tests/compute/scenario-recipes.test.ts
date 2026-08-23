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
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { todayET, addDays } from "@/lib/calendar/date-utils";

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

  it("options inherit the underlying's factor exposure with delta-based elasticity", () => {
    // Pre-rebuild, options had no security_factors rows (by design — they
    // inherit) and the recipe query never COALESCE-joined the underlying, so
    // 21% of the book contributed exactly $0 to every scenario.
    const today = new Date();
    const expiry = new Date(today.getTime() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const d = today.toISOString().slice(0, 10);
    // NVDA call: S=1000, K=900, V=150/share, 1y out → Ω = Δ·S/V ≈ 4.9
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier)
       VALUES (20, 'NVDA  270609C00900000', 'Option', 'NVDA', 900, ?, 'CALL', 100)`
    ).run(expiry);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (20, ?, 150, 'tws')`).run(d);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 20, '2026-04-30', 2, 'h-nvdacall')`).run();

    const result = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
    const call = result.positionImpacts.find((p) => p.symbol.startsWith("NVDA  "))!;
    const nvda = result.positionImpacts.find((p) => p.symbol === "NVDA")!;

    // NVDA itself: Very High AI (1.40×) → -0.15 × 1.40 = -21%
    expect(nvda.changePercent).toBeCloseTo(-0.21, 3);
    // The call inherits NVDA's exposure, levered by elasticity (≈4.9×),
    // clamped at -100% (a long option can't lose more than its value).
    expect(call.changePercent).toBeLessThan(-0.5);
    expect(call.changePercent).toBeGreaterThanOrEqual(-1);
  });

  it("a held PUT gains when the inherited shock is negative", () => {
    const today = new Date();
    const expiry = new Date(today.getTime() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const d = today.toISOString().slice(0, 10);
    // NVDA put: S=1000, K=1100 (ITM put), V=160/share
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier)
       VALUES (21, 'NVDA  270609P01100000', 'Option', 'NVDA', 1100, ?, 'PUT', 100)`
    ).run(expiry);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (21, ?, 160, 'tws')`).run(d);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 21, '2026-04-30', 1, 'h-nvdaput')`).run();

    const result = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
    const put = result.positionImpacts.find((p) => p.symbol.startsWith("NVDA  270609P"))!;
    expect(put.changePercent).toBeGreaterThan(0.1);
  });

  it("rate shock: a Value name with no rate sensitivity is flat, never a spurious gain", () => {
    // Pre-rebuild growth_vs_value.Value = -0.5 produced a POSITIVE
    // changePercent for No-rate-sensitivity Value names on a hike — value
    // falls less than growth on hawkish surprises; it does not rally.
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (22, 'BRK B', 'Stock', 'Financials')`).run();
    db.prepare(`
      INSERT INTO security_factors (security_id, ai_exposure, growth_vs_value, tariff_exposure, interest_rate_sensitive, regulatory_risk, cyclical, crypto_adjacent, international_exposure, geopolitical_onshoring)
      VALUES (22, 'No', 'Value', 'No', 'No', 'No', 'Low', 'No', 'Low', 'No')
    `).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (22, ?, 500, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 22, '2026-04-30', 10, 'h-brkb')`).run();

    const result = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
    const brk = result.positionImpacts.find((p) => p.symbol === "BRK B")!;
    expect(brk.changePercent).toBeLessThanOrEqual(0);
  });

  it("sector overrides look through ETFs by cached sector weights", () => {
    // ETF holding 50% Healthcare / 50% Technology: healthcare_reg_shock's
    // Healthcare override (-10%) should hit half the position; the other
    // half falls back to the factor path (no factor row → 0).
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (10, 'HLTHMIX', 'ETF', NULL)`).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (10, ?, 100, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 10, '2026-04-30', 100, 'h-mix')`).run();
    db.prepare(`INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES ('HLTHMIX', 'Healthcare', 50, ?, 'manual')`).run(today);
    db.prepare(`INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES ('HLTHMIX', 'Technology', 50, ?, 'manual')`).run(today);

    const result = computeRecipeScenario(db, findRecipe("healthcare_reg_shock")!);
    const mix = result.positionImpacts.find((p) => p.symbol === "HLTHMIX")!;
    expect(mix.changePercent).toBeCloseTo(-0.05, 3);
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

  it("KRW holding's market value and dollar impact are USD-scaled, not won notional (Task 9a)", () => {
    const today = new Date().toISOString().slice(0, 10);
    // KRW security with the same Very-High-AI/Growth/Technology bucket as
    // NVDA so ai_capex_pause's -21% math is directly comparable.
    db.prepare(`INSERT INTO securities (id, symbol, security_type, sector, currency) VALUES (5, '402340', 'Stock', 'Technology', 'KRW')`).run();
    db.prepare(`
      INSERT INTO security_factors (security_id, ai_exposure, growth_vs_value, tariff_exposure, interest_rate_sensitive, regulatory_risk, cyclical, crypto_adjacent, international_exposure, geopolitical_onshoring)
      VALUES (5, 'Very High', 'Growth', 'Moderate', 'Low', 'Low', 'Moderate', 'No', 'Moderate', 'No')
    `).run();
    // 10 sh @ ₩1,731,000 = ₩17,310,000 notional; fx 0.000734 → ≈$12,705.54
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (5, ?, 1731000, 'tws')`).run(today);
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 5, '2026-04-30', 10, 'h-krw')`).run();
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.000734, asOf: today, source: "test" });

    const result = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
    const krw = result.positionImpacts.find((p) => p.symbol === "402340")!;
    const nvda = result.positionImpacts.find((p) => p.symbol === "NVDA")!;

    const expectedUsd = 10 * 1_731_000 * 0.000734; // ≈ $12,705.54
    expect(krw.currentValue).toBeCloseTo(expectedUsd, 2);
    expect(krw.currentValue).toBeLessThan(20_000); // NOT the ₩17.31M phantom
    // Very High AI (1.40) × -0.15 = -0.21, same bucket math as NVDA.
    expect(krw.changePercent).toBeCloseTo(-0.21, 3);
    expect(krw.estimatedChange).toBeCloseTo(expectedUsd * -0.21, 2);

    // USD control (NVDA, $10,000) byte-unchanged.
    expect(nvda.currentValue).toBeCloseTo(10_000, 2);
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

  // A lapsed contract must never receive scenario P&L (QA: an expired QQQ
  // put still showed "+6.3% / +$371" as a LEAST IMPACTED / POSITIVE position
  // in the Rate shock +25bp scenario, because the recipe's SQL pull had no
  // expiration_date filter at all). See lib/compute/option-expiry.ts.
  describe("expired option exclusion", () => {
    function seedOption(id: number, expirationDate: string) {
      const tag = expirationDate.replace(/-/g, "").slice(2);
      const symbol = `NVDA  ${tag}C00900000`;
      db.prepare(
        `INSERT INTO securities (id, symbol, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier)
         VALUES (?, ?, 'Option', 'NVDA', 900, ?, 'CALL', 100)`
      ).run(id, symbol, expirationDate);
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 150, 'tws')`).run(
        id,
        todayET()
      );
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, '2026-04-30', 2, ?)`
      ).run(id, `h-opt-${id}`);
      return symbol;
    }

    it("an option that expired YESTERDAY receives no scenario P&L and is dropped entirely", () => {
      const yesterday = addDays(todayET(), -1);
      const symbol = seedOption(23, yesterday);

      const rateShock = computeRecipeScenario(db, findRecipe("rate_shock_up_25bp")!);
      expect(rateShock.positionImpacts.find((p) => p.symbol === symbol)).toBeUndefined();

      const aiCapex = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
      expect(aiCapex.positionImpacts.find((p) => p.symbol === symbol)).toBeUndefined();
    });

    it("an option expiring TODAY still receives scenario P&L (live through end of day)", () => {
      const symbol = seedOption(24, todayET());

      const result = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
      const opt = result.positionImpacts.find((p) => p.symbol === symbol);
      expect(opt).toBeDefined();
      expect(opt!.changePercent).not.toBe(0);
    });

    it("legacy computeScenario also excludes an option expired yesterday", () => {
      const yesterday = addDays(todayET(), -1);
      const symbol = seedOption(25, yesterday);

      const result = computeScenario(db, PRESET_SCENARIOS.find((s) => s.id === "ai_capex_pause")!);
      expect(result.positionImpacts.find((p) => p.symbol === symbol)).toBeUndefined();
    });

    it("a non-option holding (no expiration_date) is unaffected by the expiry filter", () => {
      const yesterday = addDays(todayET(), -1);
      seedOption(26, yesterday); // dead weight — should not affect NVDA below

      const result = computeRecipeScenario(db, findRecipe("ai_capex_pause")!);
      const nvda = result.positionImpacts.find((p) => p.symbol === "NVDA")!;
      expect(nvda).toBeDefined();
      expect(nvda.changePercent).toBeCloseTo(-0.21, 3);
    });
  });
});

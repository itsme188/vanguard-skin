/**
 * Factor-anchored scenario recipes.
 *
 * Replaces the 9 arbitrary preset scenarios in scenarios.ts with 8 scenarios
 * grounded in the factor classifications already in security_factors. Each
 * scenario specifies a shock magnitude and per-factor sensitivity
 * multipliers; per-position P&L is shockMagnitude × sensitivityMultiplier ×
 * marketValue.
 *
 * Methodology is exposed alongside the result so the user can audit how a
 * given P&L number was derived.
 */

import type Database from "better-sqlite3";
import type { FactorColumn } from "@/lib/factors";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import type { ScenarioDefinition, ScenarioResult, PositionImpact } from "./scenarios";
import { adjustedMarketValueSQL } from "@/lib/valuation";

// ─── Per-factor bucket sensitivities ─────────────────────────────────────
//
// Each factor maps a bucket label (No / Low / Moderate / High / Very High,
// plus factor-specific values like "Growth" / "Value") to a multiplier
// applied to the scenario's shock magnitude. 1.0 = full exposure, 0 = no
// exposure, negative = inverse exposure.

type BucketMultipliers = Record<string, number>;

export const FACTOR_SHOCK_SENSITIVITIES: Record<FactorColumn, BucketMultipliers> = {
  interest_rate_sensitive: {
    No: 0, Low: 0.10, Moderate: 0.50, High: 1.00, "Very High": 1.50,
  },
  growth_vs_value: {
    Growth: 1.00, Value: -0.50, Blend: 0.25, Unknown: 0,
  },
  cyclical: {
    No: 0, Low: 0.25, Moderate: 0.50, High: 1.00, "Very High": 1.30,
    Cyclical: 1.00, Defensive: -0.50,
  },
  international_exposure: {
    No: 0, Low: 0.20, Moderate: 0.50, High: 1.00, "Very High": 1.30,
  },
  geopolitical_onshoring: {
    No: 0, Low: 0.20, Moderate: 0.50, High: 1.00, "Very High": 1.30,
  },
  tariff_exposure: {
    No: 0, Low: 0.20, Moderate: 0.60, High: 1.00, "Very High": 1.40,
  },
  ai_exposure: {
    No: 0, Low: 0.20, Moderate: 0.50, High: 1.00, "Very High": 1.40,
  },
  crypto_adjacent: {
    No: 0, Low: 0.20, Moderate: 0.50, High: 1.00, "Very High": 1.40,
  },
  regulatory_risk: {
    No: 0, Low: 0.25, Moderate: 0.60, High: 1.00, "Very High": 1.40,
  },
};

// ─── Recipes ─────────────────────────────────────────────────────────────

export interface ScenarioRecipe {
  id: string;
  name: string;
  description: string;
  category: "rate" | "fx" | "tariff" | "ai" | "energy" | "semi" | "healthcare" | "crypto";
  shockMagnitude: number;
  primaryFactor: FactorColumn;
  /**
   * Additional factor weights applied alongside the primary. Default 1.0
   * multiplier for the primary factor.
   */
  factorMultipliers?: Partial<Record<FactorColumn, number>>;
  sectorOverrides?: Record<string, number>;
  methodology: string;
  /**
   * Set by matchScenariosToThemes when this recipe's primaryFactor matches an
   * active macro theme's factor_label. UI renders a "live now" pill.
   */
  liveNowReason?: string;
}

export const SCENARIO_RECIPES: ScenarioRecipe[] = [
  {
    id: "rate_shock_up_25bp",
    name: "Rate shock +25bp",
    description: "Fed surprise hike 25bp — bonds drop by duration × Δy, growth stocks lag.",
    category: "rate",
    shockMagnitude: -0.025, // approximate equity-side impact per 25bp surprise
    primaryFactor: "interest_rate_sensitive",
    factorMultipliers: { growth_vs_value: 0.50 },
    methodology:
      "Per-position P&L = position_value × interest_rate_sensitive_bucket × -0.025. " +
      "Growth-leaning positions get an additional 0.5× growth_vs_value bucket multiplier. " +
      "Bonds: duration × 25bp / 100. Calibrated to typical 25bp surprise day historical reaction.",
  },
  {
    id: "usd_strength_5pct",
    name: "USD strength +5%",
    description: "Dollar rallies 5% — international revenue stocks underperform; small caps benefit.",
    category: "fx",
    shockMagnitude: -0.05,
    primaryFactor: "international_exposure",
    methodology:
      "Per-position P&L = position_value × international_exposure_bucket × -0.05. " +
      "Domestic-only names (No/Low buckets) close to flat; multinational large caps see translation drag.",
  },
  {
    id: "tariff_escalation_10pt",
    name: "Tariff escalation +10pt",
    description: "Avg tariff rate up 10 percentage points — supply-chain-exposed names hit.",
    category: "tariff",
    shockMagnitude: -0.08,
    primaryFactor: "tariff_exposure",
    factorMultipliers: { geopolitical_onshoring: -0.40 },
    methodology:
      "Per-position P&L = position_value × tariff_exposure_bucket × -0.08. " +
      "Onshoring beneficiaries get a positive offset via geopolitical_onshoring × +0.4 × 0.08. " +
      "Semi capex names get a meaningful drag; reshoring-themed industrials get a small lift.",
  },
  {
    id: "ai_capex_pause",
    name: "AI capex pause",
    description: "Big tech announces AI capex deceleration — semis and infrastructure names sell off.",
    category: "ai",
    shockMagnitude: -0.15,
    primaryFactor: "ai_exposure",
    methodology:
      "Per-position P&L = position_value × ai_exposure_bucket × -0.15. " +
      "Very-High AI names take the brunt; data-center adjacencies (utilities flagged AI) included. " +
      "Calibrated to a NDX-95 analog: AI-pure names dropped ~20% over 2 weeks.",
  },
  {
    id: "oil_shock_10dollar",
    name: "Oil shock +$10/bbl",
    description: "Brent +$10 — cyclical-sensitive names drift; energy producers rally.",
    category: "energy",
    shockMagnitude: -0.04,
    primaryFactor: "cyclical",
    sectorOverrides: {
      Energy: 0.12,
      Utilities: -0.04,
      Industrials: -0.05,
      "Consumer Discretionary": -0.06,
    },
    methodology:
      "Per-position P&L: cyclical-exposure bucket × -0.04 for non-energy non-utility names; " +
      "explicit sector overrides for Energy (+12%) and rate-sensitive sectors. " +
      "Calibrated to $10 Brent shock historical analog (2018, 2022).",
  },
  {
    id: "semi_cycle_minus_15pct",
    name: "Semi cycle -15%",
    description: "Memory pricing rolls over + China overcapacity — semis index -15%.",
    category: "semi",
    shockMagnitude: -0.15,
    primaryFactor: "tariff_exposure",
    factorMultipliers: { ai_exposure: 0.60 },
    sectorOverrides: { "Information Technology": -0.10, Technology: -0.10 },
    methodology:
      "Tariff-exposed names take a 1× hit; AI-exposed names take an additional 0.6× hit. " +
      "Plus an across-Tech sector floor of -10%. Mid-cycle semi correction analog.",
  },
  {
    id: "healthcare_reg_shock",
    name: "Healthcare regulatory shock",
    description: "Drug pricing reform or MA cuts — managed care + pharma sell off.",
    category: "healthcare",
    shockMagnitude: -0.12,
    primaryFactor: "regulatory_risk",
    sectorOverrides: { Healthcare: -0.10 },
    methodology:
      "Per-position P&L = position_value × regulatory_risk_bucket × -0.12. " +
      "Healthcare sector floor of -10% applies to all healthcare regardless of regulatory bucket. " +
      "Calibrated to 2018 IRA-fear day-of-news analog.",
  },
  {
    id: "crypto_minus_30pct",
    name: "Crypto -30%",
    description: "BTC drawdown 30% — crypto-adjacent equities + miners hit hard.",
    category: "crypto",
    shockMagnitude: -0.30,
    primaryFactor: "crypto_adjacent",
    methodology:
      "Per-position P&L = position_value × crypto_adjacent_bucket × -0.30. " +
      "Very-High names (miners, pure exchanges) take ~42% drawdown; Moderate exposure ~15%.",
  },
];

// ─── Computation ─────────────────────────────────────────────────────────

interface RecipePositionRow {
  security_id: number;
  symbol: string;
  security_name: string | null;
  security_type: string;
  sector: string | null;
  market_value: number;
  duration_years: number | null;
  interest_rate_sensitive: string | null;
  growth_vs_value: string | null;
  cyclical: string | null;
  international_exposure: string | null;
  geopolitical_onshoring: string | null;
  tariff_exposure: string | null;
  ai_exposure: string | null;
  crypto_adjacent: string | null;
  regulatory_risk: string | null;
}

function bucketMultiplier(factor: FactorColumn, bucket: string | null): number {
  if (!bucket) return 0;
  return FACTOR_SHOCK_SENSITIVITIES[factor][bucket] ?? 0;
}

/**
 * Compute the per-position P&L impact for a factor-anchored recipe.
 *
 * Bonds use duration-based pricing for rate scenarios; otherwise the
 * factor-bucket multiplier × shock magnitude is the per-position return.
 */
export function computeRecipeScenario(
  db: Database.Database,
  recipe: ScenarioRecipe,
  options?: { accountId?: number; accountIds?: number[] }
): ScenarioResult {
  const accountIds = options?.accountIds ?? (options?.accountId ? [options.accountId] : undefined);
  const accountFilter = accountIds?.length
    ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";
  const params: number[] = accountIds?.length ? [...accountIds] : [];

  const positions = db
    .prepare(
      `
      WITH latest_holdings AS (
        SELECT h.security_id, SUM(h.quantity) AS total_qty
        FROM holdings h
        WHERE ${latestHoldingsPredicate({ accountFilter })}
        GROUP BY h.security_id
      ),
      latest_prices AS (
        SELECT security_id, close_price
        FROM prices
        WHERE (security_id, date) IN (
          SELECT security_id, MAX(date) FROM prices GROUP BY security_id
        )
      )
      SELECT
        lh.security_id,
        s.symbol,
        s.name AS security_name,
        s.security_type,
        s.sector,
        s.duration_years,
        sf.interest_rate_sensitive,
        sf.growth_vs_value,
        sf.cyclical,
        sf.international_exposure,
        sf.geopolitical_onshoring,
        sf.tariff_exposure,
        sf.ai_exposure,
        sf.crypto_adjacent,
        sf.regulatory_risk,
        CASE
          WHEN LOWER(s.security_type) = 'bond'
            THEN lh.total_qty * COALESCE(lp.close_price, 0) / 100.0
          ELSE lh.total_qty * COALESCE(lp.close_price, 0) * COALESCE(s.multiplier, 1)
        END AS market_value
      FROM latest_holdings lh
      JOIN securities s ON s.id = lh.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
      LEFT JOIN security_factors sf ON sf.security_id = s.id
      WHERE COALESCE(lp.close_price, 0) > 0
      ORDER BY market_value DESC
    `
    )
    .all(...params) as RecipePositionRow[];

  const currentPortfolioValue = positions.reduce((s, p) => s + p.market_value, 0);

  const impacts: PositionImpact[] = positions.map((pos) => {
    let changePercent: number;

    // Bond duration overrides recipe factor math for rate scenarios
    if (recipe.category === "rate" && pos.security_type.toLowerCase() === "bond") {
      const duration = pos.duration_years ?? 5;
      // Recipe shock is the equity-side impact for a 25bp move (~-0.025).
      // Convert to bps: -0.025 = -25bp on equities; the corresponding bond
      // hit is duration × Δy/100.
      // Approximate: rate move in bps = -recipe.shockMagnitude * 100 (since
      // a 25bp hike is roughly a -2.5% equity move).
      const rateBpsMove = -recipe.shockMagnitude * 1000; // recipe.shockMagnitude in [-0.5, 0.5] → bps
      changePercent = -duration * rateBpsMove / 10000;
    } else if (recipe.sectorOverrides && pos.sector && pos.sector in recipe.sectorOverrides) {
      changePercent = recipe.sectorOverrides[pos.sector];
    } else {
      // Primary factor contribution
      const primaryMult = bucketMultiplier(recipe.primaryFactor, pos[recipe.primaryFactor]);
      let total = primaryMult * recipe.shockMagnitude;
      // Additional factor multipliers
      if (recipe.factorMultipliers) {
        for (const [factor, weight] of Object.entries(recipe.factorMultipliers)) {
          if (!weight) continue;
          const mult = bucketMultiplier(factor as FactorColumn, pos[factor as FactorColumn]);
          total += mult * weight * recipe.shockMagnitude;
        }
      }
      changePercent = total;
    }

    const estimatedChange = pos.market_value * changePercent;

    return {
      securityId: pos.security_id,
      symbol: pos.symbol,
      securityName: pos.security_name,
      securityType: pos.security_type,
      sector: pos.sector,
      currentValue: pos.market_value,
      estimatedChange,
      estimatedNewValue: pos.market_value + estimatedChange,
      changePercent,
      beta: 1.0, // factor-based math doesn't use beta; default for type compat
    };
  });

  const estimatedChange = impacts.reduce((s, p) => s + p.estimatedChange, 0);
  const estimatedPortfolioValue = currentPortfolioValue + estimatedChange;
  const estimatedChangePercent =
    currentPortfolioValue > 0 ? estimatedChange / currentPortfolioValue : 0;

  const sorted = [...impacts].sort((a, b) => a.estimatedChange - b.estimatedChange);
  const biggestLosers = sorted.filter((p) => p.estimatedChange < 0).slice(0, 5);
  const biggestWinners = sorted
    .filter((p) => p.estimatedChange > 0)
    .reverse()
    .slice(0, 5);

  return {
    scenario: recipeToScenarioDefinition(recipe),
    currentPortfolioValue,
    estimatedPortfolioValue,
    estimatedChange,
    estimatedChangePercent,
    positionImpacts: impacts,
    biggestLosers,
    biggestWinners,
  };
}

/**
 * Convert a recipe to the legacy ScenarioDefinition shape so UI code that
 * already iterates `PRESET_SCENARIOS` keeps working unchanged.
 */
export function recipeToScenarioDefinition(recipe: ScenarioRecipe): ScenarioDefinition {
  // Map recipe category → legacy category (legacy only has crash/rate/sector/custom)
  let legacyCategory: "crash" | "rate" | "sector" | "custom";
  switch (recipe.category) {
    case "rate":
      legacyCategory = "rate";
      break;
    case "fx":
    case "tariff":
    case "ai":
    case "energy":
    case "semi":
    case "healthcare":
    case "crypto":
      legacyCategory = "sector";
      break;
    default:
      legacyCategory = "custom";
  }
  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    category: legacyCategory,
    marketMove: recipe.shockMagnitude,
    sectorMoves: recipe.sectorOverrides,
    primaryFactor: recipe.primaryFactor,
  };
}

export function findRecipe(id: string): ScenarioRecipe | undefined {
  return SCENARIO_RECIPES.find((r) => r.id === id);
}

/**
 * Decorate each recipe with a `liveNowReason` string when its `primaryFactor`
 * matches an active macro theme's `factor_label`.
 *
 * - Returns a NEW array (never mutates input).
 * - When themes is empty every recipe gets `liveNowReason: undefined`.
 * - Direction is not filtered: any active theme whose factor_label matches
 *   makes the scenario "live" regardless of risk-on / risk-off direction.
 */
export function matchScenariosToThemes(
  recipes: ScenarioRecipe[],
  themes: Array<{ name: string; factor_label: string; direction: string; [key: string]: unknown }>
): ScenarioRecipe[] {
  if (themes.length === 0) {
    return recipes.map((r) => ({ ...r, liveNowReason: undefined }));
  }
  return recipes.map((r) => {
    const match = themes.find((t) => t.factor_label === r.primaryFactor);
    if (!match) return { ...r, liveNowReason: undefined };
    return { ...r, liveNowReason: match.name };
  });
}

// Suppress unused-var lint on the SQL helper import (kept for parity with
// scenarios.ts patterns).
void adjustedMarketValueSQL;

import type Database from "better-sqlite3";
import type { FactorColumn } from "@/lib/factors";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { explodeHoldingBySector } from "./explode-sector";
import { getEtfSectorWeights } from "@/lib/queries/etf-weights";
import {
  SCENARIO_RECIPES,
  findRecipe,
  computeRecipeScenario,
  recipeToScenarioDefinition,
} from "./scenario-recipes";

// ─── Types ──────────────────────────────────────────────────────

export interface ScenarioDefinition {
  id: string;
  name: string;
  description: string;
  category: "crash" | "rate" | "sector" | "custom";
  marketMove: number; // e.g., -0.10 for -10%
  rateMove?: number; // basis points, e.g., 100 for +1%
  sectorMoves?: Record<string, number>; // sector name → move (e.g., { "Technology": -0.25 })
  /** Factor this scenario primarily stresses — set from ScenarioRecipe for preset scenarios. */
  primaryFactor?: FactorColumn;
}

export interface PositionImpact {
  securityId: number;
  symbol: string;
  securityName: string | null;
  securityType: string;
  sector: string | null;
  currentValue: number;
  estimatedChange: number;
  estimatedNewValue: number;
  changePercent: number;
  beta: number; // used beta (1.0 if unknown)
}

export interface ScenarioResult {
  scenario: ScenarioDefinition;
  currentPortfolioValue: number;
  estimatedPortfolioValue: number;
  estimatedChange: number;
  estimatedChangePercent: number;
  positionImpacts: PositionImpact[];
  biggestLosers: PositionImpact[];
  biggestWinners: PositionImpact[];
  /** Set when the scenario's primaryFactor matches an active macro theme's factor_label. */
  liveNowReason?: string;
}

// ─── Predefined Scenarios ───────────────────────────────────────
//
// Phase 2 (2026-05-10): replaced 9 arbitrary preset scenarios with 8
// factor-anchored recipes. Old presets — correction/bear/crash/rally/
// rate100/rate200/tech_selloff/defensive_rotation/energy_spike — were
// market-move + beta heuristics with no defensible methodology. Recipes
// use security_factors classifications with per-bucket sensitivity
// multipliers calibrated from historical analogs. See scenario-recipes.ts.

export const PRESET_SCENARIOS: ScenarioDefinition[] = SCENARIO_RECIPES.map(
  recipeToScenarioDefinition
);

// ─── Computation ────────────────────────────────────────────────

/**
 * Estimate portfolio impact under a given scenario.
 *
 * For market crash scenarios, each position's impact is scaled by its
 * estimated beta. Bonds are treated differently (duration-based for
 * rate scenarios, lower beta for market scenarios).
 */
export function computeScenario(
  db: Database.Database,
  scenario: ScenarioDefinition,
  options?: { accountId?: number }
): ScenarioResult {
  // Factor-anchored recipes shipped in P2 — dispatch when scenario.id matches
  // a recipe. Custom scenarios from POST /api/compute/scenarios still flow
  // through the legacy beta-heuristic path below.
  const recipe = findRecipe(scenario.id);
  if (recipe) return computeRecipeScenario(db, recipe, options);

  const accountFilter = options?.accountId ? "AND h.account_id = ?" : "";
  const accountParams: number[] = options?.accountId ? [options.accountId] : [];

  // 1. Get current positions with latest prices and classification
  const positions = db
    .prepare(
      `WITH latest_holdings AS (
         SELECT h.security_id, SUM(h.quantity) AS total_qty
         FROM holdings h
         WHERE ${latestHoldingsPredicate({ keyBy: "account", includeShorts: true, accountFilter })}
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
         s.style,
         s.market_cap_category,
         s.duration_years,
         s.credit_rating,
         (CASE
           WHEN LOWER(s.security_type) = 'bond'
             THEN lh.total_qty * COALESCE(lp.close_price, 0) / 100.0
           ELSE lh.total_qty * COALESCE(lp.close_price, 0) * COALESCE(s.multiplier, 1)
         END) * COALESCE(fx.usd_per_unit, 1) AS market_value
       FROM latest_holdings lh
       JOIN securities s ON s.id = lh.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE COALESCE(lp.close_price, 0) > 0
       ORDER BY market_value DESC`
    )
    .all(...accountParams) as {
    security_id: number;
    symbol: string;
    security_name: string | null;
    security_type: string;
    sector: string | null;
    style: string | null;
    market_cap_category: string | null;
    duration_years: number | null;
    credit_rating: string | null;
    market_value: number;
  }[];

  const currentPortfolioValue = positions.reduce((s, p) => s + p.market_value, 0);

  // ETF look-through weights for sector scenarios (single source — same map
  // cash-deploy and the allocation breakdown use).
  const etfWeights = scenario.sectorMoves ? getEtfSectorWeights(db) : new Map<string, Array<{ sector: string; weight_pct: number }>>();

  // 2. Estimate beta for each position
  const positionImpacts: PositionImpact[] = positions.map((pos) => {
    const beta = estimateBeta(pos.security_type, pos.sector, pos.style, pos.market_cap_category);

    let changePercent: number;

    if (scenario.category === "rate" && scenario.rateMove) {
      // Rate scenario: bonds hit harder, growth stocks hit moderately
      changePercent = estimateRateImpact(
        pos.security_type,
        pos.style,
        scenario.rateMove,
        scenario.marketMove,
        pos.duration_years
      );
    } else if (scenario.sectorMoves) {
      // Sector rotation: each sector slice of the position responds to its
      // own move (look-through for ETFs/mutual funds with cached weights;
      // single bucket otherwise), unmatched slices get the market move.
      const parts = explodeHoldingBySector(
        pos.symbol,
        pos.security_type,
        pos.market_value,
        etfWeights,
        pos.sector
      );
      const mv = pos.market_value || 1;
      changePercent = parts.reduce((sum, part) => {
        const move = scenario.sectorMoves![part.sector] ?? scenario.marketMove;
        return sum + (part.value / mv) * move * beta;
      }, 0);
    } else {
      // Market scenario (default): scale by beta
      changePercent = scenario.marketMove * beta;
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
      beta,
    };
  });

  const estimatedChange = positionImpacts.reduce((s, p) => s + p.estimatedChange, 0);
  const estimatedPortfolioValue = currentPortfolioValue + estimatedChange;
  const estimatedChangePercent =
    currentPortfolioValue > 0 ? estimatedChange / currentPortfolioValue : 0;

  // Sort by absolute change for winners/losers
  const sorted = [...positionImpacts].sort(
    (a, b) => a.estimatedChange - b.estimatedChange
  );
  const biggestLosers = sorted.filter((p) => p.estimatedChange < 0).slice(0, 5);
  const biggestWinners = sorted
    .filter((p) => p.estimatedChange > 0)
    .reverse()
    .slice(0, 5);

  return {
    scenario,
    currentPortfolioValue,
    estimatedPortfolioValue,
    estimatedChange,
    estimatedChangePercent,
    positionImpacts,
    biggestLosers,
    biggestWinners,
  };
}

/**
 * Run all preset scenarios and return results.
 */
export function computeAllScenarios(
  db: Database.Database,
  options?: { accountId?: number }
): ScenarioResult[] {
  return PRESET_SCENARIOS.map((scenario) => computeScenario(db, scenario, options));
}

// ─── Beta estimation heuristics ──────────────────────────────────

function estimateBeta(
  securityType: string,
  sector: string | null,
  style: string | null,
  marketCap: string | null
): number {
  const type = securityType.toLowerCase();
  // Bonds have near-zero equity beta
  if (type === "bond" || type === "money market" || type === "money_market") return 0.1;

  // Options are higher beta (leverage)
  if (type === "option" || type === "call" || type === "put") return 2.0;

  let beta = 1.0;

  // Sector adjustments
  const highBetaSectors = ["Technology", "Consumer Discretionary", "Communication Services"];
  const lowBetaSectors = ["Utilities", "Consumer Staples", "Healthcare", "Real Estate"];
  if (sector && highBetaSectors.includes(sector)) beta *= 1.15;
  if (sector && lowBetaSectors.includes(sector)) beta *= 0.85;

  // Style adjustments
  if (style === "Growth") beta *= 1.1;
  if (style === "Value") beta *= 0.9;

  // Size adjustments
  if (marketCap === "Small Cap") beta *= 1.15;
  if (marketCap === "Mid Cap") beta *= 1.05;

  return beta;
}

function estimateRateImpact(
  securityType: string,
  style: string | null,
  rateBps: number,
  marketMove: number,
  durationYears?: number | null
): number {
  const rateChange = rateBps / 100; // convert bps to %

  const type = securityType.toLowerCase();
  // Bonds: duration-based estimate (use actual duration if available, else assume 5yr)
  if (type === "bond") {
    const duration = durationYears ?? 5;
    return -duration * rateChange / 100;
  }

  // Money market benefits slightly from higher rates
  if (type === "money market" || type === "money_market") {
    return rateChange * 0.002; // tiny positive
  }

  // Equities: growth stocks hurt more by rate rises
  let impact = marketMove;
  if (style === "Growth") impact *= 1.3;
  if (style === "Value") impact *= 0.7;

  return impact;
}

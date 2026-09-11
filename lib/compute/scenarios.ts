import type Database from "better-sqlite3";
import type { FactorColumn } from "@/lib/factors";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { explodeHoldingBySector } from "./explode-sector";
import { getEtfSectorWeights } from "@/lib/queries/etf-weights";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";
import {
  optionElasticity,
  isOptionSecurityType,
  leverUnderlyingMoveByElasticity,
  OPTION_PRICING_COLUMNS_SQL,
  OPTION_PRICING_JOINS_SQL,
} from "./option-elasticity";
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
  /**
   * Fraction of this position that sat on the scenario's SUBJECT path (the
   * sector / industry / factor cohort the scenario is about) rather than the
   * weaker spillover path. Set by the recipe engine only — the legacy
   * beta-heuristic path leaves it undefined. 0.5 = half an ETF's look-through
   * value was in the subject sector.
   */
  subjectShare?: number;
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
         WHERE ${latestHoldingsPredicate({ includeShorts: true, accountFilter })}
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
         -- Options inherit the UNDERLYING's classification (same COALESCE
         -- rule the recipe engine applies) so beta comes from the underlying
         -- instead of an option row's empty sector / style / size columns.
         COALESCE(s.sector, s_u.sector) AS sector,
         COALESCE(s.style, s_u.style) AS style,
         COALESCE(s.market_cap_category, s_u.market_cap_category) AS market_cap_category,
         s.fund_category,
         s.duration_years,
         s.credit_rating,
         s_u.security_type AS underlying_security_type,
${OPTION_PRICING_COLUMNS_SQL},
         ${adjustedMarketValueSQL("lh.total_qty", "COALESCE(lp.close_price, 0)", "s.security_type", "s.multiplier", "fx.usd_per_unit")} AS market_value
       FROM latest_holdings lh
       JOIN securities s ON s.id = lh.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
${OPTION_PRICING_JOINS_SQL}
       WHERE COALESCE(lp.close_price, 0) > 0
         AND ${liveOptionExpirationSql("s")}
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
    fund_category: string | null;
    duration_years: number | null;
    credit_rating: string | null;
    /** Security type of the option's underlying; null for non-options. */
    underlying_security_type: string | null;
    // Option pricing inputs (null for non-options) — see OPTION_PRICING_COLUMNS_SQL.
    strike_price: number | null;
    expiration_date: string | null;
    option_type: string | null;
    own_price: number | null;
    underlying_price: number | null;
    underlying_iv: number | null;
    market_value: number;
  }[];

  const currentPortfolioValue = positions.reduce((s, p) => s + p.market_value, 0);

  // ETF look-through weights for sector scenarios (single source — same map
  // cash-deploy and the allocation breakdown use).
  const etfWeights = scenario.sectorMoves ? getEtfSectorWeights(db) : new Map<string, Array<{ sector: string; weight_pct: number }>>();

  const riskFreeRate = getRiskFreeRate(db);

  // 2. Estimate beta for each position
  const positionImpacts: PositionImpact[] = positions.map((pos) => {
    const isOption = isOptionSecurityType(pos.security_type);
    // Cash-equivalent identity is single-sourced (fund_category-driven): the
    // live sweep funds are typed 'Mutual Fund', so a type-string test alone
    // handed them the full market shock.
    const isCashEquivalent = isCashEquivalentSecurity({
      security_type: pos.security_type,
      fund_category: pos.fund_category,
    });
    // An option is a claim on its underlying, so its beta is the UNDERLYING's
    // beta (leverage is applied separately, below, by signed elasticity).
    const beta = estimateBeta(
      isOption ? pos.underlying_security_type ?? "stock" : pos.security_type,
      pos.sector,
      pos.style,
      pos.market_cap_category,
      isCashEquivalent
    );

    // QA fix (2026-08-18): legs compose ADDITIVELY — changePercent =
    // marketLeg + rateLeg — instead of `category` switching the whole model.
    // marketLeg is always today's sector-aware beta logic; rateLeg is always
    // computed independently whenever scenario.rateMove is a nonzero finite
    // number, regardless of category or sectorMoves. Bond rateLeg uses a
    // convexity-aware exponential (exp(-D*dy) - 1) so it can never reach
    // -100% on its own, unlike the old unclamped linear duration estimate.
    let marketLeg: number;
    if (scenario.sectorMoves) {
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
      marketLeg = parts.reduce((sum, part) => {
        const move = scenario.sectorMoves![part.sector] ?? scenario.marketMove;
        return sum + (part.value / mv) * move * beta;
      }, 0);
    } else {
      // Market scenario (default): scale by beta
      marketLeg = scenario.marketMove * beta;
    }

    const rateLeg =
      typeof scenario.rateMove === "number" && Number.isFinite(scenario.rateMove) && scenario.rateMove !== 0
        ? estimateRateLeg(pos.security_type, scenario.rateMove, pos.duration_years, isCashEquivalent)
        : 0;

    // Both legs describe the move of the thing the position tracks — for an
    // option, that is its UNDERLYING.
    const underlyingMove = marketLeg + rateLeg;

    let changePercent: number;
    let reportedBeta = beta;
    if (isOption) {
      // QA fix (2026-09-11): options used to take a flat beta of 2.0 with no
      // put/call sign, so a -20% shock showed EVERY option at -40% — a held
      // put lost money in a crash. Lever the underlying's whole move by
      // signed elasticity Ω = Δ·S/V instead, exactly as the recipe engine
      // does (it applies Ω to the entire factor-derived underlying move,
      // rate component included; here the rate leg is 0 for an option, since
      // estimateRateLeg only prices bonds and cash off the position's own
      // type). Ω is negative for puts, so protection GAINS on a down shock.
      const omega = optionElasticity(pos, riskFreeRate);
      changePercent = leverUnderlyingMoveByElasticity(underlyingMove, omega);
      // Report the effective LEVERED exposure (signed): the UI prints this as
      // "β-9.2" next to the position, and a long put is genuinely short the
      // market at several times its notional sensitivity.
      reportedBeta = beta * omega;
    } else {
      // The UNDERLYING can't fall below zero, i.e. changePercent can't go
      // below -100% — for longs AND shorts. A short's direction is already
      // carried by its negative market_value; estimatedChange = market_value *
      // changePercent still flips sign correctly. Leaving shorts unclamped let
      // changePercent < -1 flip the sign of estimatedNewValue, implying a
      // short could earn more than its full notional proceeds. (The option
      // branch applies the same clamp inside leverUnderlyingMoveByElasticity.)
      changePercent = Math.max(underlyingMove, -1);
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
      beta: reportedBeta,
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

/**
 * Equity beta for the thing a position tracks.
 *
 * Options never arrive here with their OWN type — the caller passes the
 * underlying's classification and then levers the result by signed
 * elasticity (lib/compute/option-elasticity.ts). The old `option → 2.0`
 * branch is what made a long put lose 40% in a -20% shock.
 */
function estimateBeta(
  securityType: string,
  sector: string | null,
  style: string | null,
  marketCap: string | null,
  isCashEquivalent = false
): number {
  const type = securityType.toLowerCase();
  // Cash equivalents don't move with the equity market at all. Identity is
  // decided by isCashEquivalentSecurity at the call site — never a
  // hand-rolled money_market string list, which missed the live sweep funds
  // (typed 'Mutual Fund' with fund_category 'Cash Equivalent') and modelled
  // them as taking the full shock.
  if (isCashEquivalent) return 0;

  // Bonds have near-zero equity beta
  if (type === "bond") return 0.1;

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

/**
 * The rate leg of a shock — applied independently of `category`/sectorMoves
 * whenever scenario.rateMove is set. Equities have no rate leg here: the
 * old Growth 1.3 / Value 0.7 rate-category amplification of marketMove is
 * gone — that style sensitivity already lives inside estimateBeta via the
 * marketLeg, and folding it into rateLeg too would double-count it.
 */
function estimateRateLeg(
  securityType: string,
  rateBps: number,
  durationYears?: number | null,
  isCashEquivalent = false
): number {
  const type = securityType.toLowerCase();

  // Cash equivalents benefit slightly from higher rates — same magnitude as
  // the old literal 'money market' type branch, now keyed on the shared
  // fund_category-driven predicate so the live sweep funds qualify too.
  if (isCashEquivalent) return (rateBps / 100) * 0.002;

  // Bonds: convexity-aware exponential duration estimate (use actual
  // duration if available, else assume 5yr). exp(-D*dy) - 1 is smooth and
  // monotonic in dy and asymptotes to -1 without ever reaching it, unlike
  // the old linear -duration*rateChange/100 which could exceed -100%.
  if (type === "bond") {
    const duration = durationYears ?? 5;
    const dy = rateBps / 10000; // basis points -> decimal rate change
    return Math.exp(-duration * dy) - 1;
  }

  // Everything else: no independent rate leg.
  return 0;
}

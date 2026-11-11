/**
 * query_scenarios: the preset stress scenarios from `computeAllScenarios`,
 * called exactly as `app/api/compute/scenarios/route.ts` calls it
 * (`{ accountIds }`). The route's "live now" theme badge is a cached macro
 * read and is not a figure, so it is left out. No custom scenario here (F10).
 *
 * Scenario inputs are never defaulted (root CLAUDE.md): a position the engine
 * cannot model is listed in its unmodelled counts, and those counts are
 * returned as the engine gives them.
 */
import type Database from "better-sqlite3";
import { computeAllScenarios, PRESET_SCENARIOS, type PositionImpact, type ScenarioResult } from "@/lib/compute/scenarios";
import {
  ACCOUNT_NAME_FIELD,
  NO_ACCOUNT_IN_SCOPE,
  scopeBlock,
  type CompositeContext,
  type CompositeTool,
} from "./shared";

export const QUERY_SCENARIOS_NAME = "query_scenarios";

/** Movers per scenario in the all-presets answer, and with one scenario asked for. */
const MOVERS_ALL = 3;
const MOVERS_ONE = 10;

const presetList = PRESET_SCENARIOS.map((s) => `'${s.id}' (${s.name})`).join(", ");

const definition: CompositeTool["definition"] = {
  name: QUERY_SCENARIOS_NAME,
  description:
    `Preset stress scenarios run against current holdings, as the Analysis scenarios card shows them: for each preset, the scope's current value, the estimated change in dollars and as a fraction, the biggest losers and winners, and what the engine could not model (options it could not reprice, bonds with no derivable duration, rate hedges, leveraged and inverse funds), with counts and their share of the book. The presets are factor recipes: ${presetList}. There is no plain 'market down N%' preset and no custom scenario here; say so rather than estimating one from beta. Use for 'how exposed am I to X', 'what happens if rates rise'. Do NOT use for historical drawdown or volatility (use query_risk) or for option greeks (use query_options_greeks). Fractions are decimals (-0.05 = -5%).`,
  input_schema: {
    type: "object" as const,
    properties: {
      account_name: ACCOUNT_NAME_FIELD,
      scenario_id: {
        type: "string",
        enum: PRESET_SCENARIOS.map((s) => s.id),
        description: `Optional. One preset id; returns that scenario with its top ${MOVERS_ONE} losers and winners. Omit for every preset with the top ${MOVERS_ALL} each.`,
      },
    },
  },
};

function mover(p: PositionImpact) {
  return { symbol: p.symbol, change_usd: p.estimatedChange, change_fraction: p.changePercent };
}

function shapeScenario(r: ScenarioResult, movers: number) {
  return {
    id: r.scenario.id,
    name: r.scenario.name,
    ...(movers === MOVERS_ONE ? { description: r.scenario.description } : {}),
    current_value_usd: r.currentPortfolioValue,
    estimated_change_usd: r.estimatedChange,
    estimated_change_fraction: r.estimatedChangePercent,
    biggest_losers: r.biggestLosers.slice(0, movers).map(mover),
    biggest_winners: r.biggestWinners.slice(0, movers).map(mover),
    unmodelled: {
      options: { count: r.optionsUnmodelled.count, value_share: r.optionsUnmodelled.valueShare, unpriced_count: r.optionsUnmodelled.unpricedCount },
      bonds: { count: r.bondsUnmodelled.count, value_share: r.bondsUnmodelled.valueShare, funds_refused_default: r.bondsUnmodelled.fundCount },
      rate_hedges: { count: r.rateHedgesUnmodelled.count, value_share: r.rateHedgesUnmodelled.valueShare },
      leveraged_or_inverse: { count: r.leveragedFundsUnmodelled.count, value_share: r.leveragedFundsUnmodelled.valueShare },
    },
  };
}

function run(db: Database.Database, input: Record<string, unknown>, ctx: CompositeContext): unknown {
  const accountIds = ctx.accountIds;
  if (accountIds !== undefined && accountIds.length === 0) return NO_ACCOUNT_IN_SCOPE;
  const requested = typeof input.scenario_id === "string" ? input.scenario_id : undefined;
  if (requested !== undefined && !PRESET_SCENARIOS.some((s) => s.id === requested)) {
    return { error: `Unknown scenario_id '${requested}'. Valid ids: ${PRESET_SCENARIOS.map((s) => s.id).join(", ")}.` };
  }

  const results = computeAllScenarios(db, { accountIds });
  const chosen = requested ? results.filter((r) => r.scenario.id === requested) : results;
  const movers = requested ? MOVERS_ONE : MOVERS_ALL;

  return {
    as_of: ctx.today,
    scope: scopeBlock(db, accountIds),
    basis: "Current holdings (shorts included) at each security's latest stored price. Options past their expiration are left out; a non-option position with no price is not in the book the scenario runs on.",
    scenarios: chosen.map((r) => shapeScenario(r, movers)),
    units: {
      current_value_usd: "USD, gross book value the scenario runs on",
      estimated_change_usd: "USD, signed",
      estimated_change_fraction: "decimal fraction of current_value_usd",
      change_fraction: "decimal fraction of that position's value",
      value_share: "share of the book's gross value, 0-1; an unmodelled position's change is not in the estimate",
    },
    currency: "USD",
  };
}

export const queryScenariosTool: CompositeTool = { definition, run, acceptsScopeList: true };

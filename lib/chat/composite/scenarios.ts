/**
 * query_scenarios: the preset stress scenarios from `computeAllScenarios`,
 * called exactly as `app/api/compute/scenarios/route.ts` calls it
 * (`{ accountIds }`). The route's "live now" theme badge is a cached macro
 * read and is not a figure, so it is left out. No custom scenario here (F10).
 *
 * Scenario inputs are never defaulted (root CLAUDE.md): a position the engine
 * cannot model is counted and listed with the engine's own reason.
 */
import type Database from "better-sqlite3";
import { computeAllScenarios, PRESET_SCENARIOS, type PositionImpact, type ScenarioResult } from "@/lib/compute/scenarios";
import {
  ACCOUNT_NAME_FIELD,
  NO_ACCOUNT_IN_SCOPE,
  scopeBlock,
  takeList,
  type CompositeContext,
  type CompositeTool,
} from "./shared";

export const QUERY_SCENARIOS_NAME = "query_scenarios";

/** Movers per scenario in the all-presets answer, and with one scenario asked for. */
const MOVERS_ALL = 3;
const MOVERS_ONE = 10;
/** Unmodelled positions listed per scenario (all presets / one preset). */
const UNMODELLED_LIST_ALL = 5;
const UNMODELLED_LIST_ONE = 20;

const presetList = PRESET_SCENARIOS.map((s) => `'${s.id}' (${s.name})`).join(", ");

const definition: CompositeTool["definition"] = {
  name: QUERY_SCENARIOS_NAME,
  description:
    `Preset stress scenarios run against current holdings, as the Analysis scenarios card shows them: for each preset, the scope's net market value (shorts negative), the estimated change in dollars and as a fraction, the biggest losers and winners, and what the engine could not model (options it could not reprice, bonds with no derivable duration, rate hedges, leveraged and inverse funds), with counts, each share stated against its own base (option value, bond value, or the whole book), and each such position listed with the engine's reason. The presets are factor recipes: ${presetList}. There is no plain 'market down N%' preset and no custom scenario here; say so rather than estimating one from beta. Use for 'how exposed am I to X', 'what happens if rates rise'. Do NOT use for historical drawdown or volatility (use query_risk) or for option greeks (use query_options_greeks). Fractions are decimals (-0.05 = -5%).`,
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

/**
 * Up to `n` losers and winners, ordered as the engine orders its own top-5
 * lists (by estimated change), read from the engine's full `positionImpacts`
 * so a request for more than five is honoured. A sort, never a recompute.
 */
function topMovers(r: ScenarioResult, n: number) {
  const sorted = [...r.positionImpacts].sort((a, b) => a.estimatedChange - b.estimatedChange);
  return {
    losers: sorted.filter((p) => p.estimatedChange < 0).slice(0, n).map(mover),
    winners: sorted.filter((p) => p.estimatedChange > 0).reverse().slice(0, n).map(mover),
  };
}

/** Every position the engine left out of the estimate, with the engine's own reason. */
function unmodelledPositions(r: ScenarioResult): { symbol: string; kind: string; reason: string }[] {
  const out: { symbol: string; kind: string; reason: string }[] = [];
  for (const p of r.positionImpacts) {
    if (p.unmodelledReason) out.push({ symbol: p.symbol, kind: "option", reason: p.unmodelledReason });
    if (p.bondUnmodelledReason) {
      const isBond = (p.securityType ?? "").trim().toLowerCase() === "bond";
      out.push({ symbol: p.symbol, kind: isBond ? "bond" : "bond_fund", reason: p.bondUnmodelledReason });
    }
  }
  for (const symbol of r.rateHedgesUnmodelled.symbols) out.push({ symbol, kind: "rate_hedge", reason: "rate-hedge-fund" });
  for (const symbol of r.leveragedFundsUnmodelled.symbols) {
    out.push({ symbol, kind: "leveraged_or_inverse", reason: "leveraged-or-inverse-exposure" });
  }
  return out;
}

function shapeScenario(r: ScenarioResult, one: boolean) {
  const movers = topMovers(r, one ? MOVERS_ONE : MOVERS_ALL);
  const listMax = one ? UNMODELLED_LIST_ONE : UNMODELLED_LIST_ALL;
  const listed = takeList(unmodelledPositions(r), listMax, listMax);
  return {
    id: r.scenario.id,
    name: r.scenario.name,
    ...(one ? { description: r.scenario.description } : {}),
    net_market_value_usd: r.currentPortfolioValue,
    estimated_change_usd: r.estimatedChange,
    estimated_change_fraction: r.estimatedChangePercent,
    biggest_losers: movers.losers,
    biggest_winners: movers.winners,
    unmodelled: {
      options: {
        count: r.optionsUnmodelled.count,
        share_of_option_value: r.optionsUnmodelled.valueShare,
        unpriced_count: r.optionsUnmodelled.unpricedCount,
      },
      bonds: {
        count: r.bondsUnmodelled.count,
        share_of_bond_value: r.bondsUnmodelled.valueShare,
        funds_refused_default: r.bondsUnmodelled.fundCount,
      },
      rate_hedges: { count: r.rateHedgesUnmodelled.count, share_of_book: r.rateHedgesUnmodelled.valueShare },
      leveraged_or_inverse: { count: r.leveragedFundsUnmodelled.count, share_of_book: r.leveragedFundsUnmodelled.valueShare },
      positions: listed.rows,
      ...(listed.info.truncated ? { positions_list_info: listed.info } : {}),
    },
  };
}

function run(db: Database.Database, input: Record<string, unknown>, ctx: CompositeContext): unknown {
  const accountIds = ctx.accountIds;
  if (accountIds !== undefined && accountIds.length === 0) return NO_ACCOUNT_IN_SCOPE;
  const raw = input.scenario_id;
  const validIds = PRESET_SCENARIOS.map((s) => s.id).join(", ");
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    return { error: `scenario_id must be a string, one of: ${validIds}. Omit it for every preset.` };
  }
  const requested = typeof raw === "string" && raw !== "" ? raw : undefined;
  if (requested !== undefined && !PRESET_SCENARIOS.some((s) => s.id === requested)) {
    const shown = requested.length > 60 ? `${requested.slice(0, 60)}...` : requested;
    return { error: `Unknown scenario_id '${shown}'. Valid ids: ${validIds}.` };
  }

  const results = computeAllScenarios(db, { accountIds });
  const chosen = requested ? results.filter((r) => r.scenario.id === requested) : results;

  return {
    as_of: ctx.today,
    scope: scopeBlock(db, accountIds),
    basis: "Current holdings (shorts included) at each security's latest stored price. Options past their expiration are left out; a non-option position with no price is not in the book the scenario runs on.",
    scenarios: chosen.map((r) => shapeScenario(r, requested !== undefined)),
    units: {
      net_market_value_usd: "USD, signed net market value the scenario runs on (a short counts negative)",
      estimated_change_usd: "USD, signed",
      estimated_change_fraction: "decimal fraction of net_market_value_usd",
      change_fraction: "decimal fraction of that position's value",
      share_of_option_value: "unmodelled options' |value| over all options' |value|, 0-1",
      share_of_bond_value: "unmodelled individual bonds' |value| over all individual bonds' |value|, 0-1",
      share_of_book: "those funds' |value| over the book's gross |value|, 0-1",
      unmodelled: "an unmodelled position's change is not in the estimate; positions lists each with the engine's reason",
    },
    currency: "USD",
  };
}

export const queryScenariosTool: CompositeTool = { definition, run, acceptsScopeList: true };

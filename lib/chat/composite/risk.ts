/**
 * query_risk: portfolio risk figures from `computeRiskMetrics`, returned
 * unchanged. The engine is flow-adjusted and seam-bridged and reads the
 * risk-free rate through `getRiskFreeRate`.
 *
 * Window rule (2026-09-14 ruling, orchestrator ruling R6-2): the All Accounts
 * scope is called as the Analysis Diagnostics risk card calls it
 * (`app/api/compute/risk/route.ts`: default "common" floor, so scopes compare
 * over one period); any narrower scope as the Performance view's risk tiles
 * call it (`coverageFloor: "scope"`: the scope's own full history), because a
 * single-scope answer compares nothing across scopes.
 */
import type Database from "better-sqlite3";
import { computeRiskMetrics } from "@/lib/compute/risk";
import { isRiskFreeRateStale } from "@/lib/queries/risk-free-rate";
import {
  ACCOUNT_NAME_FIELD,
  NO_ACCOUNT_IN_SCOPE,
  readDateParam,
  scopeBlock,
  type CompositeContext,
  type CompositeTool,
} from "./shared";

export const QUERY_RISK_NAME = "query_risk";

const definition: CompositeTool["definition"] = {
  name: QUERY_RISK_NAME,
  description:
    "Portfolio risk figures: annualised volatility, Sharpe ratio, maximum and current drawdown (with peak and trough dates), the risk-free rate used, and concentration (Herfindahl index, top-5 share, top 5 positions by gross weight). Returns come from a flow-adjusted daily series (deposits and withdrawals are not returns) with statement-to-live source seams bridged; for All Accounts the window starts no earlier than the date every account has daily values (as the Analysis Diagnostics risk card measures it); for a narrower scope it uses that scope's own history (as the Performance view's risk tiles do). window.rule says which. Use for 'how risky is my portfolio', 'what was my worst drawdown', 'how concentrated am I'. Do NOT use for returns (use query_twr), for a stress test (use query_scenarios), for performance against SPY or what drove it (use query_performance_vs_benchmark), or for option greeks (use query_options_greeks). Beta is not part of this engine. Fractions are decimals (0.15 = 15%).",
  input_schema: {
    type: "object" as const,
    properties: {
      account_name: ACCOUNT_NAME_FIELD,
      start_date: {
        type: "string",
        description: "Optional window start, a real date YYYY-MM-DD, on or before end_date. Omit for the whole history the window rule allows.",
      },
      end_date: {
        type: "string",
        description: "Optional window end, a real date YYYY-MM-DD. Omit for the latest daily value.",
      },
    },
  },
};

/**
 * Whether `getRiskFreeRate` read the stored FRED rate or fell back to its
 * built-in default. Same validity test as that reader (a stored value is used
 * only when it parses to a rate in (0, 0.25]); staleness from
 * `isRiskFreeRateStale`.
 */
function riskFreeRateSource(db: Database.Database): { kind: "stored" | "default"; stale?: boolean; note: string } {
  let raw: string | undefined;
  try {
    raw = (db.prepare("SELECT value FROM settings WHERE key = 'risk_free_rate'").get() as { value: string } | undefined)?.value;
  } catch {
    raw = undefined;
  }
  const parsed = raw === undefined ? NaN : parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 0.25) {
    return { kind: "default", note: "No usable stored rate: the engine's built-in default was used, not a market rate." };
  }
  let stale = true;
  try {
    stale = isRiskFreeRateStale(db);
  } catch {
    stale = true;
  }
  return {
    kind: "stored",
    stale,
    note: stale ? "Stored 3-month Treasury rate (FRED DGS3MO), older than 48 hours." : "Stored 3-month Treasury rate (FRED DGS3MO).",
  };
}

function run(db: Database.Database, input: Record<string, unknown>, ctx: CompositeContext): unknown {
  const accountIds = ctx.accountIds;
  if (accountIds !== undefined && accountIds.length === 0) return NO_ACCOUNT_IN_SCOPE;
  const start = readDateParam(input.start_date, "start_date");
  if (start.error) return { error: start.error };
  const end = readDateParam(input.end_date, "end_date");
  if (end.error) return { error: end.error };
  const startDate = start.value;
  const endDate = end.value;
  if (startDate && endDate && startDate > endDate) {
    return { error: `start_date ${startDate} is after end_date ${endDate}.` };
  }

  // All accounts: the Diagnostics card's call. A narrower scope: the
  // Performance tiles' call.
  const coverageFloor = accountIds === undefined ? "common" : "scope";
  const m = computeRiskMetrics(db, { startDate, endDate, accountIds, coverageFloor });

  const withheld: Record<string, string> = {};
  if (m.volatility === null || m.sharpeRatio === null) {
    withheld.volatility_and_sharpe =
      m.dataPoints < 30
        ? `Not computed: ${m.dataPoints} daily values in the window; the engine needs at least 30.`
        : "Not computed: too few usable daily returns in the window (the engine needs 20).";
  }
  if (m.maxDrawdown === null) withheld.max_drawdown = "None: the series never fell below an earlier peak, or has under 2 points.";
  if (m.herfindahl === null) withheld.concentration = "No priced position in scope.";

  return {
    as_of: ctx.today,
    scope: scopeBlock(db, accountIds),
    window: {
      series_start: m.seriesStart,
      series_end: m.seriesEnd,
      data_points: m.dataPoints,
      requested_start: startDate ?? null,
      requested_end: endDate ?? null,
      rule:
        coverageFloor === "common"
          ? "common floor (Analysis Diagnostics risk card): starts no earlier than the date every account has daily values, so scopes compare over one period"
          : "scope's own history (Performance view risk tiles): starts at this scope's first full-coverage day, not floored by other accounts",
      note: "Daily values summed over the scope on days every account in it has a value. series_start is the first day actually used.",
    },
    volatility: m.volatility,
    sharpe_ratio: m.sharpeRatio,
    risk_free_rate: m.riskFreeRate,
    risk_free_rate_source: riskFreeRateSource(db),
    max_drawdown: m.maxDrawdown
      ? {
          fraction: m.maxDrawdown.percent,
          peak_date: m.maxDrawdown.peakDate,
          trough_date: m.maxDrawdown.troughDate,
          net_external_flows_in_window_usd: m.maxDrawdown.netFlowsInWindow,
        }
      : null,
    current_drawdown: m.currentDrawdown
      ? { fraction: m.currentDrawdown.percent, peak_date: m.currentDrawdown.peakDate }
      : null,
    seam_days_bridged: m.seamDaysBridged,
    concentration: {
      herfindahl: m.herfindahl,
      top5_share: m.top5Concentration,
      position_count: m.positionCount,
      top5: m.top5Positions.map((p) => ({
        symbol: p.symbol,
        market_value_usd: p.marketValue,
        gross_weight: p.weight,
      })),
      note: "Current holdings. Weights are gross: |value| over the sum of |value|, shorts included; a short's market value is negative.",
    },
    ...(Object.keys(withheld).length > 0 ? { withheld } : {}),
    units: {
      volatility: "annualised standard deviation of daily log returns, decimal fraction",
      sharpe_ratio: "ratio: (annualised mean daily return - risk_free_rate) / volatility",
      risk_free_rate:
        "annual rate, decimal fraction; risk_free_rate_source says whether it is the stored 3-month Treasury rate (FRED DGS3MO) or the engine's built-in default",
      drawdown_fraction: "decline from the peak of the flow-adjusted index, decimal fraction",
      herfindahl: "sum of squared gross weights, 0-1 (1 = one position)",
      top5_share: "gross weight of the five largest positions, 0-1",
    },
    currency: "USD",
  };
}

export const queryRiskTool: CompositeTool = { definition, run, acceptsScopeList: true };

/**
 * query_risk: portfolio risk figures from `computeRiskMetrics`, called exactly
 * as the Analysis risk card's route calls it (`app/api/compute/risk/route.ts`:
 * `{ startDate, endDate, accountIds }`, default "common" coverage floor).
 * The engine is flow-adjusted and seam-bridged and reads the risk-free rate
 * through `getRiskFreeRate`; this wrapper returns its figures unchanged.
 */
import type Database from "better-sqlite3";
import { computeRiskMetrics } from "@/lib/compute/risk";
import {
  ACCOUNT_NAME_FIELD,
  NO_ACCOUNT_IN_SCOPE,
  readIsoDate,
  scopeBlock,
  type CompositeContext,
  type CompositeTool,
} from "./shared";

export const QUERY_RISK_NAME = "query_risk";

const definition: CompositeTool["definition"] = {
  name: QUERY_RISK_NAME,
  description:
    "Portfolio risk figures, as the Analysis risk card shows them: annualised volatility, Sharpe ratio, maximum and current drawdown (with peak and trough dates), the risk-free rate used, and concentration (Herfindahl index, top-5 share, top 5 positions by gross weight). Returns come from a flow-adjusted daily series (deposits and withdrawals are not returns) with statement-to-live source seams bridged; the window starts no earlier than the date every account has daily values (the comparison floor). Use for 'how risky is my portfolio', 'what was my worst drawdown', 'how concentrated am I'. Do NOT use for returns (use query_twr), for a stress test (use query_scenarios), for performance against SPY or what drove it (use query_performance_vs_benchmark), or for option greeks (use query_options_greeks). Beta is not part of this engine. Fractions are decimals (0.15 = 15%).",
  input_schema: {
    type: "object" as const,
    properties: {
      account_name: ACCOUNT_NAME_FIELD,
      start_date: {
        type: "string",
        description: "Optional window start, YYYY-MM-DD. Omit for the whole history (from the comparison floor).",
      },
      end_date: {
        type: "string",
        description: "Optional window end, YYYY-MM-DD. Omit for the latest daily value.",
      },
    },
  },
};

function run(db: Database.Database, input: Record<string, unknown>, ctx: CompositeContext): unknown {
  const accountIds = ctx.accountIds;
  if (accountIds !== undefined && accountIds.length === 0) return NO_ACCOUNT_IN_SCOPE;
  const startDate = readIsoDate(input.start_date);
  const endDate = readIsoDate(input.end_date);

  const m = computeRiskMetrics(db, { startDate, endDate, accountIds });

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
      note: "Daily values summed over the scope on days every account in it has a value. The start is floored at the date every account has daily values, so scopes compare over one period.",
    },
    volatility: m.volatility,
    sharpe_ratio: m.sharpeRatio,
    risk_free_rate: m.riskFreeRate,
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
      risk_free_rate: "annual rate, decimal fraction (3-month Treasury, FRED DGS3MO)",
      drawdown_fraction: "decline from the peak of the flow-adjusted index, decimal fraction",
      herfindahl: "sum of squared gross weights, 0-1 (1 = one position)",
      top5_share: "gross weight of the five largest positions, 0-1",
    },
    currency: "USD",
  };
}

export const queryRiskTool: CompositeTool = { definition, run, acceptsScopeList: true };

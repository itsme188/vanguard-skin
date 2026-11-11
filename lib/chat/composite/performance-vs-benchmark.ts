/**
 * query_performance_vs_benchmark: the Performance view's benchmark curve,
 * period attribution and month view, built from the same engines with the
 * same arguments as `app/dashboard/components/PerformanceView.tsx`:
 *
 * - window: `resolvePerformanceWindow` with `latestStatementAnchor` over the
 *   whole scope (as `query_twr` and the page do);
 * - portfolio vs SPY: `buildEquityCurveData` over the scope's flow-adjusted,
 *   seam-bridged daily series, floored at the first statement
 *   (`firstStatementAnchorForCurve` / `curveFloorDate`), against SPY closes
 *   from `benchmark_prices` over the same window (the page's own read);
 * - attribution: `computePeriodAttribution(db, scope, start, end, "SPY")`;
 * - month: `computeMonthlyPerformance(db, scope, month)`, the month defaulting
 *   to the newest of `listStatementMonths`.
 *
 * `computeBenchmarkComparison` (lib/compute/benchmark.ts), named in the plan,
 * is NOT used: it measures the portfolio from raw daily values (a deposit
 * reads as a return, against root CLAUDE.md's flow-adjusted rule), takes one
 * account or all, and no dashboard surface renders it. The page's curve is
 * the comparison the owner sees.
 */
import type Database from "better-sqlite3";
import {
  resolvePerformanceWindow,
  latestStatementAnchor,
  type PerformancePeriod,
} from "@/lib/compute/performance-window";
import { buildEquityCurveData } from "@/lib/compute/equity-curve";
import { curveFloorDate, firstStatementAnchorForCurve } from "@/lib/compute/equity-curve-floor";
import { getDailyValuationsForAccounts } from "@/lib/queries/daily-valuations";
import { fetchNetFlowsByDate, fetchAnchorSourceSeamDates } from "@/lib/compute/flow-adjusted";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";
import { computeMonthlyPerformance, listStatementMonths } from "@/lib/compute/monthly-performance";
import {
  ACCOUNT_NAME_FIELD,
  NO_ACCOUNT_IN_SCOPE,
  readIsoDate,
  scopeBlock,
  type CompositeContext,
  type CompositeTool,
} from "./shared";

export const QUERY_PERFORMANCE_VS_BENCHMARK_NAME = "query_performance_vs_benchmark";

const BENCHMARK_SYMBOL = "SPY";
const TOP_N = 5;
const MONTHS_LISTED = 12;
const PERIODS: readonly PerformancePeriod[] = ["ytd", "1y", "3y", "5y", "all"];

const definition: CompositeTool["definition"] = {
  name: QUERY_PERFORMANCE_VS_BENCHMARK_NAME,
  description:
    "Performance against SPY and what drove it, as the Analysis Performance view shows them, over one window: (1) the portfolio's flow-adjusted growth index against SPY's, both based at 100 on the first plotted day (the equity curve); (2) period attribution: top 5 contributing and detracting positions, top 5 sectors, and the split of the portfolio's daily-series return into a beta part (moving with SPY) and an alpha part, with the dates that regression covered; (3) one statement month's return per account and blended (Modified Dietz, from statements). Use for 'am I beating the S&P', 'what drove my returns', 'how did last month go'. Do NOT use for the headline time-weighted or money-weighted return (use query_twr with the same period: its figure is chained from statements and differs from the daily-series figures here), for risk (use query_risk), or for today's moves (use query_market_snapshot). Fractions are decimals (0.05 = 5%).",
  input_schema: {
    type: "object" as const,
    properties: {
      account_name: ACCOUNT_NAME_FIELD,
      period: {
        type: "string",
        enum: [...PERIODS],
        description:
          "Window for the curve and the attribution: 'ytd' (default), '1y', '3y', '5y' (each a full span ending at the scope's last statement), or 'all'.",
      },
      month: {
        type: "string",
        description:
          "Optional month-end date (YYYY-MM-DD, e.g. 2026-09-30) for the month view. Default: the newest month with a statement in scope. available_months lists the newest 12.",
      },
    },
  },
};

function run(db: Database.Database, input: Record<string, unknown>, ctx: CompositeContext): unknown {
  const accountIds = ctx.accountIds;
  if (accountIds !== undefined && accountIds.length === 0) return NO_ACCOUNT_IN_SCOPE;
  const today = ctx.today;
  const period: PerformancePeriod = PERIODS.includes(input.period as PerformancePeriod)
    ? (input.period as PerformancePeriod)
    : "ytd";

  // ── Window (PerformanceView: one window for the whole page) ──
  const perfWindow = resolvePerformanceWindow(period, {
    today,
    lastStatementAnchor: latestStatementAnchor(db, accountIds, today),
  });
  const dailyEnd = perfWindow.endDate;
  const effectiveStart = perfWindow.startDate ?? "2000-01-01";

  // ── Portfolio vs SPY (the page's equity curve) ──
  const curveFloor = firstStatementAnchorForCurve(db, accountIds, effectiveStart, dailyEnd);
  const curveSeriesStart = curveFloorDate(effectiveStart, curveFloor);
  const dailyVals = getDailyValuationsForAccounts(db, accountIds, {
    startDate: curveSeriesStart,
    endDate: dailyEnd,
    fullCoverageOnly: true,
  });
  const benchmarkRows = db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = ? AND date BETWEEN ? AND ?
       ORDER BY date ASC`,
    )
    .all(BENCHMARK_SYMBOL, effectiveStart, dailyEnd) as { date: string; close_price: number }[];
  const seriesFrom = dailyVals.length >= 2 ? dailyVals[0].valuation_date : null;
  const seriesTo = dailyVals.length >= 2 ? dailyVals[dailyVals.length - 1].valuation_date : null;
  const flows = seriesFrom && seriesTo ? fetchNetFlowsByDate(db, accountIds, seriesFrom, seriesTo) : [];
  const seamDates = seriesFrom && seriesTo ? fetchAnchorSourceSeamDates(db, accountIds, seriesFrom, seriesTo) : [];
  const curve = buildEquityCurveData(dailyVals, benchmarkRows, flows, seamDates, curveFloor);
  const first = curve[0];
  const last = curve[curve.length - 1];

  // ── Attribution ──
  const attribution = computePeriodAttribution(db, accountIds, effectiveStart, dailyEnd, BENCHMARK_SYMBOL);

  // ── Month view ──
  const statementMonths = listStatementMonths(db, accountIds);
  const requestedMonth = readIsoDate(input.month);
  const activeMonth =
    requestedMonth && statementMonths.includes(requestedMonth) ? requestedMonth : (statementMonths[0] ?? null);
  const monthly = activeMonth === null ? null : computeMonthlyPerformance(db, accountIds, activeMonth);

  return {
    as_of: today,
    scope: scopeBlock(db, accountIds),
    window: {
      period,
      start: perfWindow.startDate ?? null,
      end: perfWindow.endDate,
      ends_at_last_statement: perfWindow.endsAtStatement,
    },
    vs_benchmark: first && last
      ? {
          benchmark: BENCHMARK_SYMBOL,
          first_date: first.date,
          last_date: last.date,
          days_plotted: curve.length,
          portfolio_index_end: last.portfolio,
          benchmark_index_end: last.benchmark,
          portfolio_return: last.portfolio / 100 - 1,
          benchmark_return: last.benchmark / 100 - 1,
          note: "Both indexed to 100 on first_date, the first day with a portfolio value and an SPY close. The portfolio side is flow-adjusted and seam-bridged; it starts no earlier than the scope's first statement. This is not the time-weighted return (query_twr).",
        }
      : {
          benchmark: BENCHMARK_SYMBOL,
          withheld: "Not enough daily values or SPY closes in this window to compare (two days of each are needed).",
        },
    attribution: {
      window: { start: effectiveStart === "2000-01-01" ? null : effectiveStart, end: dailyEnd },
      top_contributors: attribution.topContributors.slice(0, TOP_N),
      top_detractors: attribution.topDetractors.slice(0, TOP_N),
      top_sectors: attribution.sectorContribution.slice(0, TOP_N),
      sectors_total: attribution.sectorContribution.length,
      beta_contribution: attribution.decomposedReturn ? attribution.betaVsAlpha.betaContribution : null,
      alpha_contribution: attribution.decomposedReturn ? attribution.betaVsAlpha.alphaContribution : null,
      decomposed_return: attribution.decomposedReturn
        ? {
            portfolio_return: attribution.decomposedReturn.portfolioReturn,
            daily_pairs: attribution.decomposedReturn.observations,
          }
        : null,
      regression_window: attribution.betaWindow,
      ...(attribution.decomposedReturn
        ? {}
        : { withheld: "No beta/alpha split: fewer than 5 aligned daily returns against SPY in this window." }),
      note: "Position contributions are start-of-window weight x the position's price return, long stock, ETF and fund positions held at the window start only (shorts and options are not in them). beta_contribution + alpha_contribution = decomposed_return.portfolio_return, the flow-adjusted daily-series return over regression_window.",
    },
    month: monthly
      ? {
          month_end: monthly.monthEndDate,
          ...(requestedMonth && requestedMonth !== activeMonth
            ? { note: `No statement in scope for ${requestedMonth}; showing ${activeMonth}.` }
            : {}),
          blended: {
            return_fraction: monthly.blended.returnFraction,
            gain_loss_usd: monthly.blended.gainLoss,
            beginning_value_usd: monthly.blended.beginningValue,
            ending_value_usd: monthly.blended.endingValue,
            net_flow_usd: monthly.blended.netFlow,
            method: monthly.blended.method,
            flow_source: monthly.blended.flowSource,
            incomplete: monthly.blended.incomplete,
            blocked_by: monthly.blended.blockedBy.map((b) => ({ account: b.accountName, refusal: b.refusal })),
            refusal: monthly.blended.refusal,
          },
          accounts: monthly.accounts.map((a) => ({
            account: a.accountName,
            return_fraction: a.returnFraction,
            gain_loss_usd: a.gainLoss,
            net_flow_usd: a.netFlow,
            method: a.method,
            flow_source: a.flowSource,
            refusal: a.refusal,
          })),
          available_months: statementMonths.slice(0, MONTHS_LISTED),
        }
      : { withheld: "No statement month in scope." },
    units: {
      index: "growth index, 100 = first_date",
      returns_and_contributions: "decimal fractions over the stated window, not annualised",
      usd: "USD (statement values; net_flow_usd is the signed net external flow for the month)",
      refusal: "why a month carries no figure; a blocked blend has return_fraction null, never a partial figure",
    },
    currency: "USD",
  };
}

export const queryPerformanceVsBenchmarkTool: CompositeTool = { definition, run, acceptsScopeList: true };

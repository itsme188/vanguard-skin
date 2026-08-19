import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeRiskMetrics, type PortfolioRiskMetrics } from "@/lib/compute/risk";
import { resolveScopeToSingleId } from "@/lib/queries/accounts";
import { weekAgo } from "@/lib/calendar/date-utils";

/**
 * Compute per-metric numeric delta between two risk snapshots (now vs week-ago).
 *
 * maxDrawdown.percent, volatility, and sharpeRatio are time-series metrics
 * computed from daily_valuations truncated to <= asOfDate (see RiskOptions.
 * asOfDate in lib/compute/risk.ts) — the week-ago snapshot reflects the
 * portfolio's history as it stood 7 days ago, not today's full series.
 *
 * Concentration metrics (herfindahl) also change with asOfDate (per the
 * asOfDate JSDoc in RiskOptions) and reflect actual rebalancing between the
 * two dates.
 *
 * All four null out (not fake-zero) when the truncated week-ago window has
 * too few observations to compute the metric — see the null guards below.
 */
function computeRiskDelta(
  now: PortfolioRiskMetrics,
  past: PortfolioRiskMetrics
): {
  maxDrawdown: { percent: number | null };
  volatility: number | null;
  sharpeRatio: number | null;
  herfindahl: number | null;
} {
  return {
    maxDrawdown: {
      percent:
        now.maxDrawdown && past.maxDrawdown
          ? now.maxDrawdown.percent - past.maxDrawdown.percent
          : null,
    },
    volatility:
      now.volatility != null && past.volatility != null
        ? now.volatility - past.volatility
        : null,
    sharpeRatio:
      now.sharpeRatio != null && past.sharpeRatio != null
        ? now.sharpeRatio - past.sharpeRatio
        : null,
    herfindahl:
      now.herfindahl != null && past.herfindahl != null
        ? now.herfindahl - past.herfindahl
        : null,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get("startDate") ?? undefined;
    const endDate = searchParams.get("endDate") ?? undefined;
    const accountIdParam = searchParams.get("accountId");
    const scope = searchParams.get("scope");
    const accountId = accountIdParam ? Number(accountIdParam) : resolveScopeToSingleId(db, scope);

    const today = new Date().toISOString().slice(0, 10);
    const wkAgo = weekAgo(today);

    const now = computeRiskMetrics(db, { startDate, endDate, accountId });
    const past = computeRiskMetrics(db, { startDate, endDate, accountId, asOfDate: wkAgo });

    const delta = computeRiskDelta(now, past);

    return NextResponse.json({ success: true, data: now, weekAgo: past, delta });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

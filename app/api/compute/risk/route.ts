import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeRiskMetrics, type PortfolioRiskMetrics } from "@/lib/compute/risk";
import { resolveScopeToSingleId } from "@/lib/queries/accounts";
import { weekAgo } from "@/lib/calendar/date-utils";

/**
 * Compute per-metric numeric delta between two risk snapshots (now vs week-ago).
 *
 * Note: maxDrawdown.percent, volatility, and sharpeRatio are time-series metrics
 * that operate on the full daily_valuations history — they DO NOT change with
 * asOfDate. Their deltas will be near-zero in steady state (the dataset has only
 * grown by 7 trading days). That's informational, not a bug — the W-o-W badge
 * will simply show ↑ +0.0 for these.
 *
 * Concentration metrics (herfindahl) DO change with asOfDate (per the asOfDate
 * JSDoc in RiskOptions) and will reflect actual rebalancing between the two dates.
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

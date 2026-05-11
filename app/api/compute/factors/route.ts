import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeFactorAnalysis, type FactorAnalysisResult } from "@/lib/compute/factors";
import { resolveScopeToSingleId } from "@/lib/queries/accounts";
import { weekAgo } from "@/lib/calendar/date-utils";

/**
 * Compute the per-metric numeric delta between two factor snapshots (now vs week-ago).
 *
 * Only the marketRegression sub-metrics are numeric and worth surfacing here.
 * Tilt buckets (Growth vs Value, sector weights, etc.) are categorical / per-bucket —
 * the UI compares them visually if it wants to. Null when either snapshot lacks
 * marketRegression (e.g. no holdings 7d ago, or insufficient daily-valuation history).
 */
function computeFactorDelta(
  now: FactorAnalysisResult,
  past: FactorAnalysisResult
): {
  marketRegression: {
    beta: number | null;
    alpha: number | null;
    rSquared: number | null;
  };
} {
  const n = now.marketRegression;
  const p = past.marketRegression;
  if (!n || !p) {
    return {
      marketRegression: { beta: null, alpha: null, rSquared: null },
    };
  }
  return {
    marketRegression: {
      beta: n.beta - p.beta,
      alpha: n.alpha - p.alpha,
      rSquared: n.rSquared - p.rSquared,
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountIdParam = searchParams.get("accountId");
    const scope = searchParams.get("scope");
    const accountId = accountIdParam ? Number(accountIdParam) : resolveScopeToSingleId(db, scope);
    const benchmarkSymbol = searchParams.get("benchmark") ?? undefined;

    const today = new Date().toISOString().slice(0, 10);
    const wkAgo = weekAgo(today);

    const now = computeFactorAnalysis(db, { accountId, benchmarkSymbol });
    const past = computeFactorAnalysis(db, { accountId, benchmarkSymbol, asOfDate: wkAgo });

    const delta = computeFactorDelta(now, past);

    return NextResponse.json({ success: true, data: now, weekAgo: past, delta });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeFactorAnalysis, type FactorAnalysisResult } from "@/lib/compute/factors";
import { resolveScope } from "@/lib/queries/accounts";
import { todayET, weekAgo } from "@/lib/calendar/date-utils";

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
    // An explicit accountId is one account. A named scope is its WHOLE id
    // list (resolveScope), never the first account alone. "all" or no scope
    // resolves to undefined: every account.
    const accounts = accountIdParam
      ? { accountId: Number(accountIdParam) }
      : { accountIds: resolveScope(db, scope) };
    const benchmarkSymbol = searchParams.get("benchmark") ?? undefined;

    // The Eastern day: after 20:00 ET the UTC date is already tomorrow, which
    // moved the week-ago snapshot a day forward.
    const wkAgo = weekAgo(todayET());

    const now = computeFactorAnalysis(db, { ...accounts, benchmarkSymbol });
    const past = computeFactorAnalysis(db, { ...accounts, benchmarkSymbol, asOfDate: wkAgo });

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

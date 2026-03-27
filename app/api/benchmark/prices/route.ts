import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getBenchmarkPrices, getAvailableBenchmarks } from "@/lib/queries/benchmark";
import { computeBenchmarkComparison, getBenchmarkChartData } from "@/lib/compute/benchmark";

/**
 * GET /api/benchmark/prices
 * Read benchmark data from DB.
 * Params: symbol, startDate?, endDate?, accountId?, mode=prices|chart|stats|available
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("mode") ?? "prices";
    const symbol = searchParams.get("symbol") ?? "SPY";
    const startDate = searchParams.get("startDate") ?? undefined;
    const endDate = searchParams.get("endDate") ?? undefined;
    const accountIdParam = searchParams.get("accountId");
    const accountId = accountIdParam ? Number(accountIdParam) : undefined;

    if (mode === "available") {
      const benchmarks = getAvailableBenchmarks(db);
      return NextResponse.json({ success: true, data: benchmarks });
    }

    if (mode === "chart") {
      const data = getBenchmarkChartData(db, {
        benchmarkSymbol: symbol,
        startDate,
        endDate,
        accountId,
      });
      return NextResponse.json({ success: true, data });
    }

    if (mode === "stats") {
      const data = computeBenchmarkComparison(db, {
        benchmarkSymbol: symbol,
        startDate,
        endDate,
        accountId,
      });
      return NextResponse.json({ success: true, data });
    }

    // Default: raw prices
    const prices = getBenchmarkPrices(db, symbol, { startDate, endDate });
    return NextResponse.json({ success: true, data: prices });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

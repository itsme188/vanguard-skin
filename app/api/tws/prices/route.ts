import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fetchHistoricalPrices, getRateLimiterStatus } from "@/lib/tws/historical";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const results = await fetchHistoricalPrices(db, {
      securityIds: body.securityIds,
      durationStr: body.duration,
      endDate: body.endDate,
    });

    const totalInserted = results.reduce((s, r) => s + r.barsInserted, 0);
    const totalErrors = results.filter((r) => r.error).length;

    return NextResponse.json({
      success: true,
      data: {
        securities: results.length,
        totalPricesInserted: totalInserted,
        errors: totalErrors,
        rateLimiter: getRateLimiterStatus(),
        results,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}

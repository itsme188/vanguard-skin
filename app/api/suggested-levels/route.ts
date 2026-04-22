import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getOhlcvBars, getLatestPrice } from "@/lib/queries/ohlcv";
import { computeSuggestedLevels } from "@/lib/chart/suggested-levels";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const idParam = searchParams.get("securityId");
  const securityId = Number(idParam);
  if (!Number.isFinite(securityId) || securityId <= 0) {
    return Response.json(
      { error: "securityId query param is required" },
      { status: 400 },
    );
  }

  // Daily bars only for now; a ~500-bar lookback (~2 years) is plenty for
  // pivot detection without pulling the entire history on every call.
  const bars = getOhlcvBars(db, securityId, "1 day", { limit: 500 });
  if (bars.length === 0) {
    return Response.json({
      levels: [],
      atr: null,
      currentPrice: null,
      barsAnalyzed: 0,
      computedAt: new Date().toISOString(),
      warning: "No OHLCV history for this security. Run a chart sync first.",
    });
  }

  const priceRow = getLatestPrice(db, securityId);
  const currentPrice =
    priceRow?.close_price ??
    (bars.length > 0 ? bars[bars.length - 1].close : null);

  if (!Number.isFinite(currentPrice) || (currentPrice as number) <= 0) {
    return Response.json({
      levels: [],
      atr: null,
      currentPrice,
      barsAnalyzed: bars.length,
      computedAt: new Date().toISOString(),
      warning: "Could not resolve a current price for this security.",
    });
  }

  const result = computeSuggestedLevels(bars, currentPrice as number);
  return Response.json(result);
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getIbApi } from "@/lib/tws/client";
import { runAutoRefresh, type RefreshLevel } from "@/lib/tws/auto-refresh";
import { loadIbkrConfig } from "@/lib/ibkr/config";
import { refreshIbkrHoldingsFromWebApi } from "@/lib/ibkr/refresh";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const level: RefreshLevel = body.level === "quick" ? "quick" : "full";

  const api = getIbApi();
  if (!api) {
    // Tier 2 fallback: TWS isn't connected, but if first-party IBKR OAuth is
    // configured we can still refresh the IBKR account's positions/cost-basis/
    // prices over the headless Web API (no TWS, no Gateway). Awaited (it's fast,
    // ~5s) so the response reports the result directly.
    const cfg = loadIbkrConfig();
    if (cfg) {
      try {
        const res = await refreshIbkrHoldingsFromWebApi(db, cfg);
        return NextResponse.json({
          success: true,
          via: "ibkr-webapi",
          message: `IBKR Web API refresh: ${res?.positionsWritten ?? 0} positions as of ${res?.asOfDate}`,
          result: res,
        });
      } catch (err) {
        return NextResponse.json(
          {
            success: false,
            via: "ibkr-webapi",
            error: `IBKR Web API refresh failed: ${(err as Error)?.message ?? err}`,
          },
          { status: 502 },
        );
      }
    }
    return NextResponse.json(
      { success: false, error: "TWS not connected (and IBKR OAuth not configured for fallback)" },
      { status: 400 },
    );
  }

  // Fire-and-forget: the pipeline runs in the background,
  // tracked via sync-state. Client polls /api/tws/sync-status.
  runAutoRefresh(db, level).catch((err) => {
    console.error("[auto-refresh route] Unhandled:", err);
  });

  return NextResponse.json({ success: true, via: "tws", message: `${level} refresh started` });
}

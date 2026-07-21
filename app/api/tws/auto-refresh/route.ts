import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getIbApi } from "@/lib/tws/client";
import { runAutoRefresh, type RefreshLevel } from "@/lib/tws/auto-refresh";
import { loadIbkrConfig } from "@/lib/ibkr/config";
import { refreshIbkrHoldingsFromWebApi } from "@/lib/ibkr/refresh";
import { getSyncState } from "@/lib/tws/sync-state";

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
        // cfg is non-null here, so a null result means one of two things:
        // (a) the sync-state mutex skipped the run (another refresh is
        // mid-flight), or (b) the Web API session politely yielded to an
        // active TWS session (compete:"false" — IbkrSessionYieldError,
        // "ibkr-session-yield" sentinel). (b) is the primary designed
        // scenario for this path, not an edge case, so distinguish it via
        // sync-state's error field rather than reporting a generic
        // "in progress" message.
        const yielded = res === null && (getSyncState().error ?? "").includes("yielded");
        return NextResponse.json({
          success: true,
          via: "ibkr-webapi",
          message: res
            ? `IBKR Web API refresh: ${res.positionsWritten} positions as of ${res.asOfDate}`
            : yielded
              ? "IBKR Web API refresh skipped — TWS owns the session (yielded)"
              : "IBKR Web API refresh skipped — a sync is already in progress",
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

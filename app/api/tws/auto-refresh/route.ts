import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getIbApi } from "@/lib/tws/client";
import { runAutoRefresh, type RefreshLevel } from "@/lib/tws/auto-refresh";

export async function POST(request: NextRequest) {
  const api = getIbApi();
  if (!api) {
    return NextResponse.json(
      { success: false, error: "TWS not connected" },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const level: RefreshLevel = body.level === "quick" ? "quick" : "full";

  // Fire-and-forget: the pipeline runs in the background,
  // tracked via sync-state. Client polls /api/tws/sync-status.
  runAutoRefresh(db, level).catch((err) => {
    console.error("[auto-refresh route] Unhandled:", err);
  });

  return NextResponse.json({ success: true, message: `${level} refresh started` });
}

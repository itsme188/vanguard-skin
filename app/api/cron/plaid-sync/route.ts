import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { refreshVanguardHoldingsFromPlaid } from "@/lib/plaid/refresh";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function POST(request: Request) {
  const expected = process.env.CRON_SHARED_SECRET;
  if (!expected) {
    return Response.json(
      { error: "Server not configured: CRON_SHARED_SECRET missing." },
      { status: 500 },
    );
  }
  const provided = request.headers.get("x-cron-secret") ?? "";
  if (!constantTimeEqual(provided, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await refreshVanguardHoldingsFromPlaid(db);
    if (result === null) {
      // refreshVanguardHoldingsFromPlaid null-gates for three distinct
      // reasons (not connected, credentials not configured, or a sync
      // already in progress) — {success:true, result:null} alone reads as
      // "OK" in the launchd log for what's actually a skipped run. Carry
      // the cause class so the log line is honest about why nothing ran.
      return Response.json({
        success: true,
        result: null,
        note: "skipped: not connected, not configured, or another sync in progress",
      });
    }
    return Response.json({ success: true, result });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Plaid sync failed" },
      { status: 500 },
    );
  }
}

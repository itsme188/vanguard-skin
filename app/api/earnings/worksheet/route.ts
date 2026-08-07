import { db } from "@/lib/db";
import {
  armWorksheet,
  disarmWorksheet,
} from "@/lib/mutations/earnings-worksheet-flags";
import { getWorksheetFlagsForEvents } from "@/lib/queries/earnings-worksheet-flags";
import { printWorksheetNow } from "@/lib/earnings/worksheet";

export const dynamic = "force-dynamic";

/**
 * Earnings worksheet flags + printing (feedback #6). In-app only (no cron
 * auth — same family as /api/earnings/skip).
 *
 * POST body { eventId, action: "arm" | "disarm" | "print" }:
 *   - arm    → auto-print at the preview tick (once; re-arm re-prints)
 *   - disarm → cancel (also clears the printed stamp)
 *   - print  → compose + lp immediately, no stamp involved
 * GET ?eventIds=1,2,3 → { flags: { [id]: { armed, printedAt } } }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    eventId?: number;
    action?: string;
  };
  if (typeof body.eventId !== "number" || !Number.isInteger(body.eventId)) {
    return Response.json({ success: false, error: "eventId must be an integer" }, { status: 400 });
  }
  const row = db
    .prepare(`SELECT event_type, symbol FROM calendar_events WHERE id = ?`)
    .get(body.eventId) as { event_type: string; symbol: string | null } | undefined;
  if (!row) {
    return Response.json({ success: false, error: `Event ${body.eventId} not found` }, { status: 404 });
  }
  // Worksheets are per-EARNINGS-print artifacts — a symbol-less macro row
  // would loop fail-prints in the auto pass (loadWorksheetInputs → null).
  if (row.event_type !== "earnings" || !row.symbol) {
    return Response.json(
      { success: false, error: "Worksheets are only available for symbol-bearing earnings events." },
      { status: 400 },
    );
  }

  switch (body.action) {
    case "arm":
      return Response.json({ success: true, armed: armWorksheet(db, body.eventId) });
    case "disarm":
      return Response.json({ success: true, disarmed: disarmWorksheet(db, body.eventId) });
    case "print":
      try {
        const r = await printWorksheetNow(db, body.eventId);
        return Response.json({ success: true, printed: r.symbol, road: r.road });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json(
          { success: false, error: `Print failed: ${msg}` },
          { status: 500 },
        );
      }
    default:
      return Response.json(
        { success: false, error: 'action must be "arm", "disarm", or "print"' },
        { status: 400 },
      );
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ids = (url.searchParams.get("eventIds") ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const map = getWorksheetFlagsForEvents(db, ids);
  const flags: Record<number, { armed: boolean; printedAt: string | null }> = {};
  for (const [id, v] of map) flags[id] = { armed: v.armed, printedAt: v.printedAt };
  return Response.json({ success: true, flags });
}

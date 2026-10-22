import { db } from "@/lib/db";
import { getCachedModelCatalog } from "@/lib/ai/catalog-source";
import { applyFilingSummaryAction } from "@/lib/filing-summary/actions";
import { getPanelViews } from "@/lib/filing-summary/view";

export const dynamic = "force-dynamic";

/**
 * Armed-print filing summary, panel data and actions. Human route (session +
 * CSRF through proxy.ts); the logic lives in lib/filing-summary.
 *
 * GET ?eventIds=1,2 → { success, data: { [eventId]: PanelView } }. Read-only.
 * POST { eventId, action: "set_choice" | "run" | "rerun" | "retry",
 *        family?, effort?, runId?, requestKey } → { success, data } or
 *        { success: false, error } with 400 / 404 / 409 / 503
 *        (see lib/filing-summary/actions.ts).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const ids = (url.searchParams.get("eventIds") ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 100);
  return Response.json({ success: true, data: getPanelViews(db, ids, getCachedModelCatalog()) });
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => ({}));
  const res = applyFilingSummaryAction(db, body);
  if (!res.ok) return Response.json({ success: false, error: res.error }, { status: res.status });
  return Response.json({ success: true, data: res.data });
}

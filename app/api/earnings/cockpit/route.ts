import { db } from "@/lib/db";
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";
import { decorateCockpitIntel, cockpitRowsToIntelEvents } from "@/lib/queries/earnings-intel";
import { ensureIntelForEvents } from "@/lib/earnings/intel";
import { resolveWeekOfParam } from "@/lib/calendar/date-utils";

export const dynamic = "force-dynamic";

/** `?weekOf=` widens the payload to the Hub's week (M-F5). Absent → undefined,
 *  which keeps buildCockpitPayload byte-identical to today+yesterday only.
 *  Present (even garbage) → resolveWeekOfParam snaps to a Monday and never
 *  errors, so this route can never 400 on the param. */
function weekOfFrom(request: Request): string | undefined {
  const raw = new URL(request.url).searchParams.get("weekOf");
  return raw === null ? undefined : resolveWeekOfParam(raw);
}

/**
 * GET /api/earnings/cockpit — SIDE-EFFECT-FREE read (#35 task 5).
 *
 * Returns the cockpit payload decorated from ALREADY-COMPUTED intel rows. It
 * does NOT call ensureIntelForEvents, which writes intel (implied-move /
 * straddle) rows — under SameSite=Lax a bare GET carries no CSRF protection,
 * so the intel refresh moved to POST. The client polls this GET for data and
 * calls POST to refresh.
 */
export async function GET(request: Request) {
  try {
    const payload = buildCockpitPayload(db, new Date(), { weekOf: weekOfFrom(request) });
    decorateCockpitIntel(db, payload);
    return Response.json({ success: true, data: payload });
  } catch (err) {
    console.error("[cockpit] payload build failed:", err);
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to build cockpit" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/earnings/cockpit — refresh intel, then return the decorated
 * payload. ensureIntelForEvents is best-effort by contract (never throws) and
 * TTL-guarded, so a 60s cockpit poll costs at most one refresh per event per
 * 30 min. This is the write path the GET read used to carry.
 */
export async function POST(request: Request) {
  try {
    const payload = buildCockpitPayload(db, new Date(), { weekOf: weekOfFrom(request) });
    await ensureIntelForEvents(db, cockpitRowsToIntelEvents(payload));
    decorateCockpitIntel(db, payload);
    return Response.json({ success: true, data: payload });
  } catch (err) {
    console.error("[cockpit] intel refresh failed:", err);
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to refresh cockpit" },
      { status: 500 }
    );
  }
}

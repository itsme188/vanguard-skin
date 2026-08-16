import { db } from "@/lib/db";
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";
import { decorateCockpitIntel, cockpitRowsToIntelEvents } from "@/lib/queries/earnings-intel";
import { ensureIntelForEvents } from "@/lib/earnings/intel";

export const dynamic = "force-dynamic";

/**
 * GET /api/earnings/cockpit — SIDE-EFFECT-FREE read (#35 task 5).
 *
 * Returns the cockpit payload decorated from ALREADY-COMPUTED intel rows. It
 * does NOT call ensureIntelForEvents, which writes intel (implied-move /
 * straddle) rows — under SameSite=Lax a bare GET carries no CSRF protection,
 * so the intel refresh moved to POST. The client polls this GET for data and
 * calls POST to refresh.
 */
export async function GET() {
  try {
    const payload = buildCockpitPayload(db);
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
export async function POST() {
  try {
    const payload = buildCockpitPayload(db);
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

import { db } from "@/lib/db";
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";
import { decorateCockpitIntel, cockpitRowsToIntelEvents } from "@/lib/queries/earnings-intel";
import { ensureIntelForEvents } from "@/lib/earnings/intel";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = buildCockpitPayload(db);
    // Best-effort by contract (never throws) — TTL-guarded so 60s cockpit
    // polling costs at most one refresh per event per 30 min.
    await ensureIntelForEvents(db, cockpitRowsToIntelEvents(payload));
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

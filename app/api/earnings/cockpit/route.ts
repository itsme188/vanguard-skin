import { db } from "@/lib/db";
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ success: true, data: buildCockpitPayload(db) });
  } catch (err) {
    console.error("[cockpit] payload build failed:", err);
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to build cockpit" },
      { status: 500 }
    );
  }
}

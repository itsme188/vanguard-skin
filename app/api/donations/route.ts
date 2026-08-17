import { db } from "@/lib/db";
import { getGivingView } from "@/lib/queries/giving-view";

/**
 * GET /api/donations — the Giving view assembly (years + reconciliation
 * report). Thin wrapper: all logic lives in lib/queries/giving-view.ts,
 * shared with the Analysis > Giving server page (Task 13).
 */
export async function GET() {
  try {
    const data = getGivingView(db);
    return Response.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

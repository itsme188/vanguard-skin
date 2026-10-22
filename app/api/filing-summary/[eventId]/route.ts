import { db } from "@/lib/db";
import { getCachedModelCatalog } from "@/lib/ai/catalog-source";
import { getFullView } from "@/lib/filing-summary/view";

export const dynamic = "force-dynamic";

/** GET /api/filing-summary/[eventId] → { success, data: FullView }. Read-only. */
export async function GET(_request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const id = Number(eventId);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ success: false, error: "eventId must be an integer" }, { status: 400 });
  }
  const view = getFullView(db, id, getCachedModelCatalog());
  if (!view) return Response.json({ success: false, error: `Event ${id} not found` }, { status: 404 });
  return Response.json({ success: true, data: view });
}

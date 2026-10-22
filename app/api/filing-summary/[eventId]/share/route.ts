import { db } from "@/lib/db";
import { getCachedModelCatalog } from "@/lib/ai/catalog-source";
import { getFullView } from "@/lib/filing-summary/view";
import { renderSharePage, shareFileName } from "@/lib/filing-summary/share-page";

export const dynamic = "force-dynamic";

/**
 * GET /api/filing-summary/[eventId]/share?runId=N → the run's self-contained
 * HTML page as a download (spec §10). A GET because a download is read-only
 * (Hardening 9).
 */
export async function GET(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const id = Number(eventId);
  const runId = Number(new URL(request.url).searchParams.get("runId"));
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(runId) || runId <= 0) {
    return Response.json({ success: false, error: "eventId and runId must be integers" }, { status: 400 });
  }
  const view = getFullView(db, id, getCachedModelCatalog());
  if (!view) return Response.json({ success: false, error: `Event ${id} not found` }, { status: 404 });
  const run = view.runs.find((r) => r.runId === runId);
  if (!run) return Response.json({ success: false, error: "That run does not belong to this print." }, { status: 404 });
  return new Response(renderSharePage(view, runId), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${shareFileName(view, runId)}"`,
      "Cache-Control": "no-store",
    },
  });
}

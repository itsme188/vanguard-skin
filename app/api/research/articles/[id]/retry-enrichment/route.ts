import { db } from "@/lib/db";
import { retryArticleEnrichment } from "@/lib/mutations/research-articles";

/**
 * POST /api/research/articles/:id/retry-enrichment
 *
 * The Filtered tab's "Retry enrichment" action on an "Enrichment failed" row:
 * puts the article back in the enrichment queue (relevant again, processed_at
 * cleared, attempts reset). It does NOT call the AI itself; the next
 * enrichment pass (Sync Feeds, or the background sync) does.
 *
 * In-app route (session + CSRF via the proxy), same as its sibling
 * /unfilter. Thin wrapper: the rule lives in retryArticleEnrichment.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const articleId = Number(id);
  if (!Number.isInteger(articleId) || articleId <= 0) {
    return Response.json({ success: false, error: "Invalid ID" }, { status: 400 });
  }

  const { status } = retryArticleEnrichment(db, articleId);
  if (status === "not_found") {
    return Response.json({ success: false, error: "That article no longer exists." }, { status: 404 });
  }
  if (status === "not_failed") {
    return Response.json(
      {
        success: false,
        error: "That article is not waiting on a failed enrichment, so there is nothing to retry.",
      },
      { status: 409 },
    );
  }
  return Response.json({ success: true, data: { requeued: true } });
}

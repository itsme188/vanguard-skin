import { db } from "@/lib/db";
import { unfilterArticle } from "@/lib/mutations/research-articles";

/**
 * POST /api/research/articles/:id/unfilter — D5 audit override.
 * Flips is_relevant back to 1 + clears excluded_category/reason.
 * In-app pattern (no cron-auth) — only the user clicks this from the
 * Filtered tab in Research → Feeds.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const articleId = parseInt(id, 10);
  if (Number.isNaN(articleId)) {
    return Response.json({ success: false, error: "Invalid ID" }, { status: 400 });
  }

  const result = unfilterArticle(db, articleId);
  if (!result.changed) {
    return Response.json(
      { success: false, error: "Article not found or already un-filtered" },
      { status: 404 },
    );
  }
  return Response.json({ success: true });
}

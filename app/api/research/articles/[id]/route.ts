import { db } from "@/lib/db";
import { getArticleById } from "@/lib/queries/research";

/**
 * GET /api/research/articles/[id] — Fetch full article with raw_text.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const articleId = parseInt(id, 10);
  if (isNaN(articleId)) {
    return Response.json({ success: false, error: "Invalid ID" }, { status: 400 });
  }

  const article = getArticleById(db, articleId);
  if (!article) {
    return Response.json({ success: false, error: "Not found" }, { status: 404 });
  }

  return Response.json({ success: true, data: article });
}

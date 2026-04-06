import { db } from "@/lib/db";
import { getRecentArticles } from "@/lib/queries/research";

/**
 * GET /api/research/articles — Query research articles with filters.
 * Params: sourceId, securityId, startDate, endDate, search, limit
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sourceId = url.searchParams.get("sourceId");
  const securityId = url.searchParams.get("securityId");
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const search = url.searchParams.get("search");
  const limit = url.searchParams.get("limit");

  const articles = getRecentArticles(db, {
    sourceId: sourceId ? Number(sourceId) : undefined,
    securityId: securityId ? Number(securityId) : undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    search: search || undefined,
    processedOnly: true,
    limit: limit ? Number(limit) : 50,
  });

  return Response.json({ success: true, data: articles });
}

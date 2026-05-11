import { db } from "@/lib/db";
import {
  getRecentArticles,
  getSymbolSecurityMap,
  getFilteredArticles,
} from "@/lib/queries/research";

/**
 * GET /api/research/articles — Query research articles with filters.
 * Params: sourceId, securityId, startDate, endDate, search, limit
 *   filtered=1 — D5 audit fetch: returns is_relevant=0 rows (no symbolMap
 *                needed, no source/security filters honored).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const filteredMode = url.searchParams.get("filtered") === "1";

  if (filteredMode) {
    const limit = url.searchParams.get("limit");
    const data = getFilteredArticles(db, limit ? Number(limit) : 100);
    return Response.json({ success: true, data });
  }

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

  const symbolMap = getSymbolSecurityMap(db, articles.map((a) => a.id));
  return Response.json({ success: true, data: articles, symbolMap });
}

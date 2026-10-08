import { db } from "@/lib/db";
import {
  getRecentArticles,
  countRecentArticles,
  getSymbolSecurityMap,
  getFilteredArticles,
  getFilteredArticleCategoryCounts,
} from "@/lib/queries/research";

/** The most rows one request may read, whatever `limit` asks for. */
const MAX_LIMIT = 500;

/** A whole number from 1 to MAX_LIMIT; anything else falls back to the default. */
function clampLimit(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** A whole number of rows to skip; anything else is 0. */
function clampOffset(raw: string | null): number {
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * GET /api/research/articles — Query research articles with filters.
 * Params: sourceId, securityId, startDate, endDate, search, limit
 *   limit is capped at MAX_LIMIT. The main feed also returns `total`: the
 *   count under the SAME filter as `data` with no limit, for an exact
 *   "N of M".
 *   filtered=1 — D5 audit fetch: returns is_relevant=0 rows (no symbolMap
 *                needed). Honors sourceId + search + limit/offset so the
 *                Filtered tab's toolbar controls + "Load more" pagination
 *                work like the main feed's. Also returns categoryCounts —
 *                a full-set aggregate under the SAME sourceId/search
 *                predicate as `data` — so the client's section headers
 *                never have to derive counts from the (possibly truncated)
 *                loaded page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const filteredMode = url.searchParams.get("filtered") === "1";

  if (filteredMode) {
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    const sourceId = url.searchParams.get("sourceId");
    const search = url.searchParams.get("search");
    const filterOptions = {
      sourceId: sourceId ? Number(sourceId) : undefined,
      search: search || undefined,
    };
    const data = getFilteredArticles(db, {
      ...filterOptions,
      limit: clampLimit(limit, 100),
      offset: clampOffset(offset),
    });
    const categoryCounts = getFilteredArticleCategoryCounts(db, filterOptions);
    return Response.json({ success: true, data, categoryCounts });
  }

  const sourceId = url.searchParams.get("sourceId");
  const securityId = url.searchParams.get("securityId");
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const search = url.searchParams.get("search");
  const limit = url.searchParams.get("limit");

  const filter = {
    sourceId: sourceId ? Number(sourceId) : undefined,
    securityId: securityId ? Number(securityId) : undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    search: search || undefined,
    processedOnly: true,
  };
  const articles = getRecentArticles(db, { ...filter, limit: clampLimit(limit, 50) });
  const total = countRecentArticles(db, filter);

  const symbolMap = getSymbolSecurityMap(db, articles.map((a) => a.id));
  return Response.json({ success: true, data: articles, symbolMap, total });
}

import type Database from "better-sqlite3";

export interface PressRelease {
  id: number;
  finnhub_id: number;
  symbol: string;
  headline: string;
  summary: string | null;
  source: string | null;
  category: string | null;
  url: string | null;
  image_url: string | null;
  published_at: string;
  cached_at: string;
  raw_json: string | null;
}

export interface ListPressReleasesOptions {
  symbol?: string;
  keyword?: string;
  days_back?: number;
  limit?: number;
}

/**
 * List press releases — optionally filtered by symbol, keyword, and a
 * sliding date window. Plain LIKE over headline + summary (no FTS5 for v1;
 * keyword workflows here are narrow enough).
 */
export function listPressReleases(
  db: Database.Database,
  opts: ListPressReleasesOptions = {},
): PressRelease[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.symbol) {
    where.push("symbol = ?");
    params.push(opts.symbol.toUpperCase());
  }
  if (opts.keyword && opts.keyword.trim()) {
    const needle = `%${opts.keyword.trim()}%`;
    where.push("(headline LIKE ? OR summary LIKE ?)");
    params.push(needle, needle);
  }
  if (opts.days_back && opts.days_back > 0) {
    where.push("published_at >= datetime('now', ?)");
    params.push(`-${Math.floor(opts.days_back)} days`);
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 25, 200));
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  return db
    .prepare(
      `SELECT id, finnhub_id, symbol, headline, summary, source, category,
              url, image_url, published_at, cached_at, raw_json
       FROM press_releases
       ${whereSql}
       ORDER BY published_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as PressRelease[];
}

/**
 * How recently the cache for a given symbol was refreshed — used by the
 * chat tool to skip an expensive re-fetch when the cache is fresh enough
 * for the requested window.
 */
export function getLatestCachedPressRelease(
  db: Database.Database,
  symbol: string,
): PressRelease | null {
  const row = db
    .prepare(
      `SELECT id, finnhub_id, symbol, headline, summary, source, category,
              url, image_url, published_at, cached_at, raw_json
       FROM press_releases
       WHERE symbol = ?
       ORDER BY cached_at DESC
       LIMIT 1`,
    )
    .get(symbol.toUpperCase()) as PressRelease | undefined;
  return row ?? null;
}

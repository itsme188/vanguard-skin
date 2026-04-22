/**
 * Finnhub company-news client + cache sync. The chat tool calls
 * `fetchAndCachePressReleases` on demand; a sliding window of ~14 days is
 * cheap enough to refetch on every lookup and dedupe via finnhub_id.
 *
 * Free tier: 60 req/min. We use 550ms pacing for consistency with
 * lib/calendar/finnhub.ts — single-symbol lookups don't need it but future
 * multi-symbol syncs will. FINNHUB_API_KEY required; the function throws a
 * clear error when missing so the chat tool can surface it.
 */

import type Database from "better-sqlite3";
import {
  upsertPressRelease,
  type PressReleaseInput,
} from "@/lib/mutations/press-releases";

const PACING_MS = 550;
const FETCH_TIMEOUT_MS = 15_000;

export interface FinnhubNewsItem {
  id: number;
  category: string; // "company news", "press release", "general", etc.
  datetime: number; // epoch seconds
  headline: string;
  image?: string;
  related?: string;
  source?: string;
  summary?: string;
  url?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Finnhub ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the company-news URL for a symbol over a date range.
 * Exported for test inspection.
 */
export function buildCompanyNewsUrl(
  symbol: string,
  fromDate: string,
  toDate: string,
  apiKey: string,
): string {
  return (
    `https://finnhub.io/api/v1/company-news` +
    `?symbol=${encodeURIComponent(symbol.toUpperCase())}` +
    `&from=${fromDate}&to=${toDate}` +
    `&token=${apiKey}`
  );
}

/**
 * Low-level Finnhub fetch — no caching. Returns the raw array the free-tier
 * endpoint gives back.
 */
export async function getCompanyNews(
  symbol: string,
  fromDate: string,
  toDate: string,
  apiKey: string,
): Promise<FinnhubNewsItem[]> {
  const url = buildCompanyNewsUrl(symbol, fromDate, toDate, apiKey);
  const items = await fetchJson<FinnhubNewsItem[]>(url);
  if (!Array.isArray(items)) return [];
  return items;
}

/**
 * Sliding-window sync. Calls Finnhub for the given symbol + day range,
 * upserts each item by finnhub_id (duplicates from prior calls are
 * harmlessly updated). Returns the number of rows inserted/updated and any
 * fetch error so the chat tool can surface it without crashing.
 */
export async function fetchAndCachePressReleases(
  db: Database.Database,
  symbol: string,
  daysBack: number,
  options: { apiKey?: string; sleepMs?: number } = {},
): Promise<{ upserted: number; error: string | null }> {
  const apiKey = options.apiKey ?? process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return {
      upserted: 0,
      error:
        "FINNHUB_API_KEY is not set. Press releases are served by Finnhub's free tier; set FINNHUB_API_KEY in .env.local to enable.",
    };
  }
  const days = Math.max(1, Math.min(Math.floor(daysBack), 365));

  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const toStr = to.toISOString().slice(0, 10);
  const fromStr = from.toISOString().slice(0, 10);

  let items: FinnhubNewsItem[];
  try {
    items = await getCompanyNews(symbol, fromStr, toStr, apiKey);
  } catch (err) {
    return {
      upserted: 0,
      error: err instanceof Error ? err.message : "Finnhub fetch failed",
    };
  }

  if (options.sleepMs ?? PACING_MS) {
    // pacing gap for future multi-symbol callers; single-symbol paths can
    // pass sleepMs=0 to skip.
    await sleep(options.sleepMs ?? PACING_MS);
  }

  let upserted = 0;
  for (const item of items) {
    if (!Number.isFinite(item.id) || !item.headline || !item.datetime) continue;
    const input: PressReleaseInput = {
      finnhub_id: item.id,
      symbol: symbol.toUpperCase(),
      headline: item.headline,
      summary: item.summary ?? null,
      source: item.source ?? null,
      category: item.category ?? null,
      url: item.url ?? null,
      image_url: item.image ?? null,
      published_at: new Date(item.datetime * 1000).toISOString(),
      raw_json: JSON.stringify(item),
    };
    upsertPressRelease(db, input);
    upserted++;
  }

  return { upserted, error: null };
}

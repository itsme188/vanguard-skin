/**
 * Finnhub analyst-coverage client.
 *
 * Three orthogonal endpoints with separate cache tables, wrapped by one
 * umbrella syncAnalystCoverage() that fires all three in parallel so a
 * single chat-tool call gets a complete picture without three sequential
 * round trips.
 *
 * All three endpoints are available on Finnhub's free tier. No pagination —
 * each returns a small bounded response, so we don't need the 550ms pacing
 * the calendar scan uses.
 */

import type Database from "better-sqlite3";
import {
  upsertRecommendation,
  upsertPriceTarget,
  upsertRatingChange,
  type RecommendationInput,
  type PriceTargetInput,
  type RatingChangeInput,
} from "@/lib/mutations/analyst-estimates";

const FETCH_TIMEOUT_MS = 15_000;

// ─── Finnhub response shapes ────────────────────────────────────

export interface FinnhubRecommendation {
  buy: number;
  hold: number;
  period: string;         // "YYYY-MM-DD"
  sell: number;
  strongBuy: number;
  strongSell: number;
  symbol: string;
}

export interface FinnhubPriceTarget {
  lastUpdated: string;      // "YYYY-MM-DD HH:mm:ss"
  symbol: string;
  targetHigh: number;
  targetLow: number;
  targetMean: number;
  targetMedian: number;
  numberOfAnalysts?: number;
}

export interface FinnhubRatingChange {
  symbol: string;
  gradeTime: number;         // epoch seconds
  company: string;           // analyst firm
  fromGrade?: string;
  toGrade: string;
  action: string;            // "up" | "down" | "main" | "init"
}

// ─── Helpers ────────────────────────────────────────────────────

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

function epochToDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

// ─── Public fetch functions (exported for tests / manual calls) ──

export async function getRecommendationTrend(
  symbol: string,
  apiKey: string,
): Promise<FinnhubRecommendation[]> {
  const url =
    `https://finnhub.io/api/v1/stock/recommendation` +
    `?symbol=${encodeURIComponent(symbol.toUpperCase())}&token=${apiKey}`;
  const data = await fetchJson<FinnhubRecommendation[]>(url);
  return Array.isArray(data) ? data : [];
}

export async function getPriceTarget(
  symbol: string,
  apiKey: string,
): Promise<FinnhubPriceTarget | null> {
  const url =
    `https://finnhub.io/api/v1/stock/price-target` +
    `?symbol=${encodeURIComponent(symbol.toUpperCase())}&token=${apiKey}`;
  const data = await fetchJson<FinnhubPriceTarget>(url);
  // Finnhub returns an object with zero-filled fields when the symbol has no
  // coverage; treat that as null.
  if (!data || (!data.targetMean && !data.targetHigh && !data.targetLow)) {
    return null;
  }
  return data;
}

export async function getUpgradeDowngrade(
  symbol: string,
  apiKey: string,
): Promise<FinnhubRatingChange[]> {
  const url =
    `https://finnhub.io/api/v1/stock/upgrade-downgrade` +
    `?symbol=${encodeURIComponent(symbol.toUpperCase())}&token=${apiKey}`;
  const data = await fetchJson<FinnhubRatingChange[]>(url);
  return Array.isArray(data) ? data : [];
}

// ─── Umbrella sync ──────────────────────────────────────────────

export interface SyncAnalystResult {
  recommendationsUpserted: number;
  priceTargetUpserted: boolean;
  ratingChangesUpserted: number;
  errors: string[];
}

/**
 * Fetch all three analyst datasets for a symbol in parallel and cache.
 * Per-endpoint failures are collected into `errors` rather than throwing,
 * so a chat-tool caller still gets whatever data *did* land.
 */
export async function syncAnalystCoverage(
  db: Database.Database,
  symbol: string,
  options: { apiKey?: string } = {},
): Promise<SyncAnalystResult> {
  const apiKey = options.apiKey ?? process.env.FINNHUB_API_KEY;
  const sym = symbol.toUpperCase();
  const out: SyncAnalystResult = {
    recommendationsUpserted: 0,
    priceTargetUpserted: false,
    ratingChangesUpserted: 0,
    errors: [],
  };

  if (!apiKey) {
    out.errors.push(
      "FINNHUB_API_KEY is not set. Analyst coverage uses Finnhub's free tier; set FINNHUB_API_KEY in .env.local to enable.",
    );
    return out;
  }

  const [recsRes, ptRes, upDownRes] = await Promise.allSettled([
    getRecommendationTrend(sym, apiKey),
    getPriceTarget(sym, apiKey),
    getUpgradeDowngrade(sym, apiKey),
  ]);

  if (recsRes.status === "fulfilled") {
    for (const r of recsRes.value) {
      if (!r.period) continue;
      const input: RecommendationInput = {
        symbol: sym,
        period: r.period,
        strong_buy: r.strongBuy ?? 0,
        buy: r.buy ?? 0,
        hold: r.hold ?? 0,
        sell: r.sell ?? 0,
        strong_sell: r.strongSell ?? 0,
      };
      upsertRecommendation(db, input);
      out.recommendationsUpserted++;
    }
  } else {
    maybePushError(out.errors, "recommendation", recsRes.reason);
  }

  if (ptRes.status === "fulfilled" && ptRes.value) {
    const pt = ptRes.value;
    const input: PriceTargetInput = {
      symbol: sym,
      target_high: pt.targetHigh ?? null,
      target_low: pt.targetLow ?? null,
      target_mean: pt.targetMean ?? null,
      target_median: pt.targetMedian ?? null,
      number_of_analysts: pt.numberOfAnalysts ?? null,
      last_updated: pt.lastUpdated ?? null,
    };
    upsertPriceTarget(db, input);
    out.priceTargetUpserted = true;
  } else if (ptRes.status === "rejected") {
    maybePushError(out.errors, "price target", ptRes.reason);
  }

  if (upDownRes.status === "fulfilled") {
    for (const c of upDownRes.value) {
      if (!c.gradeTime || !c.toGrade) continue;
      const input: RatingChangeInput = {
        symbol: sym,
        rating_date: epochToDate(c.gradeTime),
        firm: c.company ?? null,
        from_grade: c.fromGrade ?? null,
        to_grade: c.toGrade,
        action: c.action ?? null,
      };
      upsertRatingChange(db, input);
      out.ratingChangesUpserted++;
    }
  } else {
    maybePushError(out.errors, "upgrade-downgrade", upDownRes.reason);
  }

  return out;
}

function stringifyErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Only surface errors the user can act on. Finnhub's free tier returns 403
 * on price-target + upgrade-downgrade — nothing the user can fix from the
 * chat prompt, so swallow quietly. Genuine errors (network / 429 / 500)
 * still bubble up as warnings.
 */
function maybePushError(errs: string[], label: string, reason: unknown): void {
  const msg = stringifyErr(reason);
  if (/\b403\b|don'?t have access/i.test(msg)) {
    // Premium-plan endpoint. Caller returns empty data cleanly — no action
    // needed, no warning shown.
    return;
  }
  errs.push(`${label}: ${msg}`);
}

/**
 * API Ninjas Earnings Call Transcript client (optional paid tier).
 *
 * Requires API_NINJAS_API_KEY in .env.local. Developer tier ($39/mo) provides
 * full transcript text. Business tier ($99/mo) adds AI summaries, sentiment,
 * guidance extraction, and participant lists.
 *
 * This is an optional data source — the system works without it using
 * Motley Fool scraping + EDGAR 8-K as the free baseline.
 *
 * API docs: https://api-ninjas.com/api/earningscalltranscript
 */

const API_NINJAS_BASE_URL = "https://api.api-ninjas.com";

// ─── Types ──────────────────────────────────────────────────────

export interface ApiNinjasTranscript {
  date: string;
  timestamp: number;
  ticker: string;
  cik: string;
  year: number;
  quarter: number;
  earnings_timing: string; // "before_market" | "after_market" | "during_market"
  transcript: string;
  // Business+ tier fields (may be absent on Developer tier)
  participants?: { name: string; role: string; company: string }[];
  summary?: string;
  guidance?: string;
  risk_factors?: string;
  overall_sentiment?: number; // -1.0 to 1.0
  overall_sentiment_rationale?: string;
}

// ─── Configuration ──────────────────────────────────────────────

function getApiKey(): string | null {
  return process.env.API_NINJAS_API_KEY || null;
}

/**
 * Check if API Ninjas is configured (API key present in env).
 */
export function isApiNinjasConfigured(): boolean {
  return getApiKey() !== null;
}

// ─── API Client ─────────────────────────────────────────────────

async function apiNinjasFetch(path: string): Promise<unknown> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "API_NINJAS_API_KEY not set. Get a key at https://api-ninjas.com/pricing (Developer tier $39/mo required for transcripts)"
    );
  }

  const response = await fetch(`${API_NINJAS_BASE_URL}${path}`, {
    headers: {
      "X-Api-Key": apiKey,
      Accept: "application/json",
    },
  });

  if (response.status === 402 || response.status === 403) {
    throw new Error(
      "API Ninjas: Premium subscription required for earnings transcripts"
    );
  }
  if (!response.ok) {
    throw new Error(`API Ninjas error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// ─── Public Functions ───────────────────────────────────────────

/**
 * Fetch an earnings call transcript for a specific quarter.
 */
export async function getEarningsTranscript(
  ticker: string,
  year: number,
  quarter: number
): Promise<ApiNinjasTranscript | null> {
  try {
    const data = await apiNinjasFetch(
      `/v1/earningstranscript?ticker=${encodeURIComponent(ticker)}&year=${year}&quarter=${quarter}`
    );

    // API returns an array or single object depending on results
    if (Array.isArray(data)) {
      return (data[0] as ApiNinjasTranscript) || null;
    }
    return data as ApiNinjasTranscript;
  } catch (error) {
    // Gracefully handle premium-gated errors
    if (error instanceof Error && error.message.includes("Premium")) {
      return null;
    }
    throw error;
  }
}

/**
 * Search for available transcript quarters for a ticker.
 */
export async function searchTranscriptQuarters(
  ticker: string
): Promise<{ year: number; quarter: number }[]> {
  try {
    const data = (await apiNinjasFetch(
      `/v1/earningstranscript?ticker=${encodeURIComponent(ticker)}`
    )) as Array<{ year: number; quarter: number }>;

    if (!Array.isArray(data)) return [];

    return data.map((d) => ({ year: d.year, quarter: d.quarter }));
  } catch {
    return [];
  }
}

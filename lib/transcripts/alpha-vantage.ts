/**
 * Alpha Vantage EARNINGS_CALL_TRANSCRIPT client.
 *
 * Free tier: 25 requests/day, 5/min — ample for this app's cache-first usage
 * (each transcript is fetched once, ever). Get a free key at
 * https://www.alphavantage.co/support/#api-key
 *
 * Graceful no-op contract: every failure mode (missing key, HTTP error,
 * rate-limit info payload, malformed JSON, empty transcript) returns null.
 * This function NEVER throws — the fetch chain in fetch.ts relies on that
 * to fall through to EDGAR.
 *
 * FISCAL QUARTER: Alpha Vantage's `quarter` param (YYYYQN) is the company's
 * FISCAL quarter, and its response carries NO call date. This client passes
 * the caller's year+quarter through unchanged, so the caller must pass a
 * fiscal key. Asking with a calendar quarter makes the vendor answer,
 * correctly, with an OLDER fiscal quarter's call for any company whose fiscal
 * year is not the calendar year. The fetch chain (lib/transcripts/fetch.ts)
 * therefore requests a print by its Finnhub fiscal quarter and caches the
 * answer only when the call itself names that quarter.
 */

const ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co";

// ─── Types ──────────────────────────────────────────────────────

interface AlphaVantageSegment {
  speaker?: string;
  title?: string;
  content?: string;
  sentiment?: string | number;
}

export interface AlphaVantageTranscriptResult {
  /** Full transcript body: "Speaker (Title): content" paragraphs. */
  transcript: string;
  /** Distinct speakers in order of first appearance. */
  participants: { name: string; title: string | null }[];
  /** Average of per-segment LLM sentiment scores, or null when absent. */
  overall_sentiment: number | null;
}

// ─── Configuration ──────────────────────────────────────────────

function getApiKey(): string | null {
  return process.env.ALPHA_VANTAGE_API_KEY || null;
}

/**
 * Check if Alpha Vantage is configured (API key present in env).
 */
export function isAlphaVantageConfigured(): boolean {
  return getApiKey() !== null;
}

// ─── Public Functions ───────────────────────────────────────────

/**
 * Fetch an earnings call transcript for a specific (fiscal) quarter.
 * Returns null on any failure — never throws.
 */
export async function getEarningsTranscript(
  ticker: string,
  year: number,
  quarter: number
): Promise<AlphaVantageTranscriptResult | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
    const url =
      `${ALPHA_VANTAGE_BASE_URL}/query?function=EARNINGS_CALL_TRANSCRIPT` +
      `&symbol=${encodeURIComponent(ticker)}` +
      `&quarter=${year}Q${quarter}` +
      `&apikey=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;

    // Rate-limit and error responses come back HTTP 200 with an
    // "Information"/"Error Message" payload and no transcript array —
    // the array check below covers them.
    const data = (await response.json()) as {
      transcript?: AlphaVantageSegment[];
    };
    if (!Array.isArray(data?.transcript)) return null;

    const segments = data.transcript.filter(
      (s): s is AlphaVantageSegment & { content: string } =>
        typeof s?.content === "string" && s.content.trim().length > 0
    );
    if (segments.length === 0) return null;

    const body = segments
      .map((s) => {
        const speaker = (s.speaker ?? "").trim();
        const title = (s.title ?? "").trim();
        const prefix = speaker
          ? title
            ? `${speaker} (${title}): `
            : `${speaker}: `
          : "";
        return prefix + s.content.trim();
      })
      .join("\n\n");

    const participants: { name: string; title: string | null }[] = [];
    const seen = new Set<string>();
    for (const s of segments) {
      const name = (s.speaker ?? "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const title = (s.title ?? "").trim();
      participants.push({ name, title: title || null });
    }

    const sentiments = segments
      .map((s) => Number(s.sentiment))
      .filter((n) => Number.isFinite(n));
    const overall_sentiment =
      sentiments.length > 0
        ? sentiments.reduce((sum, n) => sum + n, 0) / sentiments.length
        : null;

    return { transcript: body, participants, overall_sentiment };
  } catch {
    return null;
  }
}

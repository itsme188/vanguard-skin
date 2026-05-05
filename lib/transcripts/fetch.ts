/**
 * Earnings transcript fetch + cache pipeline.
 *
 * Orchestrates the layered fallback chain:
 *   1. Check SQLite cache → return if found
 *   2. If API Ninjas configured → try API Ninjas
 *   3. Try Motley Fool scraping
 *   4. Fall back to EDGAR 8-K press release
 *   5. Cache result and return
 *
 * All results are cached in the earnings_transcripts table with source_key
 * dedup, so subsequent requests for the same transcript are instant.
 */

import type Database from "better-sqlite3";
import type { EarningsTranscript } from "@/lib/types";
import {
  getCachedTranscript,
  getLatestCachedTranscript,
} from "@/lib/queries/transcripts";
import { upsertTranscript } from "@/lib/mutations/transcripts";
import {
  isApiNinjasConfigured,
  getEarningsTranscript as getApiNinjasTranscript,
} from "@/lib/apis/api-ninjas";
import { getLatestTranscript as getMotleyFoolTranscript } from "@/lib/apis/motley-fool";
import { getEarnings8KFilings } from "@/lib/apis/edgar";

// ─── Types ──────────────────────────────────────────────────────

export interface FetchTranscriptResult {
  transcript: EarningsTranscript;
  fromCache: boolean;
}

// ─── Summary Generation ─────────────────────────────────────────

/**
 * Generate a summary from raw transcript text when the source doesn't
 * provide one (Motley Fool, EDGAR). Extracts key sections:
 * - First ~300 words (usually contains headline metrics)
 * - Paragraphs mentioning guidance/outlook/forecast
 */
export function generateSummary(text: string): string {
  if (!text || text.length < 50) return "";

  const words = text.split(/\s+/);

  // Take first ~300 words
  const intro = words.slice(0, 300).join(" ");

  // Find guidance-related paragraphs
  const paragraphs = text.split(/\n\n+/);
  const guidanceKeywords = /\b(guidance|outlook|expect|forecast|anticipate|project|looking ahead)\b/i;
  const guidanceParagraphs = paragraphs
    .filter((p) => guidanceKeywords.test(p))
    .slice(0, 2)
    .map((p) => {
      const pWords = p.split(/\s+/);
      return pWords.length > 100 ? pWords.slice(0, 100).join(" ") + "..." : p;
    });

  let summary = intro;
  if (intro.split(/\s+/).length >= 300) {
    summary += "...";
  }

  if (guidanceParagraphs.length > 0) {
    const guidanceText = guidanceParagraphs.join(" ");
    // Don't duplicate if guidance is already in the intro
    if (!intro.includes(guidanceText.slice(0, 50))) {
      summary += "\n\n" + guidanceText;
    }
  }

  // Cap at ~200 words for chat context
  const summaryWords = summary.split(/\s+/);
  if (summaryWords.length > 250) {
    summary = summaryWords.slice(0, 250).join(" ") + "...";
  }

  return summary;
}

/**
 * Extract guidance from transcript text.
 */
export function extractGuidance(text: string): string | null {
  if (!text) return null;

  const paragraphs = text.split(/\n\n+/);
  const guidanceKeywords = /\b(guidance|outlook|expect|forecast|anticipate|project|looking ahead|full[- ]year|next quarter)\b/i;

  const guidanceParagraphs = paragraphs
    .filter((p) => guidanceKeywords.test(p) && p.length > 30)
    .slice(0, 3)
    .map((p) => {
      const words = p.split(/\s+/);
      return words.length > 80 ? words.slice(0, 80).join(" ") + "..." : p;
    });

  return guidanceParagraphs.length > 0 ? guidanceParagraphs.join("\n\n") : null;
}

/**
 * Extract risk factors / challenges from transcript text.
 */
export function extractRiskFactors(text: string): string | null {
  if (!text) return null;

  const paragraphs = text.split(/\n\n+/);
  const riskKeywords = /\b(risk|challenge|headwind|decline|pressure|uncertain|concern|difficult|disruption|tariff|impact)\b/i;

  const riskParagraphs = paragraphs
    .filter((p) => riskKeywords.test(p) && p.length > 30)
    .slice(0, 2)
    .map((p) => {
      const words = p.split(/\s+/);
      return words.length > 80 ? words.slice(0, 80).join(" ") + "..." : p;
    });

  return riskParagraphs.length > 0 ? riskParagraphs.join("\n\n") : null;
}

/**
 * Determine the most recent earnings quarter for a date.
 * Companies typically report within 6 weeks of quarter end.
 */
export function getMostRecentQuarter(date: Date = new Date()): {
  year: number;
  quarter: number;
} {
  const month = date.getMonth() + 1; // 1-indexed
  const year = date.getFullYear();

  // Q4 reports come Jan-Feb, Q1 reports come Apr-May, etc.
  // So look back ~2 months to find which quarter was most recently reported
  if (month <= 2) return { year: year - 1, quarter: 3 }; // Q3 of prior year
  if (month <= 5) return { year: year - 1, quarter: 4 }; // Q4 of prior year
  if (month <= 8) return { year, quarter: 1 }; // Q1
  if (month <= 11) return { year, quarter: 2 }; // Q2
  return { year, quarter: 3 }; // Q3
}

/**
 * Derive the calendar quarter being reported in an earnings 8-K from its
 * filing date. Companies on calendar fiscal years file Q1 8-Ks in Apr-Jun,
 * Q2 in Jul-Sep, Q3 in Oct-Dec, and Q4 in Jan-Mar of the following year.
 *
 * **Different from `getMostRecentQuarter`** which is a defensive "what
 * quarter is being talked about as of today's date" default. This function
 * answers "what quarter does THIS specific filing report on?" — needed for
 * the EDGAR fallback to refuse caching a Q4 filing under a Q1 label when
 * the user requested Q1 and only Q4 was available.
 *
 * Limitation: tickers on non-calendar fiscal years (AAPL, ORCL, ADBE, etc.)
 * will under-match. That's the safe failure mode — the EDGAR fallback
 * returns null instead of caching mismatched content.
 */
export function deriveFilingReportingQuarter(filingDate: string): {
  year: number;
  quarter: number;
} {
  // Parse YYYY-MM-DD as UTC noon to dodge DST + timezone edge cases.
  const d = new Date(filingDate + "T12:00:00Z");
  const m = d.getUTCMonth() + 1;
  const y = d.getUTCFullYear();
  if (m <= 3) return { year: y - 1, quarter: 4 };
  if (m <= 6) return { year: y, quarter: 1 };
  if (m <= 9) return { year: y, quarter: 2 };
  return { year: y, quarter: 3 };
}

// ─── Resolve Security ID ────────────────────────────────────────

function resolveSecurityId(
  db: Database.Database,
  ticker: string
): number | null {
  const row = db
    .prepare("SELECT id FROM securities WHERE UPPER(symbol) = UPPER(?) LIMIT 1")
    .get(ticker) as { id: number } | undefined;
  return row?.id ?? null;
}

// ─── Main Fetch Pipeline ────────────────────────────────────────

/**
 * Fetch an earnings transcript, checking cache first then external sources.
 *
 * Fallback chain: Cache → API Ninjas → Motley Fool → EDGAR 8-K
 *
 * @param db Database connection
 * @param ticker Stock ticker symbol
 * @param year Earnings year (defaults to most recent quarter)
 * @param quarter Quarter 1-4 (defaults to most recent quarter)
 */
export async function fetchTranscript(
  db: Database.Database,
  ticker: string,
  year?: number,
  quarter?: number
): Promise<FetchTranscriptResult | null> {
  const upperTicker = ticker.toUpperCase();

  // Default to most recent quarter if not specified
  if (!year || !quarter) {
    const recent = getMostRecentQuarter();
    year = year || recent.year;
    quarter = quarter || recent.quarter;
  }

  // 1. Check cache
  const cached = getCachedTranscript(db, upperTicker, year, quarter);
  if (cached) {
    return { transcript: cached, fromCache: true };
  }

  // Also check if we have any cached version (different quarter)
  // when the user doesn't specify a quarter
  const securityId = resolveSecurityId(db, upperTicker);

  // 2. Try API Ninjas (if configured — paid tier)
  if (isApiNinjasConfigured()) {
    try {
      const result = await getApiNinjasTranscript(upperTicker, year, quarter);
      if (result && result.transcript) {
        const transcript = upsertTranscript(db, {
          security_id: securityId,
          ticker: upperTicker,
          year,
          quarter,
          call_date: result.date ? result.date.slice(0, 10) : null,
          source: "api_ninjas",
          transcript: result.transcript,
          summary: result.summary || generateSummary(result.transcript),
          guidance: result.guidance || extractGuidance(result.transcript),
          risk_factors: result.risk_factors || extractRiskFactors(result.transcript),
          sentiment_score: result.overall_sentiment ?? null,
          sentiment_label: result.overall_sentiment
            ? result.overall_sentiment > 0.2
              ? "bullish"
              : result.overall_sentiment < -0.2
                ? "bearish"
                : "neutral"
            : null,
          participants: result.participants
            ? JSON.stringify(result.participants)
            : null,
          source_key: `api_ninjas:${upperTicker}:${year}:${quarter}`,
        });
        return { transcript, fromCache: false };
      }
    } catch {
      // Fall through to next source
    }
  }

  // 3. Try Motley Fool scraping
  try {
    const result = await getMotleyFoolTranscript(upperTicker, { year, quarter });
    if (result && result.transcript) {
      const transcript = upsertTranscript(db, {
        security_id: securityId,
        ticker: upperTicker,
        year: result.year || year,
        quarter: result.quarter || quarter,
        call_date: result.callDate || null,
        source: "motley_fool",
        transcript: result.transcript,
        summary: generateSummary(result.transcript),
        guidance: extractGuidance(result.transcript),
        risk_factors: extractRiskFactors(result.transcript),
        sentiment_score: null,
        sentiment_label: null,
        participants: result.participants.length > 0
          ? JSON.stringify(result.participants)
          : null,
        source_key: `motley_fool:${upperTicker}:${result.year || year}:${result.quarter || quarter}`,
      });
      return { transcript, fromCache: false };
    }
  } catch {
    // Fall through to EDGAR
  }

  // 4. Fall back to EDGAR 8-K press release.
  // Request full text so cached rows have the complete body; the chat-tool
  // layer decides whether to return an excerpt or the full thing to the
  // model. Critically: filter the returned filings against the requested
  // (year, quarter). The previous implementation took filings[0] (most
  // recent) regardless of which quarter it reported on — when a user
  // requested Q1 2026 and EDGAR only had Q4 2025 cached, the Q4 8-K body
  // would silently get cached under "year=2026, quarter=1" labels. Now we
  // refuse the mismatch and return null so the caller knows nothing
  // matched.
  try {
    const filings = await getEarnings8KFilings(upperTicker, {
      limit: 4,
      fullText: true,
    });
    const matchingFiling = filings.find((f) => {
      const q = deriveFilingReportingQuarter(f.filingDate);
      return q.year === year && q.quarter === quarter;
    });
    if (matchingFiling) {
      const transcript = upsertTranscript(db, {
        security_id: securityId,
        ticker: upperTicker,
        year,
        quarter,
        call_date: matchingFiling.filingDate,
        source: "edgar_8k",
        transcript: matchingFiling.pressReleaseText,
        summary: generateSummary(matchingFiling.pressReleaseText),
        guidance: extractGuidance(matchingFiling.pressReleaseText),
        risk_factors: extractRiskFactors(matchingFiling.pressReleaseText),
        sentiment_score: null,
        sentiment_label: null,
        participants: null,
        accession_number: matchingFiling.accessionNumber,
        filing_url: matchingFiling.filingUrl,
        source_key: `edgar_8k:${matchingFiling.accessionNumber}`,
      });
      return { transcript, fromCache: false };
    }
  } catch {
    // All sources failed
  }

  return null;
}

/**
 * Detect whether a cached edgar_8k entry pre-dates the full-text upgrade
 * (Theme E2 — 2026-04-22). Old caches are <=5100 chars; new ones cap at
 * 60K. If the caller asks for full text and the cached body is suspiciously
 * short, we invalidate and re-fetch so they actually get the richer body.
 */
function isLegacyShortEdgar8k(t: EarningsTranscript): boolean {
  if (t.source !== "edgar_8k") return false;
  return !!t.transcript && t.transcript.length <= 5200;
}

/**
 * Get transcript for the chat tool — returns structured data
 * optimized for Claude's context window.
 *
 * @param fullText when true, returns the complete transcript body in the
 *   `excerpt` field (field name kept for back-compat). Default false keeps
 *   the ~1000-word excerpt that list views rely on. If the cached entry
 *   was produced pre-E2 with the 5000-char EDGAR truncation, the cache is
 *   busted and re-fetched to actually deliver full text.
 */
export async function getTranscriptForChat(
  db: Database.Database,
  ticker: string,
  year?: number,
  quarter?: number,
  options: { fullText?: boolean } = {},
): Promise<{
  ticker: string;
  year: number;
  quarter: number;
  call_date: string | null;
  source: string;
  summary: string | null;
  guidance: string | null;
  risk_factors: string | null;
  sentiment: { label: string; score: number } | null;
  excerpt: string | null;
  transcript_length_words: number;
  has_full_transcript: boolean;
  truncated: boolean;
} | null> {
  let result = await fetchTranscript(db, ticker, year, quarter);
  if (!result) return null;

  const fullText = !!options.fullText;

  // Cache upgrade: re-fetch legacy EDGAR rows when the caller wants full text.
  if (fullText && result.fromCache && isLegacyShortEdgar8k(result.transcript)) {
    // Invalidate by deleting the cached row, then re-fetch.
    const t = result.transcript;
    db.prepare("DELETE FROM earnings_transcripts WHERE id = ?").run(t.id);
    const refreshed = await fetchTranscript(db, ticker, year, quarter);
    if (refreshed) {
      result = refreshed;
    } else {
      // Re-fetch failed (network error, quarter-match rejection, no source).
      // Don't surface the deleted in-memory legacy body as fresh — that
      // would be a "full text" claim against the very content we just
      // invalidated. Caller sees null and can decide.
      return null;
    }
  }

  const t = result.transcript;

  let excerpt: string | null = null;
  let truncated = false;
  if (t.transcript) {
    if (fullText) {
      excerpt = t.transcript;
    } else {
      const words = t.transcript.split(/\s+/);
      if (words.length > 1000) {
        excerpt = words.slice(0, 1000).join(" ") + "...";
        truncated = true;
      } else {
        excerpt = t.transcript;
      }
    }
  }

  return {
    ticker: t.ticker,
    year: t.year,
    quarter: t.quarter,
    call_date: t.call_date,
    source: t.source,
    summary: t.summary,
    guidance: t.guidance,
    risk_factors: t.risk_factors,
    sentiment:
      t.sentiment_label && t.sentiment_score !== null
        ? { label: t.sentiment_label, score: t.sentiment_score }
        : null,
    excerpt,
    transcript_length_words: t.transcript
      ? t.transcript.split(/\s+/).length
      : 0,
    has_full_transcript: !!t.transcript && t.transcript.length > 100,
    truncated,
  };
}

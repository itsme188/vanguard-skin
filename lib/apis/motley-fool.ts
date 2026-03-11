/**
 * Motley Fool earnings call transcript scraper.
 *
 * Scrapes earnings call transcripts from fool.com. Motley Fool uses standard
 * server-rendered HTML (no heavy JS SPA), making it parseable without a headless
 * browser. Coverage focuses on S&P 500 and major US companies.
 *
 * URL pattern: /earnings/call-transcripts/YYYY/MM/DD/{slug}/
 * Content structure: JSON-LD metadata + bold speaker names + section separators
 *
 * Self-throttled to 1 request per 2 seconds to be a good citizen.
 */

const FOOL_BASE_URL = "https://www.fool.com";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── Types ──────────────────────────────────────────────────────

export interface FoolTranscriptListing {
  title: string;
  url: string;
  date: string; // YYYY-MM-DD
  ticker: string | null;
  quarter: number | null;
  year: number | null;
}

export interface FoolTranscript {
  ticker: string;
  companyName: string;
  year: number;
  quarter: number;
  callDate: string; // YYYY-MM-DD
  transcript: string; // Full text
  participants: { name: string; role: string }[];
  source_url: string;
}

// ─── Rate Limiting ──────────────────────────────────────────────

let lastRequestTime = 0;
const MIN_DELAY_MS = 2000; // 1 request per 2 seconds

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_DELAY_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

// ─── Fetch Helper ───────────────────────────────────────────────

async function foolFetch(url: string): Promise<string> {
  await throttle();
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!response.ok) {
    throw new Error(`Motley Fool fetch error: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

// ─── Parsing Helpers ────────────────────────────────────────────

/**
 * Extract ticker and quarter from a transcript title.
 * Examples:
 *   "Kodiak AI (KDK) Q4 2025 Earnings Call Transcript"
 *   "Oracle (ORCL) Q3 2026 Earnings Call Transcript"
 */
export function parseTitleMeta(title: string): {
  ticker: string | null;
  quarter: number | null;
  year: number | null;
  companyName: string | null;
} {
  // Match "Company Name (TICKER) Q# YYYY"
  const match = title.match(/^(.+?)\s*\(([A-Z.]+)\)\s*Q(\d)\s+(\d{4})/);
  if (match) {
    return {
      companyName: match[1].trim(),
      ticker: match[2],
      quarter: parseInt(match[3]),
      year: parseInt(match[4]),
    };
  }
  return { ticker: null, quarter: null, year: null, companyName: null };
}

/**
 * Extract JSON-LD structured data from HTML.
 * Motley Fool includes NewsArticle schema with ticker info.
 */
function extractJsonLd(html: string): Record<string, unknown> | null {
  const match = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Extract the main article body text from HTML.
 * Motley Fool wraps article content in an <article> tag or
 * a div with article-body class.
 */
function extractArticleBody(html: string): string {
  // Try to find article body content
  // Motley Fool uses various wrappers — try multiple patterns
  const patterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*tailwind-article-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }

  // Fallback: find the transcript content between known markers
  const transcriptStart = html.indexOf("Prepared Remarks:");
  const qaStart = html.indexOf("Questions & Answers:");
  if (transcriptStart === -1 && qaStart === -1) {
    // Try alternate marker
    const altStart = html.indexOf("Call participants:");
    if (altStart !== -1) {
      return html.slice(altStart);
    }
  }

  // Return everything between the first transcript marker and the disclosure
  const start = Math.min(
    transcriptStart >= 0 ? transcriptStart : Infinity,
    qaStart >= 0 ? qaStart : Infinity
  );
  if (start !== Infinity) {
    const disclosureIdx = html.indexOf("should consider the following", start);
    const end = disclosureIdx >= 0 ? disclosureIdx : html.length;
    return html.slice(start, end);
  }

  return "";
}

/**
 * Strip HTML tags and decode entities.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract participants from the transcript text.
 * Motley Fool uses **Name -- Title** or **Name:** patterns.
 */
function extractParticipants(text: string): { name: string; role: string }[] {
  const participants: { name: string; role: string }[] = [];
  const seen = new Set<string>();

  // Look for "Call participants:" section
  const participantSection = text.match(
    /(?:Call [Pp]articipants|Participants)[:\s]*\n([\s\S]*?)(?:\n\n|\nPrepared [Rr]emarks|\nSummary)/
  );

  if (participantSection) {
    const lines = participantSection[1].split("\n");
    for (const line of lines) {
      // "Name -- Title" or "Name - Title"
      const match = line.match(/^(.+?)\s*[-–—]+\s*(.+)$/);
      if (match) {
        const name = match[1].trim();
        if (!seen.has(name)) {
          seen.add(name);
          participants.push({ name, role: match[2].trim() });
        }
      }
    }
  }

  // Fallback: extract from bold speaker patterns in transcript body
  if (participants.length === 0) {
    const speakerMatches = text.matchAll(/\*\*(.+?)\*\*/g);
    for (const m of speakerMatches) {
      const name = m[1].replace(/:$/, "").trim();
      if (name.length > 1 && name.length < 60 && !seen.has(name) && name !== "Operator") {
        seen.add(name);
        participants.push({ name, role: "Unknown" });
      }
    }
  }

  return participants;
}

// ─── Public Functions ───────────────────────────────────────────

/**
 * Search for recent earnings call transcripts on Motley Fool.
 * Uses Google site search as Fool doesn't have a direct search API.
 */
export async function searchTranscripts(
  ticker: string,
  options?: { limit?: number }
): Promise<FoolTranscriptListing[]> {
  const limit = options?.limit || 5;
  const searchUrl = `${FOOL_BASE_URL}/search/solr.aspx?q=${encodeURIComponent(
    `${ticker} earnings call transcript`
  )}&source=isa_goog`;

  try {
    const html = await foolFetch(searchUrl);

    // Extract transcript links from search results
    const linkPattern = /href="(\/earnings\/call-transcripts\/\d{4}\/\d{2}\/\d{2}\/[^"]+)"/g;
    const results: FoolTranscriptListing[] = [];
    const seen = new Set<string>();
    let match;

    while ((match = linkPattern.exec(html)) !== null && results.length < limit) {
      const path = match[1];
      if (seen.has(path)) continue;
      seen.add(path);

      // Extract date from URL path: /earnings/call-transcripts/YYYY/MM/DD/slug/
      const dateMatch = path.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
      const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : "";

      // Extract info from slug
      const slugMatch = path.match(/\/(\d{2})\/([^/]+)\/?$/);
      const slug = slugMatch ? slugMatch[2] : "";
      const titleFromSlug = slug
        .replace(/-earnings-call-transcript$/, "")
        .replace(/-/g, " ");

      // Try to get ticker from slug
      const tickerMatch = slug.match(
        /(?:^|-)([a-z]{1,5})-q\d-\d{4}/i
      );
      const foundTicker = tickerMatch ? tickerMatch[1].toUpperCase() : null;

      // Try to get quarter/year
      const qMatch = slug.match(/q(\d)-(\d{4})/i);

      results.push({
        title: titleFromSlug,
        url: `${FOOL_BASE_URL}${path}`,
        date,
        ticker: foundTicker,
        quarter: qMatch ? parseInt(qMatch[1]) : null,
        year: qMatch ? parseInt(qMatch[2]) : null,
      });
    }

    // If search didn't work well, try direct listing page
    if (results.length === 0) {
      return await searchTranscriptsViaListing(ticker, limit);
    }

    return results;
  } catch {
    // Fallback to listing page scrape
    return await searchTranscriptsViaListing(ticker, limit);
  }
}

/**
 * Fallback: search by scraping the main transcript listing page.
 */
async function searchTranscriptsViaListing(
  ticker: string,
  limit: number
): Promise<FoolTranscriptListing[]> {
  const html = await foolFetch(`${FOOL_BASE_URL}/earnings-call-transcripts/`);
  const tickerUpper = ticker.toUpperCase();

  const linkPattern = /href="(\/earnings\/call-transcripts\/\d{4}\/\d{2}\/\d{2}\/[^"]+)"/g;
  const results: FoolTranscriptListing[] = [];
  let match;

  while ((match = linkPattern.exec(html)) !== null && results.length < limit) {
    const path = match[1];
    const slug = path.split("/").pop() || "";

    // Check if this transcript is for our ticker
    if (!slug.toLowerCase().includes(tickerUpper.toLowerCase())) continue;

    const dateMatch = path.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
    const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : "";
    const qMatch = slug.match(/q(\d)-(\d{4})/i);

    results.push({
      title: slug.replace(/-/g, " "),
      url: `${FOOL_BASE_URL}${path}`,
      date,
      ticker: tickerUpper,
      quarter: qMatch ? parseInt(qMatch[1]) : null,
      year: qMatch ? parseInt(qMatch[2]) : null,
    });
  }

  return results;
}

/**
 * Fetch and parse a full transcript from its Motley Fool URL.
 */
export async function getTranscriptByUrl(url: string): Promise<FoolTranscript | null> {
  const html = await foolFetch(url);

  // Extract JSON-LD for metadata
  const jsonLd = extractJsonLd(html);
  const headline = (jsonLd?.headline as string) || "";
  const datePublished = (jsonLd?.datePublished as string) || "";

  // Parse title for ticker/quarter/year
  const titleMeta = parseTitleMeta(headline);

  // Extract article body
  const bodyHtml = extractArticleBody(html);
  const bodyText = stripHtml(bodyHtml);

  if (!bodyText || bodyText.length < 100) {
    return null; // Page didn't have real transcript content
  }

  // Extract participants
  const participants = extractParticipants(bodyText);

  // Parse date
  const callDate = datePublished
    ? datePublished.slice(0, 10) // ISO format → YYYY-MM-DD
    : "";

  if (!titleMeta.ticker) return null;

  return {
    ticker: titleMeta.ticker,
    companyName: titleMeta.companyName || "",
    year: titleMeta.year || new Date().getFullYear(),
    quarter: titleMeta.quarter || 1,
    callDate,
    transcript: bodyText,
    participants,
    source_url: url,
  };
}

/**
 * Find and fetch the latest earnings transcript for a ticker.
 * Searches Motley Fool, then fetches the most recent match.
 */
export async function getLatestTranscript(
  ticker: string,
  options?: { year?: number; quarter?: number }
): Promise<FoolTranscript | null> {
  const listings = await searchTranscripts(ticker, { limit: 10 });

  if (listings.length === 0) return null;

  // If year/quarter specified, find the matching listing
  let target = listings[0]; // default to most recent
  if (options?.year && options?.quarter) {
    const match = listings.find(
      (l) => l.year === options.year && l.quarter === options.quarter
    );
    if (match) target = match;
  }

  if (!target.url) return null;

  return getTranscriptByUrl(target.url);
}

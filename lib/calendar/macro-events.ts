import Anthropic from "@anthropic-ai/sdk";
import type { CalendarEventType, EventImpact } from "@/lib/types";
import type { CalendarEventInput } from "@/lib/mutations/calendar";

// ── FRED Release IDs → Calendar Event Types ──────────────────────
//
// Curated list of market-moving FRED releases. Each maps a FRED
// release_id to our calendar event type and default impact rating.
// FRED `releases/dates` returns authoritative future release dates
// directly from the publishing agencies (BLS, Census, Fed, etc.).
//
// To find a release_id: https://api.stlouisfed.org/fred/releases?api_key=KEY&file_type=json

interface FredReleaseConfig {
  releaseId: number;
  eventType: CalendarEventType;
  defaultImpact: EventImpact;
  shortName: string; // concise name for the calendar
}

const TRACKED_RELEASES: FredReleaseConfig[] = [
  // ── High impact ─────────────────────────────────────────
  { releaseId: 50,  eventType: "jobs",         defaultImpact: "high",   shortName: "Nonfarm Payrolls" },
  { releaseId: 10,  eventType: "cpi",          defaultImpact: "high",   shortName: "CPI" },
  { releaseId: 46,  eventType: "gdp",          defaultImpact: "high",   shortName: "GDP" },
  { releaseId: 21,  eventType: "pmi",          defaultImpact: "high",   shortName: "ISM Manufacturing" },
  { releaseId: 29,  eventType: "pmi",          defaultImpact: "high",   shortName: "ISM Services" },
  { releaseId: 53,  eventType: "cpi",          defaultImpact: "high",   shortName: "Personal Income & Outlays (PCE)" },

  // ── Medium impact ───────────────────────────────────────
  { releaseId: 33,  eventType: "jobs",         defaultImpact: "medium", shortName: "ADP Employment" },
  { releaseId: 110, eventType: "jobs",         defaultImpact: "medium", shortName: "JOLTS" },
  { releaseId: 176, eventType: "jobs",         defaultImpact: "medium", shortName: "Initial Jobless Claims" },
  { releaseId: 13,  eventType: "retail_sales", defaultImpact: "medium", shortName: "Retail Sales" },
  { releaseId: 11,  eventType: "cpi",          defaultImpact: "medium", shortName: "Producer Price Index" },
  { releaseId: 63,  eventType: "housing",      defaultImpact: "medium", shortName: "Housing Starts" },
  { releaseId: 59,  eventType: "housing",      defaultImpact: "medium", shortName: "Existing Home Sales" },
  { releaseId: 58,  eventType: "housing",      defaultImpact: "medium", shortName: "New Home Sales" },
  { releaseId: 320, eventType: "other_macro",  defaultImpact: "medium", shortName: "Consumer Confidence" },
  { releaseId: 14,  eventType: "other_macro",  defaultImpact: "medium", shortName: "U. of Michigan Consumer Sentiment" },
  { releaseId: 15,  eventType: "other_macro",  defaultImpact: "medium", shortName: "Industrial Production" },
  { releaseId: 36,  eventType: "other_macro",  defaultImpact: "medium", shortName: "Durable Goods Orders" },
  { releaseId: 127, eventType: "other_macro",  defaultImpact: "medium", shortName: "Trade Balance" },
];

// Build lookup by release_id for fast matching
const RELEASE_MAP = new Map<number, FredReleaseConfig>();
for (const r of TRACKED_RELEASES) {
  RELEASE_MAP.set(r.releaseId, r);
}

// ── FOMC Meeting Dates ──────────────────────────────────────────
//
// Published annually by the Federal Reserve. These are the conclusion
// dates (statement release day, 2:00 PM ET). Meetings with SEP include
// Summary of Economic Projections and the "dot plot."
//
// Source: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm

interface FomcMeeting {
  date: string;       // conclusion date (YYYY-MM-DD)
  hasSEP: boolean;    // Summary of Economic Projections
}

const FOMC_MEETINGS_2026: FomcMeeting[] = [
  { date: "2026-01-28", hasSEP: false },
  { date: "2026-03-18", hasSEP: true },
  { date: "2026-04-29", hasSEP: false },
  { date: "2026-06-17", hasSEP: true },
  { date: "2026-07-29", hasSEP: false },
  { date: "2026-09-16", hasSEP: true },
  { date: "2026-10-28", hasSEP: false },
  { date: "2026-12-09", hasSEP: true },
];

// ── FRED API ─────────────────────────────────────────────────────

interface FredReleaseDate {
  release_id: number;
  release_name: string;
  date: string;
}

/**
 * Fetch upcoming release dates from FRED's releases/dates endpoint.
 * Returns only releases we're tracking (market-moving events).
 */
async function fetchFredReleaseDates(
  startDate: string,
  endDate: string
): Promise<{ date: string; config: FredReleaseConfig; fredName: string }[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    console.warn("[fetchFredReleaseDates] FRED_API_KEY not set, skipping FRED calendar");
    return [];
  }

  const url = new URL("https://api.stlouisfed.org/fred/releases/dates");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("include_release_dates_with_no_data", "true");
  url.searchParams.set("realtime_start", startDate);
  url.searchParams.set("realtime_end", endDate);
  url.searchParams.set("limit", "500");
  url.searchParams.set("sort_order", "asc");

  const response = await fetch(url.toString());
  if (!response.ok) {
    console.warn(`[fetchFredReleaseDates] FRED API error: ${response.status}`);
    return [];
  }

  const data = (await response.json()) as { release_dates: FredReleaseDate[] };

  // Filter to tracked releases only, dedup by release_id + date
  const seen = new Set<string>();
  const results: { date: string; config: FredReleaseConfig; fredName: string }[] = [];

  for (const rd of data.release_dates) {
    const config = RELEASE_MAP.get(rd.release_id);
    if (!config) continue;

    const key = `${rd.release_id}:${rd.date}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ date: rd.date, config, fredName: rd.release_name });
  }

  return results;
}

// ── Claude enrichment ────────────────────────────────────────────

interface EnrichedEvent {
  title: string;
  description: string;
  expected_impact: string;
  event_time: string | null;
  consensus_estimate: string | null;
  previous_value: string | null;
}

/**
 * Send confirmed FRED dates to Claude for enrichment only.
 * Claude adds descriptions, consensus estimates, timing, and impact —
 * but CANNOT change the dates (those come from FRED).
 */
async function enrichEventsWithClaude(
  events: { date: string; shortName: string; fredName: string }[]
): Promise<Map<string, EnrichedEvent>> {
  if (events.length === 0) return new Map();

  const client = new Anthropic();

  const eventList = events
    .map((e, i) => `${i + 1}. ${e.date} — ${e.shortName} (FRED: "${e.fredName}")`)
    .join("\n");

  const prompt = `I have the following confirmed US economic data releases with their exact dates from FRED (Federal Reserve Economic Data). The dates are authoritative — do NOT change them.

${eventList}

For each event, provide enrichment data as a JSON array (same order as above):
- title: concise event name (e.g., "March Nonfarm Payrolls", "February CPI Release")
- description: one sentence about what this measures and why it matters for markets
- expected_impact: "high", "medium", or "low" — based on typical market sensitivity
- event_time: release time in HH:MM format (ET timezone) if you know the standard release time, or null
- consensus_estimate: current Street consensus if you know it (e.g., "+180K", "3.2%"), or null
- previous_value: most recent prior reading (e.g., "+150K", "3.1%"), or null

Return ONLY a JSON array of objects, one per event, in the same order. No markdown, no explanation.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return new Map();

  let jsonStr = textBlock.text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let enriched: EnrichedEvent[];
  try {
    enriched = JSON.parse(jsonStr);
  } catch {
    console.warn("[enrichEventsWithClaude] Failed to parse response:", jsonStr.slice(0, 200));
    return new Map();
  }

  if (!Array.isArray(enriched)) return new Map();

  // Map by index → "date:shortName" key
  const result = new Map<string, EnrichedEvent>();
  for (let i = 0; i < Math.min(enriched.length, events.length); i++) {
    const key = `${events[i].date}:${events[i].shortName}`;
    result.set(key, enriched[i]);
  }

  return result;
}

// ── Main fetch function ──────────────────────────────────────────

/**
 * Fetch upcoming macro events using FRED for authoritative dates,
 * then Claude for enrichment (descriptions, estimates, timing).
 *
 * Architecture:
 *  1. FRED `releases/dates` → confirmed release dates from BLS, Census, Fed, ISM
 *  2. Claude enrichment → descriptions, consensus estimates, impact ratings, release times
 *  3. Dates NEVER come from Claude — only from FRED
 */
export async function fetchMacroEvents(
  startDate: string,
  endDate: string,
  weekOf: string
): Promise<CalendarEventInput[]> {
  // Step 1: Get authoritative dates from FRED
  const fredEvents = await fetchFredReleaseDates(startDate, endDate);

  // Step 2: Enrich FRED events with Claude (descriptions, estimates, timing)
  const enrichmentInput = fredEvents.map((e) => ({
    date: e.date,
    shortName: e.config.shortName,
    fredName: e.fredName,
  }));

  const enriched = await enrichEventsWithClaude(enrichmentInput);

  // Step 3: Combine FRED dates + Claude enrichment into CalendarEventInput[]
  const events: CalendarEventInput[] = fredEvents.map((e) => {
    const key = `${e.date}:${e.config.shortName}`;
    const extra = enriched.get(key);

    const title = extra?.title || e.config.shortName;
    const sourceKey = `fred:${e.config.releaseId}:${e.date}`;

    return {
      source: "claude_macro" as const,
      event_type: e.config.eventType,
      event_date: e.date, // FROM FRED — authoritative
      event_time: extra?.event_time ?? null,
      title,
      description: extra?.description ?? null,
      expected_impact: extra?.expected_impact
        ? normalizeImpact(extra.expected_impact)
        : e.config.defaultImpact,
      consensus_estimate: extra?.consensus_estimate ?? null,
      previous_value: extra?.previous_value ?? null,
      source_key: sourceKey,
      week_of: weekOf,
    };
  });

  // Step 4: Add FOMC meeting dates (hardcoded, from federalreserve.gov)
  for (const meeting of FOMC_MEETINGS_2026) {
    if (meeting.date >= startDate && meeting.date <= endDate) {
      const title = meeting.hasSEP
        ? "FOMC Rate Decision + Projections"
        : "FOMC Rate Decision";
      const description = meeting.hasSEP
        ? "Federal Open Market Committee announces interest rate decision, releases Summary of Economic Projections (dot plot), and holds press conference at 2:30 PM ET."
        : "Federal Open Market Committee announces interest rate decision and holds press conference at 2:30 PM ET.";

      events.push({
        source: "claude_macro" as const,
        event_type: "fomc",
        event_date: meeting.date,
        event_time: "14:00",
        title,
        description,
        expected_impact: "high",
        consensus_estimate: null,
        previous_value: null,
        source_key: `fomc:${meeting.date}`,
        week_of: weekOf,
      });
    }
  }

  if (events.length === 0) {
    console.warn("[fetchMacroEvents] No macro events found for date range");
  }

  return events;
}

// ── Helpers ──────────────────────────────────────────────────────

function normalizeImpact(raw: string): EventImpact {
  const lower = raw.toLowerCase().trim();
  if (lower === "high" || lower === "medium" || lower === "low") return lower;
  return "medium";
}

import type { CalendarEventType, EventImpact } from "@/lib/types";
import type { CalendarEventInput } from "@/lib/mutations/calendar";
import { SONNET_MODEL } from "@/lib/claude-models";
import { getRawAnthropicClient } from "@/lib/ai/provider";
import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";

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
  reportingLag: number | "weekly" | "quarterly"; // months before release that data covers
  // Keyword(s) that MUST appear (case-insensitive) in FRED's release_name for
  // this ID. Guards against silent ID drift — if FRED returns a different name
  // than expected, we skip + warn instead of mislabeling the event.
  expectedNameKeywords: string[];
}

// IMPORTANT: IDs below are verified against FRED /releases on 2026-04-18.
// Do NOT edit without re-verifying — a wrong ID silently mislabels events
// (see memory/feedback_verify_external_truth.md for the incident).
const TRACKED_RELEASES: FredReleaseConfig[] = [
  // ── High impact ─────────────────────────────────────────
  //   reportingLag: 1 = prior month, 2 = two months prior,
  //   0 = current month, "weekly" = weekly data, "quarterly" = GDP
  { releaseId: 50,  eventType: "jobs",         defaultImpact: "high",   shortName: "Nonfarm Payrolls",                reportingLag: 1,           expectedNameKeywords: ["Employment Situation"] },
  { releaseId: 10,  eventType: "cpi",          defaultImpact: "high",   shortName: "CPI",                             reportingLag: 1,           expectedNameKeywords: ["Consumer Price Index"] },
  { releaseId: 53,  eventType: "gdp",          defaultImpact: "high",   shortName: "GDP",                             reportingLag: "quarterly", expectedNameKeywords: ["Gross Domestic Product"] },
  { releaseId: 54,  eventType: "cpi",          defaultImpact: "high",   shortName: "Personal Income & Outlays (PCE)", reportingLag: 1,           expectedNameKeywords: ["Personal Income"] },

  // ── Medium impact ───────────────────────────────────────
  { releaseId: 194, eventType: "jobs",         defaultImpact: "medium", shortName: "ADP Employment",                  reportingLag: 1,           expectedNameKeywords: ["ADP"] },
  { releaseId: 192, eventType: "jobs",         defaultImpact: "medium", shortName: "JOLTS",                           reportingLag: 2,           expectedNameKeywords: ["Job Openings", "JOLTS"] },
  { releaseId: 180, eventType: "jobs",         defaultImpact: "medium", shortName: "Initial Jobless Claims",          reportingLag: "weekly",    expectedNameKeywords: ["Unemployment Insurance"] },
  { releaseId: 9,   eventType: "retail_sales", defaultImpact: "medium", shortName: "Retail Sales",                    reportingLag: 1,           expectedNameKeywords: ["Retail"] },
  { releaseId: 46,  eventType: "cpi",          defaultImpact: "medium", shortName: "Producer Price Index",            reportingLag: 1,           expectedNameKeywords: ["Producer Price"] },
  { releaseId: 27,  eventType: "housing",      defaultImpact: "medium", shortName: "Housing Starts",                  reportingLag: 1,           expectedNameKeywords: ["New Residential Construction"] },
  { releaseId: 291, eventType: "housing",      defaultImpact: "medium", shortName: "Existing Home Sales",             reportingLag: 1,           expectedNameKeywords: ["Existing Home Sales"] },
  { releaseId: 97,  eventType: "housing",      defaultImpact: "medium", shortName: "New Home Sales",                  reportingLag: 1,           expectedNameKeywords: ["New Residential Sales"] },
  { releaseId: 13,  eventType: "other_macro",  defaultImpact: "medium", shortName: "Industrial Production",           reportingLag: 1,           expectedNameKeywords: ["Industrial Production"] },
  { releaseId: 95,  eventType: "other_macro",  defaultImpact: "medium", shortName: "Durable Goods Orders",            reportingLag: 1,           expectedNameKeywords: ["Manufacturer", "M3"] },
  { releaseId: 51,  eventType: "other_macro",  defaultImpact: "medium", shortName: "Trade Balance",                   reportingLag: 2,           expectedNameKeywords: ["International Trade"] },
];

// Build lookup by release_id for fast matching
const RELEASE_MAP = new Map<number, FredReleaseConfig>();
for (const r of TRACKED_RELEASES) {
  RELEASE_MAP.set(r.releaseId, r);
}

// ── Reporting Period ─────────────────────────────────────────────
//
// Economic releases lag: April 14 PPI covers March data, not April.
// This derives the reporting period from the release date so Claude
// doesn't have to guess.

function getReportingPeriod(
  releaseDate: string,
  lag: FredReleaseConfig["reportingLag"]
): string | null {
  if (lag === "weekly") return null; // weekly data has no month prefix

  const d = new Date(releaseDate + "T12:00:00");

  if (lag === "quarterly") {
    // GDP: the quarter that most recently ended before the release month
    const currentQ = Math.floor(d.getMonth() / 3) + 1;
    const reportQ = currentQ === 1 ? 4 : currentQ - 1;
    return `Q${reportQ}`;
  }

  // Monthly: subtract lag months
  d.setMonth(d.getMonth() - lag);
  return d.toLocaleString("en-US", { month: "long" });
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

// ── Non-FRED indicator schedules ────────────────────────────────
//
// ISM, UMich, and Conference Board publish privately — not via FRED.
// Schedules below are computed from each publisher's typical cadence
// and will be verified per-week via Claude during sync (see
// verifyNonFredReschedules). Government shutdowns can cause shifts.
//
// Sources for the underlying rules:
//  - ISM Manufacturing: 1st business day of month (ismworld.org)
//  - ISM Services: 3rd business day of month (ismworld.org)
//  - U. Michigan Consumer Sentiment (preliminary): 2nd Friday
//    (data.sca.isr.umich.edu/schedule.php)
//  - Conference Board Consumer Confidence: last Tuesday of month
//    (conference-board.org/topics/consumer-confidence)

interface NonFredEvent {
  date: string;
  shortName: string;
  eventType: CalendarEventType;
  defaultImpact: EventImpact;
  reportingLag: 1 | 0; // 1 = prior month data, 0 = current month
  /**
   * Release time in US-Eastern "HH:MM". Written to `event_time` at insert so
   * `resolveReleaseTime` returns it on priority 1 (ahead of the event_type
   * lookup, which doesn't cover `other_macro`). Without this, UMich +
   * Consumer Confidence rows end up with null release_time and never reach
   * the enrichment runner.
   */
  releaseTime: string;
}

function buildNonFredSchedule2026(): NonFredEvent[] {
  const schedule: NonFredEvent[] = [];

  const ismMfg = ["2026-01-02", "2026-02-02", "2026-03-02", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-03", "2026-09-01", "2026-10-01", "2026-11-02", "2026-12-01"];
  for (const date of ismMfg) {
    schedule.push({ date, shortName: "ISM Manufacturing", eventType: "pmi", defaultImpact: "high", reportingLag: 1, releaseTime: "10:00" });
  }

  const ismSvc = ["2026-01-06", "2026-02-04", "2026-03-04", "2026-04-03", "2026-05-05", "2026-06-03", "2026-07-06", "2026-08-05", "2026-09-03", "2026-10-05", "2026-11-04", "2026-12-03"];
  for (const date of ismSvc) {
    schedule.push({ date, shortName: "ISM Services", eventType: "pmi", defaultImpact: "high", reportingLag: 1, releaseTime: "10:00" });
  }

  // UMich Consumer Sentiment publishes twice per month — preliminary (~2nd
  // Friday) and final (~last Friday). Both are market-moving, especially
  // the inflation-expectations breakouts in the final. Observed 2026
  // dates from data.sca.isr.umich.edu/schedule.php (as of 2026-04-24):
  //   Jan Final 01-23, Feb Prelim 02-06, Feb Final 02-20, Mar Prelim 03-13,
  //   Mar Final 03-27. Remaining months use 2nd-Friday / 4th-Friday heuristic;
  //   verifyNonFredReschedules corrects drift at sync time.
  const umichPrelim = ["2026-01-09", "2026-02-06", "2026-03-13", "2026-04-10", "2026-05-08", "2026-06-12", "2026-07-10", "2026-08-14", "2026-09-11", "2026-10-09", "2026-11-13", "2026-12-11"];
  for (const date of umichPrelim) {
    schedule.push({ date, shortName: "U. of Michigan Consumer Sentiment (Preliminary)", eventType: "other_macro", defaultImpact: "medium", reportingLag: 0, releaseTime: "10:00" });
  }

  const umichFinal = ["2026-01-23", "2026-02-20", "2026-03-27", "2026-04-24", "2026-05-22", "2026-06-26", "2026-07-24", "2026-08-28", "2026-09-25", "2026-10-23", "2026-11-27", "2026-12-25"];
  for (const date of umichFinal) {
    schedule.push({ date, shortName: "U. of Michigan Consumer Sentiment (Final)", eventType: "other_macro", defaultImpact: "medium", reportingLag: 0, releaseTime: "10:00" });
  }

  const cbCcx = ["2026-01-27", "2026-02-24", "2026-03-31", "2026-04-28", "2026-05-26", "2026-06-30", "2026-07-28", "2026-08-25", "2026-09-29", "2026-10-27", "2026-11-24", "2026-12-29"];
  for (const date of cbCcx) {
    schedule.push({ date, shortName: "Consumer Confidence", eventType: "other_macro", defaultImpact: "medium", reportingLag: 0, releaseTime: "10:00" });
  }

  return schedule;
}

const NON_FRED_SCHEDULE_2026 = buildNonFredSchedule2026();

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

    // Guard: verify FRED's release_name matches what we expect for this ID.
    // Protects against silent ID drift where FRED re-numbers releases or we
    // mistyped an ID — would otherwise mislabel events (e.g., Industrial
    // Production appearing as Retail Sales).
    if (!releaseNameMatches(rd.release_name, config.expectedNameKeywords)) {
      console.warn(
        `[fetchFredReleaseDates] FRED release ${rd.release_id} returned name ` +
          `"${rd.release_name}" which does not match expected keywords ` +
          `${JSON.stringify(config.expectedNameKeywords)} for ${config.shortName}. ` +
          `Skipping to avoid mislabeling.`
      );
      continue;
    }

    const key = `${rd.release_id}:${rd.date}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ date: rd.date, config, fredName: rd.release_name });
  }

  return results;
}

/**
 * Returns true if at least one expected keyword appears in the release name
 * (case-insensitive). Used to detect FRED ID drift.
 */
export function releaseNameMatches(
  releaseName: string,
  expectedKeywords: string[]
): boolean {
  const lower = releaseName.toLowerCase();
  return expectedKeywords.some((kw) => lower.includes(kw.toLowerCase()));
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
  events: { date: string; shortName: string; fredName: string; reportingPeriod: string | null }[]
): Promise<Map<string, EnrichedEvent>> {
  if (events.length === 0) return new Map();

  const eventList = events
    .map((e, i) => {
      const period = e.reportingPeriod ? ` [reporting period: ${e.reportingPeriod}]` : "";
      return `${i + 1}. ${e.date} — ${e.shortName} (FRED: "${e.fredName}")${period}`;
    })
    .join("\n");

  const prompt = `I have the following confirmed US economic data releases with their exact dates from FRED (Federal Reserve Economic Data). The dates are authoritative — do NOT change them. The reporting period in brackets is also authoritative — it tells you which month/quarter the data covers (economic releases lag by 1-2 months).

${eventList}

For each event, provide enrichment data as a JSON array (same order as above):
- title: concise event name using the reporting period in brackets (e.g., "March Producer Price Index", "Q1 GDP Advance Estimate"). Do NOT use the release month — use the reporting period provided.
- description: one sentence about what this measures and why it matters for markets
- expected_impact: "high", "medium", or "low" — based on typical market sensitivity
- event_time: release time in HH:MM format (ET timezone) if you know the standard release time, or null
- consensus_estimate: current Street consensus if you know it (e.g., "+180K", "3.2%"), or null
- previous_value: most recent prior reading (e.g., "+150K", "3.1%"), or null

Return ONLY a JSON array of objects, one per event, in the same order. No markdown, no explanation.`;

  let text: string;
  try {
    const res = await generateTextForFeature("macroEnrichment", {
      maxOutputTokens: 4096,
      prompt,
    });
    text = res.text;
  } catch (e) {
    if (e instanceof AIRefusalError) {
      console.warn("[enrichEventsWithClaude] AI refused enrichment request — skipping");
      return new Map();
    }
    throw e;
  }

  let jsonStr = text.trim();
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

// ── Reschedule verification (non-FRED only) ─────────────────────
//
// ISM / UMich / Conference Board publishers occasionally reschedule.
// 2026's government shutdown was the acute example — multiple releases
// shifted. Since these aren't in FRED, we rely on hardcoded schedules
// (NON_FRED_SCHEDULE_2026), but verify each week's events against the
// publishers' current calendars via Claude + web search.
//
// Architectural invariant: the hardcoded schedule is the source of
// truth. Claude is a *diff/verifier*, not a date generator. If Claude
// fails or is unreachable, we fall back to the hardcoded date.

export interface ScheduleVerifyResult {
  originalDate: string;
  shortName: string;
  status: "unchanged" | "rescheduled" | "unknown";
  newDate?: string;
  sourceUrl?: string;
  note?: string;
}

/**
 * Ask Claude (with web search) whether any of the given non-FRED events
 * have been rescheduled by their publisher. Returns a map keyed by
 * `${originalDate}:${shortName}`. On error, returns an empty map —
 * callers should treat "no entry" as "use hardcoded date."
 */
export async function verifyNonFredReschedules(
  events: NonFredEvent[]
): Promise<Map<string, ScheduleVerifyResult>> {
  if (events.length === 0) return new Map();
  if (!process.env.ANTHROPIC_API_KEY) return new Map();

  const eventList = events
    .map((e, i) => `${i + 1}. ${e.shortName} — scheduled for ${e.date}`)
    .join("\n");

  const prompt = `I have ${events.length} economic indicator release${events.length > 1 ? "s" : ""} scheduled this week based on standard publisher cadences. Verify the current published release date for each one by checking the publishers' official release calendars:

- ISM Manufacturing / ISM Services: https://www.ismworld.org/supply-management-news-and-reports/reports/
- U. Michigan Consumer Sentiment: https://data.sca.isr.umich.edu/schedule.php
- Consumer Confidence: https://www.conference-board.org/topics/consumer-confidence

Events to verify:
${eventList}

For EACH event, respond with one JSON object. Return a JSON array with exactly ${events.length} objects in the same order.

Each object must have:
- "index": 1-based index matching the list above
- "status": "unchanged" if the publisher's calendar confirms the scheduled date, "rescheduled" if it shows a different date, "unknown" if you could not verify
- "newDate": ISO date YYYY-MM-DD if rescheduled, otherwise null
- "sourceUrl": the publisher URL you verified against, if you found one
- "note": optional one-sentence explanation if status is "rescheduled" or "unknown"

Return ONLY a JSON array. No markdown, no preamble.`;

  try {
    const client = getRawAnthropicClient("scheduleVerification");
    const response = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 4096,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: prompt }],
    });

    // Find the last text block (after web search results)
    const textBlocks = response.content.filter((b) => b.type === "text");
    const lastText = textBlocks[textBlocks.length - 1];
    if (!lastText || lastText.type !== "text") return new Map();

    let jsonStr = lastText.text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // Try to extract array if Claude wrapped it in prose
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) jsonStr = arrayMatch[0];

    const parsed = JSON.parse(jsonStr) as Array<{
      index?: number;
      status?: string;
      newDate?: string | null;
      sourceUrl?: string | null;
      note?: string | null;
    }>;
    if (!Array.isArray(parsed)) return new Map();

    const result = new Map<string, ScheduleVerifyResult>();
    for (const item of parsed) {
      const idx = (item.index ?? 0) - 1;
      if (idx < 0 || idx >= events.length) continue;
      const src = events[idx];
      const status = item.status === "rescheduled" || item.status === "unchanged"
        ? item.status
        : "unknown";
      const key = `${src.date}:${src.shortName}`;
      result.set(key, {
        originalDate: src.date,
        shortName: src.shortName,
        status,
        newDate: item.newDate ?? undefined,
        sourceUrl: item.sourceUrl ?? undefined,
        note: item.note ?? undefined,
      });
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[verifyNonFredReschedules] Verification failed, falling back to hardcoded dates: ${msg}`);
    return new Map();
  }
}

// ── Main fetch function ──────────────────────────────────────────

/**
 * Fetch upcoming macro events using FRED for authoritative dates,
 * then Claude for enrichment (descriptions, estimates, timing).
 *
 * Architecture:
 *  1. FRED `releases/dates` → confirmed release dates from BLS, Census, Fed
 *  2. Non-FRED hardcoded schedules (ISM, UMich, Conf Board) + weekly
 *     Claude/web-search verification for reschedule detection
 *  3. Claude enrichment → descriptions, consensus estimates, impact ratings
 *  4. Dates NEVER come from Claude scratch — only FRED (authoritative) or
 *     hardcoded schedules (verified)
 */
export async function fetchMacroEvents(
  startDate: string,
  endDate: string,
  weekOf: string
): Promise<CalendarEventInput[]> {
  // Step 1: Get authoritative dates from FRED
  const fredEvents = await fetchFredReleaseDates(startDate, endDate);

  // Step 2: Enrich FRED events with Claude (skip gracefully if no API key)
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[fetchMacroEvents] ANTHROPIC_API_KEY not set — skipping Claude enrichment");
  }

  const enrichmentInput = fredEvents.map((e) => ({
    date: e.date,
    shortName: e.config.shortName,
    fredName: e.fredName,
    reportingPeriod: getReportingPeriod(e.date, e.config.reportingLag),
  }));

  const enriched = process.env.ANTHROPIC_API_KEY
    ? await enrichEventsWithClaude(enrichmentInput)
    : new Map<string, EnrichedEvent>();

  // Step 3: Combine FRED dates + Claude enrichment into CalendarEventInput[]
  const events: CalendarEventInput[] = fredEvents.map((e) => {
    const key = `${e.date}:${e.config.shortName}`;
    const extra = enriched.get(key);

    const reportingPeriod = getReportingPeriod(e.date, e.config.reportingLag);
    const fallbackTitle = reportingPeriod
      ? `${reportingPeriod} ${e.config.shortName}`
      : e.config.shortName;
    const title = extra?.title || fallbackTitle;
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

  // Step 5: Non-FRED events (ISM, UMich, Conference Board) with Claude
  // reschedule verification. Hardcoded dates are the source of truth;
  // Claude can only correct them, not generate new ones.
  const nonFredThisWeek = NON_FRED_SCHEDULE_2026.filter(
    (e) => e.date >= startDate && e.date <= endDate
  );

  if (nonFredThisWeek.length > 0) {
    const verifyResults = await verifyNonFredReschedules(nonFredThisWeek);

    for (const src of nonFredThisWeek) {
      const verifyKey = `${src.date}:${src.shortName}`;
      const verify = verifyResults.get(verifyKey);

      // Apply reschedule if Claude found one AND the new date is still in
      // this week's window. Reschedules outside the window are logged but
      // not applied here — next week's sync will pick them up.
      let finalDate = src.date;
      if (
        verify?.status === "rescheduled" &&
        verify.newDate &&
        /^\d{4}-\d{2}-\d{2}$/.test(verify.newDate)
      ) {
        if (verify.newDate >= startDate && verify.newDate <= endDate) {
          finalDate = verify.newDate;
          console.info(
            `[fetchMacroEvents] ${src.shortName} rescheduled from ${src.date} to ${verify.newDate} (${verify.sourceUrl ?? "no source"})`
          );
        } else {
          console.info(
            `[fetchMacroEvents] ${src.shortName} rescheduled out of week (${src.date} → ${verify.newDate}); skipping for this week`
          );
          continue;
        }
      }

      const reportingPeriod = getReportingPeriod(finalDate, src.reportingLag);
      const title = reportingPeriod
        ? `${reportingPeriod} ${src.shortName}`
        : src.shortName;

      events.push({
        source: "claude_macro" as const,
        event_type: src.eventType,
        event_date: finalDate,
        event_time: src.releaseTime,
        title,
        description: null,
        expected_impact: src.defaultImpact,
        consensus_estimate: null,
        previous_value: null,
        raw_json: verify
          ? JSON.stringify({
              reschedule_verified_at: new Date().toISOString(),
              verify_status: verify.status,
              original_date: src.date,
              source_url: verify.sourceUrl ?? null,
              note: verify.note ?? null,
            })
          : null,
        source_key: `nonfred:${src.shortName.replace(/\s+/g, "_")}:${finalDate}`,
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

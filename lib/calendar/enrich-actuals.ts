/**
 * Post-release enrichment: fetch the "actual" value for a calendar event
 * that has already happened.
 *
 * Three code paths, keyed off `calendar_events.source_key`:
 *
 *   fred:<releaseId>:<date>        → FRED series/observations (authoritative)
 *   fomc:<date>                    → FRED DFEDTARU (fed funds upper target)
 *   nonfred:<shortName>:<date>     → Claude + web_search fallback
 *   finnhub:<symbol>:<date>        → Finnhub /calendar/earnings re-fetch
 *
 * Consensus values come from the row itself (`consensus_estimate` was
 * populated at calendar-sync time by Claude). This module only fetches the
 * **actual** — consensus is passed through from the row.
 */

import type Database from "better-sqlite3";
import { getRawAnthropicClient } from "@/lib/ai/provider";
import { SONNET_MODEL } from "@/lib/claude-models";

// ── Types ───────────────────────────────────────────────────────────

export interface EnrichActualResult {
  /**
   * The released value as a string. Shape matches what the publisher
   * reported — "3.2%", "250K", "$1.25", "57.1 index". Null when the
   * source couldn't provide one.
   */
  actual: string | null;

  /**
   * Consensus passed through from the row at enrichment time. May be null.
   */
  consensus: string | null;

  /**
   * Source tag for audit — which code path produced the actual.
   */
  source: "fred" | "finnhub" | "claude_web_search" | "unknown";
}

interface CalendarEventRow {
  id: number;
  source: string;
  source_key: string;
  event_type: string;
  event_date: string;
  release_time: string | null;
  symbol: string | null;
  title: string;
  consensus_estimate: string | null;
  raw_json: string | null;
}

// ── FRED release_id → primary series mapping ────────────────────────
//
// When a FRED release publishes, we fetch the most recent observation
// of the release's "headline" series. Comparison against consensus
// happens downstream — this module only reports the raw published value.
//
// formatAs tells us how to render the raw FRED number:
//   pct      → "3.2%"        (already a percent in the series)
//   pct_yoy  → YoY change from prior-year observation, "3.2%"
//   pct_mom  → MoM change from prior observation, "0.3%"
//   level_k  → "250K"        (number in thousands)
//   level    → as-is
//   qoq_saar → quarterly SAAR percentage "2.8%"
interface FredSeriesConfig {
  seriesId: string;
  formatAs: "pct" | "pct_yoy" | "pct_mom" | "level_k" | "level" | "qoq_saar";
}

const RELEASE_ID_TO_SERIES: Record<number, FredSeriesConfig> = {
  10:  { seriesId: "CPIAUCSL", formatAs: "pct_yoy" },   // CPI YoY
  46:  { seriesId: "PPIACO",   formatAs: "pct_yoy" },   // PPI YoY
  54:  { seriesId: "PCEPILFE", formatAs: "pct_yoy" },   // Core PCE YoY
  53:  { seriesId: "GDPC1",    formatAs: "qoq_saar" },  // Real GDP SAAR
  50:  { seriesId: "PAYEMS",   formatAs: "level_k" },   // Nonfarm payrolls delta
  194: { seriesId: "ADPWNUSNERSA", formatAs: "level_k" }, // ADP
  192: { seriesId: "JTSJOL",   formatAs: "level_k" },   // JOLTS
  180: { seriesId: "ICSA",     formatAs: "level_k" },   // Initial claims
  9:   { seriesId: "RSAFS",    formatAs: "pct_mom" },   // Retail sales MoM
  27:  { seriesId: "HOUST",    formatAs: "level_k" },   // Housing starts
  291: { seriesId: "EXHOSLUSM495S", formatAs: "level_k" }, // Existing home sales
  97:  { seriesId: "HSN1F",    formatAs: "level_k" },   // New home sales
  13:  { seriesId: "INDPRO",   formatAs: "pct_yoy" },   // Industrial production
  95:  { seriesId: "DGORDER",  formatAs: "pct_mom" },   // Durable goods orders
  51:  { seriesId: "BOPGSTB",  formatAs: "level" },     // Trade balance ($ bn)
};

// ── FRED API ────────────────────────────────────────────────────────

interface FredObservation {
  date: string;
  value: string;  // FRED returns "." for missing values
}

interface FredObservationsResponse {
  observations: FredObservation[];
}

export async function fetchFredSeriesLatest(
  seriesId: string,
  /** Optional upper bound on observation_date — "<= observationEnd". */
  observationEnd?: string,
): Promise<{ value: number; date: string; priorValue: number | null; priorYearValue: number | null } | null> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return null;

  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "14");  // get enough for YoY compare
  if (observationEnd) {
    url.searchParams.set("observation_end", observationEnd);
  }

  const res = await fetch(url.toString());
  if (!res.ok) return null;

  const data = (await res.json()) as FredObservationsResponse;
  const rows = (data.observations ?? []).filter((o) => o.value !== ".");
  if (rows.length === 0) return null;

  const latest = rows[0];
  const prior = rows[1] ?? null;
  const priorYear = rows.find((r) => {
    const d = new Date(r.date);
    const ld = new Date(latest.date);
    // Approximately 11–13 months back
    const monthsBack = (ld.getFullYear() - d.getFullYear()) * 12 + (ld.getMonth() - d.getMonth());
    return monthsBack >= 11 && monthsBack <= 13;
  }) ?? null;

  return {
    value: Number(latest.value),
    date: latest.date,
    priorValue: prior ? Number(prior.value) : null,
    priorYearValue: priorYear ? Number(priorYear.value) : null,
  };
}

function formatFredValue(
  obs: NonNullable<Awaited<ReturnType<typeof fetchFredSeriesLatest>>>,
  formatAs: FredSeriesConfig["formatAs"],
): string | null {
  const { value, priorValue, priorYearValue } = obs;
  switch (formatAs) {
    case "pct":
      return `${value.toFixed(1)}%`;
    case "pct_yoy": {
      if (priorYearValue == null || priorYearValue === 0) return null;
      const yoy = ((value - priorYearValue) / priorYearValue) * 100;
      return `${yoy.toFixed(1)}%`;
    }
    case "pct_mom": {
      if (priorValue == null || priorValue === 0) return null;
      const mom = ((value - priorValue) / priorValue) * 100;
      return `${mom.toFixed(1)}%`;
    }
    case "level_k": {
      // Values in thousands, e.g., PAYEMS = 158000 (158M jobs); for
      // payrolls we want the *change*, not the level.
      if (priorValue == null) return `${Math.round(value).toLocaleString("en-US")}K`;
      const delta = Math.round(value - priorValue);
      return `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-US")}K`;
    }
    case "level":
      return value.toLocaleString("en-US");
    case "qoq_saar": {
      // GDPC1 is indexed real GDP level in $B 2017 dollars; the "actual"
      // quoted on release is the SAAR percentage. We approximate via
      // QoQ annualized: ((current/prior)^4 - 1) * 100.
      if (priorValue == null || priorValue === 0) return null;
      const qoq = Math.pow(value / priorValue, 4) - 1;
      return `${(qoq * 100).toFixed(1)}%`;
    }
  }
}

// ── source_key parsing ──────────────────────────────────────────────

export function parseSourceKey(sourceKey: string):
  | { kind: "fred"; releaseId: number; date: string }
  | { kind: "fomc"; date: string }
  | { kind: "nonfred"; shortName: string; date: string }
  | { kind: "finnhub"; symbol: string; date: string }
  | { kind: "unknown" } {
  const fred = /^fred:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(sourceKey);
  if (fred) {
    return { kind: "fred", releaseId: Number(fred[1]), date: fred[2] };
  }
  const fomc = /^fomc:(\d{4}-\d{2}-\d{2})$/.exec(sourceKey);
  if (fomc) {
    return { kind: "fomc", date: fomc[1] };
  }
  const nonfred = /^nonfred:(.+):(\d{4}-\d{2}-\d{2})$/.exec(sourceKey);
  if (nonfred) {
    return { kind: "nonfred", shortName: nonfred[1].replace(/_/g, " "), date: nonfred[2] };
  }
  const finnhub = /^finnhub:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(sourceKey);
  if (finnhub) {
    return { kind: "finnhub", symbol: finnhub[1], date: finnhub[2] };
  }
  return { kind: "unknown" };
}

// ── Finnhub earnings actuals ────────────────────────────────────────

interface FinnhubEarningsEntry {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
}

async function fetchFinnhubActual(
  symbol: string,
  date: string,
): Promise<{ actual: string | null; consensus: string | null }> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return { actual: null, consensus: null };

  const url =
    `https://finnhub.io/api/v1/calendar/earnings` +
    `?from=${date}&to=${date}&symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) return { actual: null, consensus: null };
  const data = (await res.json()) as { earningsCalendar?: FinnhubEarningsEntry[] };
  const entry = data.earningsCalendar?.find((e) => e.date === date && e.symbol === symbol);
  if (!entry) return { actual: null, consensus: null };

  const actualParts: string[] = [];
  if (entry.epsActual != null) actualParts.push(`EPS ${entry.epsActual.toFixed(2)}`);
  if (entry.revenueActual != null) {
    actualParts.push(`Rev ${entry.revenueActual.toLocaleString("en-US")}`);
  }
  const consensusParts: string[] = [];
  if (entry.epsEstimate != null) consensusParts.push(`EPS ${entry.epsEstimate.toFixed(2)}`);
  if (entry.revenueEstimate != null) {
    consensusParts.push(`Rev ${entry.revenueEstimate.toLocaleString("en-US")}`);
  }

  return {
    actual: actualParts.length > 0 ? actualParts.join(" · ") : null,
    consensus: consensusParts.length > 0 ? consensusParts.join(" · ") : null,
  };
}

// ── Claude + web_search fallback for non-FRED macro ─────────────────

async function fetchNonFredActualViaClaude(
  shortName: string,
  date: string,
): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const prompt = `What was the released value of "${shortName}" on ${date}?

Search recent news and publisher websites for the actual published figure. Respond with ONLY the value as a short string (e.g., "57.1", "3.2%", "250K"). If you cannot find the value with reasonable certainty, respond with exactly "null".

No preamble, no explanation.`;

  try {
    const client = getRawAnthropicClient("scheduleVerification");
    const response = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{ role: "user", content: prompt }],
    });
    const textBlocks = response.content.filter((b) => b.type === "text");
    const lastText = textBlocks[textBlocks.length - 1];
    if (!lastText || lastText.type !== "text") return null;
    const cleaned = lastText.text.trim().replace(/^["']|["']$/g, "");
    if (cleaned === "null" || cleaned === "" || cleaned.length > 40) return null;
    return cleaned;
  } catch {
    return null;
  }
}

// ── Main dispatcher ─────────────────────────────────────────────────

export async function fetchActualForEvent(
  _db: Database.Database,
  event: CalendarEventRow,
): Promise<EnrichActualResult> {
  // Source of truth for consensus: whatever was already on the row at
  // sync time. Post-release enrichment doesn't invent consensus values.
  const consensus = event.consensus_estimate;

  const parsed = parseSourceKey(event.source_key);

  if (parsed.kind === "fred") {
    const cfg = RELEASE_ID_TO_SERIES[parsed.releaseId];
    if (!cfg) return { actual: null, consensus, source: "unknown" };
    const obs = await fetchFredSeriesLatest(cfg.seriesId, event.event_date);
    if (!obs) return { actual: null, consensus, source: "fred" };
    return {
      actual: formatFredValue(obs, cfg.formatAs),
      consensus,
      source: "fred",
    };
  }

  if (parsed.kind === "fomc") {
    // Fed funds upper target after the meeting
    const obs = await fetchFredSeriesLatest("DFEDTARU", event.event_date);
    if (!obs) return { actual: null, consensus, source: "fred" };
    return { actual: `${obs.value.toFixed(2)}%`, consensus, source: "fred" };
  }

  if (parsed.kind === "finnhub") {
    const { actual, consensus: freshConsensus } = await fetchFinnhubActual(
      parsed.symbol,
      parsed.date,
    );
    // Finnhub's consensus often updates between scheduling and release —
    // prefer the freshly-fetched one when present.
    return {
      actual,
      consensus: freshConsensus ?? consensus,
      source: "finnhub",
    };
  }

  if (parsed.kind === "nonfred") {
    const actual = await fetchNonFredActualViaClaude(parsed.shortName, parsed.date);
    return { actual, consensus, source: "claude_web_search" };
  }

  return { actual: null, consensus, source: "unknown" };
}

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
//   pct         → "3.2%"   (already a percent in the series)
//   pct_yoy     → YoY change from prior-year observation, "3.2%"
//   pct_mom     → MoM change from prior observation, "0.3%"
//   delta_k     → signed period-over-period change, "+172K" (payroll-style
//                 prints where the press quotes the CHANGE, not the level)
//   level_count → the level itself, "229K" / "4.17M" (claims, home sales,
//                 JOLTS, starts — prints quoted as a LEVEL)
//   usd_millions→ "-$55.9B" (series denominated in millions of dollars)
//   qoq_saar    → quarterly SAAR percentage "2.8%"
//
// unitScale converts a raw observation to ones BEFORE formatting. FRED
// series are heterogeneous: PAYEMS is "Thousands of Persons" (scale 1000)
// but ICSA is "Number" and EXHOSLUSM495S is "Number of Units" (scale 1).
// Units verified against the FRED /series endpoint 2026-06-11 — the old
// one-size-fits-all `level_k` ("delta, assume thousands, append K") stored
// "+4,000K" for 229K jobless claims and "+130,000K" for 4.17M home sales
// (deep-QA finding: today-releases--macro-enrichment-actuals-stored-at-
// wrong-scale-units). Re-verify units before adding any new series.
export interface FredSeriesConfig {
  seriesId: string;
  formatAs: "pct" | "pct_yoy" | "pct_mom" | "delta_k" | "level_count" | "usd_millions" | "qoq_saar";
  /** Multiplier converting a raw observation to ones. Required for
   *  delta_k / level_count; ignored by the pct/usd formats. */
  unitScale?: number;
}

export const RELEASE_ID_TO_SERIES: Record<number, FredSeriesConfig> = {
  10:  { seriesId: "CPIAUCSL", formatAs: "pct_yoy" },   // CPI YoY
  46:  { seriesId: "PPIFIS",   formatAs: "pct_yoy" },   // PPI Final Demand YoY — the press headline; PPIACO (all commodities) matches no published print
  54:  { seriesId: "PCEPILFE", formatAs: "pct_yoy" },   // Core PCE YoY
  53:  { seriesId: "GDPC1",    formatAs: "qoq_saar" },  // Real GDP SAAR
  50:  { seriesId: "PAYEMS",   formatAs: "delta_k", unitScale: 1000 }, // NFP: change, thousands of persons
  194: { seriesId: "ADPMNUSNERSA", formatAs: "delta_k", unitScale: 1 }, // ADP MONTHLY: change, raw persons
  192: { seriesId: "JTSJOL",   formatAs: "level_count", unitScale: 1000 }, // JOLTS: level, thousands
  180: { seriesId: "ICSA",     formatAs: "level_count", unitScale: 1 },    // Initial claims: level, raw count
  9:   { seriesId: "RSAFS",    formatAs: "pct_mom" },   // Retail sales MoM
  27:  { seriesId: "HOUST",    formatAs: "level_count", unitScale: 1000 }, // Housing starts: level, thousands SAAR
  291: { seriesId: "EXHOSLUSM495S", formatAs: "level_count", unitScale: 1 }, // Existing home sales: level, raw count SAAR
  97:  { seriesId: "HSN1F",    formatAs: "level_count", unitScale: 1000 }, // New home sales: level, thousands SAAR
  13:  { seriesId: "INDPRO",   formatAs: "pct_yoy" },   // Industrial production
  95:  { seriesId: "DGORDER",  formatAs: "pct_mom" },   // Durable goods orders
  51:  { seriesId: "BOPGSTB",  formatAs: "usd_millions" }, // Trade balance, millions of $
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
  /**
   * Pin the FRED vintage (ALFRED realtime_start/realtime_end) to this date —
   * the series exactly as published on that day. Without it, re-running an
   * old event picks up LATER-published observations: monthly series are
   * dated the 1st of the data month, so "observation_end = event_date" lets
   * next month's print (published weeks after the event) leak in, plus all
   * revisions since. The actual the market reacted to is the release-day
   * first print — pass the event_date for any release-day "actual".
   */
  realtimeAt?: string,
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
  if (realtimeAt) {
    url.searchParams.set("realtime_start", realtimeAt);
    url.searchParams.set("realtime_end", realtimeAt);
  }

  const res = await fetch(url.toString());
  if (!res.ok) return null;

  const data = (await res.json()) as FredObservationsResponse;
  const rows = (data.observations ?? []).filter((o) => o.value !== ".");
  if (rows.length === 0) return null;

  const latest = rows[0];
  const prior = rows[1] ?? null;
  // Exact 12 months back first — rows are DESC, so a first-match 11–13
  // window always lands on 11 months and computes YoY against the wrong
  // base month. The window survives only as a fallback for vintage holes.
  const monthsBack = (r: FredObservation) => {
    const d = new Date(r.date);
    const ld = new Date(latest.date);
    return (ld.getFullYear() - d.getFullYear()) * 12 + (ld.getMonth() - d.getMonth());
  };
  const priorYear =
    rows.find((r) => monthsBack(r) === 12) ??
    rows.find((r) => {
      const mb = monthsBack(r);
      return mb >= 11 && mb <= 13;
    }) ??
    null;

  return {
    value: Number(latest.value),
    date: latest.date,
    priorValue: prior ? Number(prior.value) : null,
    priorYearValue: priorYear ? Number(priorYear.value) : null,
  };
}

/** "4.17M" / "229K" / "950" from a value in ones. Integer-cent rounding
 *  before division avoids float artifacts (1465000 → "1.47M", not "1.46M"). */
function formatCount(ones: number): string {
  const sign = ones < 0 ? "-" : "";
  const abs = Math.abs(ones);
  if (abs >= 1_000_000) {
    const m = Math.round(abs / 10_000) / 100;
    return `${sign}${m.toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000).toLocaleString("en-US")}K`;
  return `${sign}${Math.round(abs).toLocaleString("en-US")}`;
}

/** Last day of the month before a YYYY-MM-DD date ("2026-06-09" → "2026-05-31"). */
function priorMonthEnd(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(0); // day 0 = last day of the previous month
  return d.toISOString().slice(0, 10);
}

/**
 * Release-day observation fetch with vintage pinning + fallback.
 *
 * Primary: ALFRED vintage at the event date — the series exactly as
 * published that day (first print, no later months, no revisions).
 *
 * Fallback: some series have NO ALFRED vintages (EXHOSLUSM495S — licensed
 * NAR data — 400s on any realtime query). Retry with current-vintage data
 * capped at the end of the month BEFORE the event: a monthly prior-month-
 * release series can then never pick up an observation published after the
 * event, at the cost of reading today's revision instead of the first
 * print. All weekly series in RELEASE_ID_TO_SERIES have vintages, so the
 * fallback only ever serves monthly prior-month releases.
 */
export async function fetchFredVintageForEvent(
  seriesId: string,
  eventDate: string,
): Promise<Awaited<ReturnType<typeof fetchFredSeriesLatest>>> {
  const vintage = await fetchFredSeriesLatest(seriesId, eventDate, eventDate);
  if (vintage) return vintage;
  return fetchFredSeriesLatest(seriesId, priorMonthEnd(eventDate));
}

export function formatFredValue(
  obs: NonNullable<Awaited<ReturnType<typeof fetchFredSeriesLatest>>>,
  cfg: Pick<FredSeriesConfig, "formatAs" | "unitScale">,
): string | null {
  const { value, priorValue, priorYearValue } = obs;
  const scale = cfg.unitScale ?? 1;
  switch (cfg.formatAs) {
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
    case "delta_k": {
      // Payroll-style prints are quoted as the period change ("+172K
      // jobs"). Without a prior observation there is no change to report
      // — null, never the (meaningless) level.
      if (priorValue == null) return null;
      const delta = (value - priorValue) * scale;
      return `${delta >= 0 ? "+" : ""}${formatCount(delta)}`;
    }
    case "level_count":
      // Level-quoted prints: claims "229K", existing home sales "4.17M".
      return formatCount(value * scale);
    case "usd_millions": {
      // Series denominated in millions of dollars (e.g. BOPGSTB).
      const dollars = value * 1_000_000;
      const sign = dollars < 0 ? "-" : "";
      const abs = Math.abs(dollars);
      if (abs >= 1_000_000_000) {
        const b = Math.round(abs / 100_000_000) / 10;
        return `${sign}$${b.toFixed(1).replace(/\.0$/, "")}B`;
      }
      return `${sign}$${formatCount(abs)}`;
    }
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
  // Manual EARNINGS rows take the same Finnhub symbol+date road as vendor
  // earnings rows (`manual:<SYMBOL>:<YYYY-MM-DD>:earnings`, written by
  // insertCalendarEvent). Two populations depend on it: the "+ Add ticker"
  // flow, and every date/slot correction — corrections are minted manual
  // precisely so the sync upsert can't clobber them, which previously also
  // meant they fell through to "unknown" and never captured actuals (so no
  // recap email and no push-at-print for the events the user hand-curated).
  // Only event_type 'earnings' qualifies: a manual macro row has no Finnhub
  // calendar entry to fetch.
  const manualEarnings = /^manual:([^:]+):(\d{4}-\d{2}-\d{2}):earnings$/.exec(sourceKey);
  if (manualEarnings) {
    return { kind: "finnhub", symbol: manualEarnings[1], date: manualEarnings[2] };
  }
  // Nasdaq-sourced earnings rows are a normal recurring population (names
  // Finnhub's calendar misses but Nasdaq's catches — RKT 7/30, XMTR/WIX
  // 8/04). They take the same Finnhub symbol+date road; before this, they
  // fell through to "unknown" and the runner retried every tick without
  // ever fetching an actual — so the recap gate never opened and every
  // Nasdaq-only print ended in a blocked-recap Pushover instead of a recap.
  const nasdaq = /^nasdaq:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(sourceKey);
  if (nasdaq) {
    return { kind: "finnhub", symbol: nasdaq[1], date: nasdaq[2] };
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
  // Exact-symbol entries only. Finnhub resolves ADR queries to the LOCAL
  // listing — querying "TSM" returns "2330.TW" with TWD-scale figures
  // (epsActual 138.87, revenue 1.28 trillion; verified live 2026-07-16) —
  // so a mismatched echo's figures are local-currency and must never be
  // stored as USD. This supersedes the earlier date-only match (GFL →
  // GFL.TO): foreign-listed names get actuals via the blocked-recap
  // Pushover → manual-actuals modal instead ("better no email than a
  // wrong one"). Mirrors the Worker's strict match in
  // workers/cron/src/enrich-actuals.ts.
  const dateMatches = data.earningsCalendar?.filter((e) => e.date === date) ?? [];
  const entry = dateMatches.find((e) => e.symbol === symbol);
  if (!entry) {
    if (dateMatches.length > 0) {
      console.warn(
        `[enrich-actuals] Finnhub echoed foreign listing ${dateMatches
          .map((e) => e.symbol)
          .join(", ")} for ${symbol} ${date} — local-currency figures dropped`
      );
    }
    return { actual: null, consensus: null };
  }

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

/**
 * Standalone probe: has Finnhub published an actual for (symbol, date)?
 * Used by the email sweep's already-reported preview guard (2026-07-23
 * IMAX case: a BMO reporter mis-slotted as AMC put the preview window
 * AFTER the real print). Best-effort — missing API key, network failure,
 * and the foreign-listing symbol-echo guard all return false (preview
 * proceeds; false negatives are safe, false positives are not).
 */
export async function probeFinnhubActualExists(symbol: string, date: string): Promise<boolean> {
  try {
    const { actual } = await fetchFinnhubActual(symbol, date);
    return actual !== null;
  } catch {
    return false;
  }
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
    // Vintage pinned to event_date: the release-day first print, immune to
    // later-published months and revisions (see fetchFredVintageForEvent).
    const obs = await fetchFredVintageForEvent(cfg.seriesId, event.event_date);
    if (!obs) return { actual: null, consensus, source: "fred" };
    return {
      actual: formatFredValue(obs, cfg),
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
    // Also reached by manual earnings rows (see parseSourceKey) — same
    // symbol+date road, same strict symbol echo-match.
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

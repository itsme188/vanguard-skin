/**
 * Worker-side mirror of lib/calendar/enrich-actuals.ts — FRED + Finnhub
 * paths only. The Claude `nonfred` path is deliberately skipped in the cloud
 * fallback: it adds ~20s of latency + per-call cost and the nonfred event
 * volume is small (~10/mo ISM + UMich). Those events land on the Mac's next
 * wake-up enrichment sweep instead.
 *
 * Shape mirrors the Mac module so the emitted `actual` strings look identical
 * when reconciled into calendar_events.
 */

// formatAs + unitScale semantics are documented in the Mac module
// (lib/calendar/enrich-actuals.ts) — units verified against the FRED
// /series endpoint 2026-06-11. Keep this map + formatFredValue in
// lockstep with the Mac side; parity is pinned by mirrored test cases
// in test/enrich-actuals.test.ts.
export interface FredSeriesConfig {
  seriesId: string;
  formatAs: "pct" | "pct_yoy" | "pct_mom" | "delta_k" | "level_count" | "usd_millions" | "qoq_saar";
  /** Multiplier converting a raw observation to ones. Required for
   *  delta_k / level_count; ignored by the pct/usd formats. */
  unitScale?: number;
}

export const RELEASE_ID_TO_SERIES: Record<number, FredSeriesConfig> = {
  10:  { seriesId: "CPIAUCSL", formatAs: "pct_yoy" },
  46:  { seriesId: "PPIFIS",   formatAs: "pct_yoy" }, // PPI Final Demand — the press headline, not PPIACO all-commodities
  54:  { seriesId: "PCEPILFE", formatAs: "pct_yoy" },
  53:  { seriesId: "GDPC1",    formatAs: "qoq_saar" },
  50:  { seriesId: "PAYEMS",   formatAs: "delta_k", unitScale: 1000 },
  194: { seriesId: "ADPMNUSNERSA", formatAs: "delta_k", unitScale: 1 },
  192: { seriesId: "JTSJOL",   formatAs: "level_count", unitScale: 1000 },
  180: { seriesId: "ICSA",     formatAs: "level_count", unitScale: 1 },
  9:   { seriesId: "RSAFS",    formatAs: "pct_mom" },
  27:  { seriesId: "HOUST",    formatAs: "level_count", unitScale: 1000 },
  291: { seriesId: "EXHOSLUSM495S", formatAs: "level_count", unitScale: 1 },
  97:  { seriesId: "HSN1F",    formatAs: "level_count", unitScale: 1000 },
  13:  { seriesId: "INDPRO",   formatAs: "pct_yoy" },
  95:  { seriesId: "DGORDER",  formatAs: "pct_mom" },
  51:  { seriesId: "BOPGSTB",  formatAs: "usd_millions" },
};

interface FredObservation {
  date: string;
  value: string;
}

interface FredObservationsResponse {
  observations?: FredObservation[];
}

export async function fetchFredSeriesLatest(
  apiKey: string | undefined,
  seriesId: string,
  observationEnd?: string,
  /** Pin the FRED/ALFRED vintage — the series as published on this date.
   *  See the Mac module for the full rationale (release-day first print,
   *  immune to later-published months + revisions). */
  realtimeAt?: string,
): Promise<{ value: number; date: string; priorValue: number | null; priorYearValue: number | null } | null> {
  if (!apiKey) return null;
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "14");
  if (observationEnd) url.searchParams.set("observation_end", observationEnd);
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

/** Last day of the month before a YYYY-MM-DD date ("2026-06-09" → "2026-05-31"). */
function priorMonthEnd(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(0); // day 0 = last day of the previous month
  return d.toISOString().slice(0, 10);
}

/** Release-day observation fetch: ALFRED vintage at the event date, falling
 *  back to current-vintage capped at prior-month-end for series with no
 *  ALFRED vintages (EXHOSLUSM495S). Mirrors the Mac module — see
 *  lib/calendar/enrich-actuals.ts::fetchFredVintageForEvent for rationale. */
export async function fetchFredVintageForEvent(
  apiKey: string | undefined,
  seriesId: string,
  eventDate: string,
): Promise<Awaited<ReturnType<typeof fetchFredSeriesLatest>>> {
  const vintage = await fetchFredSeriesLatest(apiKey, seriesId, eventDate, eventDate);
  if (vintage) return vintage;
  return fetchFredSeriesLatest(apiKey, seriesId, priorMonthEnd(eventDate));
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
      if (priorValue == null || priorValue === 0) return null;
      const qoq = Math.pow(value / priorValue, 4) - 1;
      return `${(qoq * 100).toFixed(1)}%`;
    }
  }
}

export type ParsedSourceKey =
  | { kind: "fred"; releaseId: number; date: string }
  | { kind: "fomc"; date: string }
  | { kind: "nonfred"; shortName: string; date: string }
  | { kind: "finnhub"; symbol: string; date: string }
  | { kind: "unknown" };

export function parseSourceKey(sourceKey: string): ParsedSourceKey {
  const fred = /^fred:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(sourceKey);
  if (fred) return { kind: "fred", releaseId: Number(fred[1]), date: fred[2] };
  const fomc = /^fomc:(\d{4}-\d{2}-\d{2})$/.exec(sourceKey);
  if (fomc) return { kind: "fomc", date: fomc[1] };
  const nonfred = /^nonfred:(.+):(\d{4}-\d{2}-\d{2})$/.exec(sourceKey);
  if (nonfred) return { kind: "nonfred", shortName: nonfred[1].replace(/_/g, " "), date: nonfred[2] };
  const finnhub = /^finnhub:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(sourceKey);
  if (finnhub) return { kind: "finnhub", symbol: finnhub[1], date: finnhub[2] };
  // Manual EARNINGS rows take the same Finnhub symbol+date road as vendor
  // earnings rows (`manual:<SYMBOL>:<YYYY-MM-DD>:earnings`) — mirrors the Mac's
  // lib/calendar/enrich-actuals.ts (2026-08-02 parity fix). Corrected/manual
  // rows previously fell through to "unknown" here, so cloud enrichment never
  // captured their actuals while the Mac slept. Only ':earnings' keys qualify:
  // a manual macro row has no Finnhub calendar entry to fetch.
  const manualEarnings = /^manual:([^:]+):(\d{4}-\d{2}-\d{2}):earnings$/.exec(sourceKey);
  if (manualEarnings) {
    return { kind: "finnhub", symbol: manualEarnings[1], date: manualEarnings[2] };
  }
  // Nasdaq-sourced earnings rows ride the Finnhub road too — mirrors the
  // Mac's lib/calendar/enrich-actuals.ts (2026-08-04 XMTR/WIX incident:
  // Nasdaq-only names fell to "unknown" and never captured actuals).
  const nasdaq = /^nasdaq:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(sourceKey);
  if (nasdaq) {
    return { kind: "finnhub", symbol: nasdaq[1], date: nasdaq[2] };
  }
  return { kind: "unknown" };
}

interface FinnhubEarningsEntry {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
}

async function fetchFinnhubActual(
  apiKey: string | undefined,
  symbol: string,
  date: string,
): Promise<{ actual: string | null; consensus: string | null }> {
  if (!apiKey) return { actual: null, consensus: null };
  const url =
    `https://finnhub.io/api/v1/calendar/earnings` +
    `?from=${date}&to=${date}&symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) return { actual: null, consensus: null };
  const data = (await res.json()) as { earningsCalendar?: FinnhubEarningsEntry[] };
  // Strict symbol match is the foreign-listing guard, not an accident:
  // Finnhub resolves ADR queries to the LOCAL listing (querying "TSM"
  // returns "2330.TW" with TWD-scale figures — verified live 2026-07-16).
  // A mismatched echo's figures are local-currency and must never be
  // stored as USD. Same rule on the Mac (lib/calendar/enrich-actuals.ts).
  const entry = data.earningsCalendar?.find((e) => e.date === date && e.symbol === symbol);
  if (!entry) return { actual: null, consensus: null };

  const actualParts: string[] = [];
  if (entry.epsActual != null) actualParts.push(`EPS ${entry.epsActual.toFixed(2)}`);
  if (entry.revenueActual != null) actualParts.push(`Rev ${entry.revenueActual.toLocaleString("en-US")}`);

  const consensusParts: string[] = [];
  if (entry.epsEstimate != null) consensusParts.push(`EPS ${entry.epsEstimate.toFixed(2)}`);
  if (entry.revenueEstimate != null) consensusParts.push(`Rev ${entry.revenueEstimate.toLocaleString("en-US")}`);

  return {
    actual: actualParts.length > 0 ? actualParts.join(" · ") : null,
    consensus: consensusParts.length > 0 ? consensusParts.join(" · ") : null,
  };
}

export interface WorkerEnrichActualResult {
  actual: string | null;
  consensus: string | null;
  source: "fred" | "finnhub" | "claude_nonfred_deferred" | "unknown";
  deferred?: boolean;
  reason?: string;
}

interface MinimalEventRow {
  source_key: string;
  event_date: string;
  consensus_estimate: string | null;
}

export async function fetchActualForEventCloud(
  event: MinimalEventRow,
  env: { FRED_API_KEY?: string; FINNHUB_API_KEY?: string },
): Promise<WorkerEnrichActualResult> {
  const consensus = event.consensus_estimate;
  const parsed = parseSourceKey(event.source_key);

  if (parsed.kind === "fred") {
    const cfg = RELEASE_ID_TO_SERIES[parsed.releaseId];
    if (!cfg) return { actual: null, consensus, source: "unknown", reason: "unmapped_release_id" };
    // Vintage pinned to event_date: the release-day first print, immune to
    // later-published months and revisions (see fetchFredVintageForEvent).
    const obs = await fetchFredVintageForEvent(env.FRED_API_KEY, cfg.seriesId, event.event_date);
    if (!obs) return { actual: null, consensus, source: "fred", reason: "no_observation" };
    return { actual: formatFredValue(obs, cfg), consensus, source: "fred" };
  }

  if (parsed.kind === "fomc") {
    const obs = await fetchFredSeriesLatest(env.FRED_API_KEY, "DFEDTARU", event.event_date);
    if (!obs) return { actual: null, consensus, source: "fred", reason: "no_observation" };
    return { actual: `${obs.value.toFixed(2)}%`, consensus, source: "fred" };
  }

  if (parsed.kind === "finnhub") {
    const { actual, consensus: freshConsensus } = await fetchFinnhubActual(
      env.FINNHUB_API_KEY,
      parsed.symbol,
      parsed.date,
    );
    return {
      actual,
      consensus: freshConsensus ?? consensus,
      source: "finnhub",
    };
  }

  if (parsed.kind === "nonfred") {
    // Cloud fallback defers Claude+web_search nonfred enrichment to next Mac
    // wake — preserves budget + avoids worker-side AI Gateway wiring.
    return {
      actual: null,
      consensus,
      source: "claude_nonfred_deferred",
      deferred: true,
      reason: "claude_nonfred_deferred_to_mac",
    };
  }

  return { actual: null, consensus, source: "unknown", reason: "unknown_source_key" };
}

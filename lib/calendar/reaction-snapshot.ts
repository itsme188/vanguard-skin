/**
 * Capture the market's reaction to a calendar event.
 *
 * For each release (macro or earnings) we fetch 1-minute bars for a
 * small basket of benchmarks (SPY/QQQ/TLT + optional sector ETF), pick
 * the bar closest to T-5min as the "pre" and the bar closest to T+120min
 * as the "post", and compute a percent-delta per benchmark.
 *
 * Two implementations share a single `matchBarsToReaction()` helper so
 * TWS (Mac primary) and Polygon (Worker fallback) produce identical JSON.
 */

import { BarSizeSetting, SecType } from "@stoqey/ib";
import type { IBApiNext } from "@stoqey/ib";

// ── Types ───────────────────────────────────────────────────────────

export interface BenchmarkReaction {
  t_pre: number;
  t_post: number;
  delta_pct: number;
}

export interface ReactionSnapshot {
  t0_utc: string;
  window_min: 120;
  source: "tws" | "polygon";
  spy: BenchmarkReaction;
  qqq: BenchmarkReaction;
  tlt: BenchmarkReaction;
  sector?: BenchmarkReaction & { symbol: string };
}

/** A single time/close pair — format-agnostic across data sources. */
export interface TimedClose {
  tMs: number;   // epoch milliseconds
  close: number;
}

// ── Benchmark universe ──────────────────────────────────────────────

export const CORE_BENCHMARKS = ["SPY", "QQQ", "TLT"] as const;

// Event → sector ETF. Kept in sync with docs/plans/2026-04-24-*.md §4.5.
// Entries here capture the macro mapping; earnings map via securities.sector.
export const EVENT_SECTOR_MAP: Record<string, string | null> = {
  nonfarm_payrolls: "XLF",
  unemployment:     "XLF",
  cpi:              "XLF",
  core_cpi:         "XLF",
  ppi:              null,
  core_pce:         "XLF",
  fomc_rate_decision: "XLF",
  fomc:             "XLF",
  retail_sales:     "XLY",
  ism_manufacturing: "XLI",
  ism_services:     "XLY",
  pmi:              "XLI",
  housing_starts:   "XHB",
  housing:          "XHB",
  gdp:              null,
  jobs:             "XLF",
};

export const SECTOR_TO_ETF: Record<string, string> = {
  "Financials":             "XLF",
  "Technology":             "XLK",
  "Health Care":            "XLV",
  "Consumer Discretionary": "XLY",
  "Consumer Staples":       "XLP",
  "Energy":                 "XLE",
  "Utilities":              "XLU",
  "Industrials":            "XLI",
  "Materials":              "XLB",
  "Real Estate":            "XLRE",
  "Communication Services": "XLC",
};

/**
 * Resolve which sector ETF (if any) should be included in the reaction
 * snapshot for a given event.
 */
export function resolveSectorEtf(
  eventType: string,
  securitySector: string | null,
): string | null {
  if (eventType === "earnings" && securitySector) {
    return SECTOR_TO_ETF[securitySector] ?? null;
  }
  const fromMap = EVENT_SECTOR_MAP[eventType];
  return fromMap ?? null;
}

// ── Shared bar matcher ──────────────────────────────────────────────

/** Window (ms) within which a bar is considered "close enough" to the target. */
const BAR_TOLERANCE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Pick the bar nearest a target timestamp, respecting a tolerance.
 * Returns null if no bar lies within tolerance — indicates a data gap
 * (e.g., release happened during a trading halt or off-hours weekend).
 */
export function findNearestBar(
  bars: TimedClose[],
  targetMs: number,
  toleranceMs = BAR_TOLERANCE_MS,
): TimedClose | null {
  let best: TimedClose | null = null;
  let bestDiff = Infinity;
  for (const bar of bars) {
    const diff = Math.abs(bar.tMs - targetMs);
    if (diff < bestDiff) {
      best = bar;
      bestDiff = diff;
    }
  }
  if (!best || bestDiff > toleranceMs) return null;
  return best;
}

/**
 * Given a sorted list of bars and a release instant, compute t_pre
 * (bar closest to T-5min) and t_post (bar closest to T+120min).
 */
export function matchBarsToReaction(
  bars: TimedClose[],
  releaseInstantMs: number,
): BenchmarkReaction | null {
  if (bars.length === 0) return null;
  const preTarget = releaseInstantMs - 5 * 60 * 1000;
  const postTarget = releaseInstantMs + 120 * 60 * 1000;
  const pre = findNearestBar(bars, preTarget);
  const post = findNearestBar(bars, postTarget);
  if (!pre || !post || pre.close === 0) return null;
  const deltaPct = ((post.close - pre.close) / pre.close) * 100;
  return {
    t_pre: Number(pre.close.toFixed(4)),
    t_post: Number(post.close.toFixed(4)),
    delta_pct: Number(deltaPct.toFixed(2)),
  };
}

// ── TWS bar fetch ───────────────────────────────────────────────────

interface TwsBar {
  time?: string;
  close?: number | null;
}

/**
 * Parse TWS bar time: "20250411  08:30:00" → epoch ms (ET).
 *
 * TWS returns bar times in the contract's exchange timezone, which for
 * US equities is America/New_York. We convert to UTC epoch ms for
 * matching against the ISO release instant.
 */
function parseTwsBarTime(raw: string): number {
  // Format: "YYYYMMDD  HH:MM:SS" (double-space separator common in TWS)
  const cleaned = raw.replace(/\s+/, " ").trim();
  const match = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(cleaned);
  if (!match) {
    // Fall back to Date.parse — will likely return NaN for malformed inputs.
    return Date.parse(cleaned);
  }
  const [, y, m, d, hh, mm, ss] = match;
  // Construct the ET wall-clock moment; convert to UTC epoch.
  // We treat the timestamp as ET and use Intl to find the UTC offset.
  const etWallClock = Date.UTC(
    Number(y), Number(m) - 1, Number(d),
    Number(hh), Number(mm), Number(ss),
  );
  // Estimate ET offset for that moment. DST cutovers: second Sunday March,
  // first Sunday November. For a 1-minute-bar use case, EDT vs EST is a
  // ±1h shift that we'd rather get right.
  const etOffsetMin = isEasternDaylight(new Date(etWallClock)) ? -240 : -300;
  return etWallClock - etOffsetMin * 60 * 1000;
}

function isEasternDaylight(d: Date): boolean {
  // US DST 2026 runs Mar 8 – Nov 1 (2nd Sun Mar to 1st Sun Nov).
  const year = d.getUTCFullYear();
  const marSecondSunday = nthSundayOfMonth(year, 2, 2);
  const novFirstSunday  = nthSundayOfMonth(year, 10, 1);
  return d.getTime() >= marSecondSunday && d.getTime() < novFirstSunday;
}

function nthSundayOfMonth(year: number, monthIdx: number, n: number): number {
  const first = new Date(Date.UTC(year, monthIdx, 1));
  const dayOfWeek = first.getUTCDay();
  const firstSunday = 1 + ((7 - dayOfWeek) % 7);
  const target = firstSunday + (n - 1) * 7;
  // DST transitions happen at 07:00 UTC (2am ET). Use that for boundary.
  return Date.UTC(year, monthIdx, target, 7, 0, 0);
}

/**
 * Format a Date for TWS's endDateTime parameter.
 * TWS accepts "YYYYMMDD HH:MM:SS" in the timezone of the primary exchange,
 * or with an explicit timezone suffix. We pass UTC to avoid DST ambiguity.
 */
function formatTwsEndDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

/** Fetch 1-min bars for a single benchmark from TWS. */
async function fetchTwsBars(
  api: IBApiNext,
  symbol: string,
  endInstant: Date,
  timeoutMs = 20_000,
): Promise<TimedClose[]> {
  const contract = {
    symbol,
    secType: SecType.STK,
    exchange: "SMART",
    currency: "USD",
  };
  const endDateTime = formatTwsEndDateTime(endInstant);
  // "9000 S" = 2.5 hours of 1-minute bars
  const bars = (await Promise.race([
    api.getHistoricalData(
      contract,
      endDateTime,
      "9000 S",
      BarSizeSetting.MINUTES_ONE,
      "TRADES",
      1,
      1,
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`TWS bars timeout for ${symbol}`)), timeoutMs),
    ),
  ])) as TwsBar[];

  const timed: TimedClose[] = [];
  for (const bar of bars) {
    if (!bar.time || bar.close == null) continue;
    const tMs = parseTwsBarTime(bar.time);
    if (!Number.isFinite(tMs)) continue;
    timed.push({ tMs, close: Number(bar.close) });
  }
  return timed;
}

/**
 * Primary (Mac-side) reaction capture via TWS.
 *
 * Returns null when TWS can't produce bars for even the core benchmarks.
 * Partial failures (sector ETF missing) degrade gracefully — the snapshot
 * still publishes SPY/QQQ/TLT.
 */
export async function captureReactionFromTws(
  api: IBApiNext,
  releaseInstant: Date,
  sectorEtf: string | null,
  opts: { pacingMs?: number } = {},
): Promise<ReactionSnapshot | null> {
  const pacingMs = opts.pacingMs ?? 500;
  const symbols = [...CORE_BENCHMARKS];
  if (sectorEtf && !symbols.includes(sectorEtf as (typeof CORE_BENCHMARKS)[number])) {
    symbols.push(sectorEtf as (typeof CORE_BENCHMARKS)[number]);
  }

  // TWS must fetch bars up to at least T+120min, plus a small buffer.
  const endInstant = new Date(releaseInstant.getTime() + 125 * 60 * 1000);
  const barsMap: Record<string, TimedClose[]> = {};

  for (const sym of symbols) {
    try {
      barsMap[sym] = await fetchTwsBars(api, sym, endInstant);
    } catch {
      barsMap[sym] = [];
    }
    // Pacing between requests (production: 500ms to stay inside IBKR 60/10min window)
    if (pacingMs > 0) await new Promise((r) => setTimeout(r, pacingMs));
  }

  const releaseMs = releaseInstant.getTime();
  const spy = matchBarsToReaction(barsMap.SPY ?? [], releaseMs);
  const qqq = matchBarsToReaction(barsMap.QQQ ?? [], releaseMs);
  const tlt = matchBarsToReaction(barsMap.TLT ?? [], releaseMs);

  // If all three core benchmarks are null, treat the snapshot as a miss.
  if (!spy && !qqq && !tlt) return null;

  const snapshot: ReactionSnapshot = {
    t0_utc: releaseInstant.toISOString(),
    window_min: 120,
    source: "tws",
    spy: spy ?? { t_pre: 0, t_post: 0, delta_pct: 0 },
    qqq: qqq ?? { t_pre: 0, t_post: 0, delta_pct: 0 },
    tlt: tlt ?? { t_pre: 0, t_post: 0, delta_pct: 0 },
  };

  if (sectorEtf && barsMap[sectorEtf]) {
    const sector = matchBarsToReaction(barsMap[sectorEtf], releaseMs);
    if (sector) {
      snapshot.sector = { symbol: sectorEtf, ...sector };
    }
  }

  return snapshot;
}

/**
 * Compose an ISO release instant from event_date ("YYYY-MM-DD") +
 * release_time ("HH:MM" ET). Returns null if either is malformed.
 */
export function composeReleaseInstant(
  eventDate: string,
  releaseTimeEt: string,
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null;
  if (!/^\d{2}:\d{2}$/.test(releaseTimeEt)) return null;

  const [y, m, d] = eventDate.split("-").map(Number);
  const [hh, mm] = releaseTimeEt.split(":").map(Number);
  // Compose as ET wall-clock then convert to UTC via the same DST helper
  // the bar parser uses, so release_instant and bar times use the same
  // reference frame.
  const etWallUtcNaive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const etOffsetMin = isEasternDaylight(new Date(etWallUtcNaive)) ? -240 : -300;
  const utcMs = etWallUtcNaive - etOffsetMin * 60 * 1000;
  return new Date(utcMs);
}

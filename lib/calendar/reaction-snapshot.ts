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
import { normalizeSector } from "@/lib/securities/normalize-sector";

// ── Types ───────────────────────────────────────────────────────────

export interface BenchmarkReaction {
  t_pre: number;
  t_post: number;
  delta_pct: number;
}

export interface ReactionSnapshot {
  t0_utc: string;
  window_min: 120;
  source: "tws" | "polygon" | "yahoo";
  spy: BenchmarkReaction;
  qqq: BenchmarkReaction;
  tlt: BenchmarkReaction;
  sector?: BenchmarkReaction & { symbol: string };
  // The event's own stock — populated for earnings (and any future event type
  // that passes `eventSymbol`). Lets the recap email say "GLW closed +4.2% vs
  // SPY +0.1%" instead of just the benchmark deltas. Optional because it
  // gracefully degrades if bars for the event symbol aren't available.
  symbol?: BenchmarkReaction & { symbol: string };
  // Present (as "prior_close") when every t_pre in this snapshot is the last
  // regular-session close before the release instead of the near-release bar
  // (earnings rows, 2026-08-04). Absent on macro rows and pre-fix snapshots —
  // renderers use it to label deltas honestly ("vs prior close").
  pre_anchor?: "prior_close";
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
  "Healthcare":             "XLV",
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
    // Defensive normalize: securities.sector is canonical GICS post-2026-06-09,
    // but legacy rows / raw vendor strings may still arrive here.
    const canonical = normalizeSector(securitySector) ?? securitySector;
    return SECTOR_TO_ETF[canonical] ?? null;
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

/** Latest bar at or before a target timestamp; null when none precedes it. */
export function lastBarAtOrBefore(
  bars: TimedClose[],
  targetMs: number,
): TimedClose | null {
  let best: TimedClose | null = null;
  for (const bar of bars) {
    if (bar.tMs <= targetMs && (!best || bar.tMs > best.tMs)) {
      best = bar;
    }
  }
  return best;
}

/**
 * Given a sorted list of bars and a release instant, compute t_pre
 * (bar closest to T-5min) and t_post (bar closest to T+120min).
 *
 * `preAnchorClose` (2026-08-04, earnings rows): when provided, it becomes
 * t_pre verbatim — the prior regular-session close — and no pre bar is
 * required at all. The nearest-bar pre is wrong for earnings twice over:
 * the wire routinely beats the recorded slot (XMTR printed 7:05 against an
 * 8:00 slot, so the "pre" bar was already +8% post-news and the email
 * reported the fade as a -4.8% "reaction"), and humans read a print against
 * yesterday's close anyway. Macro rows never pass an anchor — an 8:30 CPI
 * pre bar really is pre.
 */
export function matchBarsToReaction(
  bars: TimedClose[],
  releaseInstantMs: number,
  preAnchorClose?: number | null,
): BenchmarkReaction | null {
  if (bars.length === 0) return null;
  const postTarget = releaseInstantMs + 120 * 60 * 1000;
  const post = findNearestBar(bars, postTarget);
  if (!post) return null;
  if (preAnchorClose != null && preAnchorClose > 0) {
    const deltaPct = ((post.close - preAnchorClose) / preAnchorClose) * 100;
    return {
      t_pre: Number(preAnchorClose.toFixed(4)),
      t_post: Number(post.close.toFixed(4)),
      delta_pct: Number(deltaPct.toFixed(2)),
    };
  }
  const preTarget = releaseInstantMs - 5 * 60 * 1000;
  const pre = findNearestBar(bars, preTarget);
  if (!pre || pre.close === 0) return null;
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
  // "9000 S" = 2.5 hours of 1-minute bars.
  // useRTH=0 (2026-08-04): extended-hours bars are REQUIRED. RTH-only bars
  // start at 9:30 ET, so every BMO t_pre (7-9am), every AMC t_post (~18:15),
  // and even the 8:30 macro pre bar sat >10min from the nearest bar and the
  // whole capture returned null — the "TWS-always-wins" road silently lost
  // to the Yahoo fallback (which passes includePrePost=true) for every
  // off-hours release. Only mid-session releases (FOMC 14:00) ever worked.
  const bars = (await Promise.race([
    api.getHistoricalData(
      contract,
      endDateTime,
      "9000 S",
      BarSizeSetting.MINUTES_ONE,
      "TRADES",
      0,
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
 * Last completed daily close strictly before the event date — the BMO
 * earnings anchor. Daily bars stamp `time` as bare "YYYYMMDD"; the request
 * may include the event day's partial bar, which must never be the anchor.
 */
async function fetchTwsPriorDailyClose(
  api: IBApiNext,
  symbol: string,
  endInstant: Date,
  eventDate: string,
  timeoutMs = 20_000,
): Promise<number | null> {
  const contract = {
    symbol,
    secType: SecType.STK,
    exchange: "SMART",
    currency: "USD",
  };
  const bars = (await Promise.race([
    api.getHistoricalData(
      contract,
      formatTwsEndDateTime(endInstant),
      "5 D",
      BarSizeSetting.DAYS_ONE,
      "TRADES",
      1,
      1,
    ),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`TWS daily bars timeout for ${symbol}`)),
        timeoutMs,
      ),
    ),
  ])) as TwsBar[];

  const cutoff = eventDate.replace(/-/g, "");
  let prior: number | null = null;
  for (const bar of bars) {
    const day = (bar.time ?? "").slice(0, 8);
    if (!/^\d{8}$/.test(day) || day >= cutoff || bar.close == null) continue;
    // Bars arrive oldest-first; keep overwriting so the LAST pre-event day wins.
    prior = Number(bar.close);
  }
  return prior != null && prior > 0 ? prior : null;
}

/**
 * Primary (Mac-side) reaction capture via TWS.
 *
 * Returns null when TWS can't produce bars for even the core benchmarks.
 * Partial failures (sector ETF missing) degrade gracefully — the snapshot
 * still publishes SPY/QQQ/TLT.
 *
 * `opts.earnings` (2026-08-04): earnings rows anchor every ticker's t_pre to
 * the last regular-session close before the release — the prior day's close
 * for BMO (via a daily-bars request), the event day's ~16:00 bar for AMC
 * (already inside the intraday window). Callers pass
 * `{ closeMs: composeReleaseInstant(event_date, "16:00").getTime(), eventDate }`.
 * Macro rows omit it and keep pure release-window semantics.
 */
export async function captureReactionFromTws(
  api: IBApiNext,
  releaseInstant: Date,
  sectorEtf: string | null,
  opts: {
    pacingMs?: number;
    eventSymbol?: string | null;
    earnings?: { closeMs: number; eventDate: string } | null;
  } = {},
): Promise<ReactionSnapshot | null> {
  const pacingMs = opts.pacingMs ?? 500;
  const eventSymbol = opts.eventSymbol?.trim().toUpperCase() || null;
  const symbols: string[] = [...CORE_BENCHMARKS];
  if (sectorEtf && !symbols.includes(sectorEtf)) {
    symbols.push(sectorEtf);
  }
  // Add event symbol last — its capture is best-effort and gates only the
  // optional `symbol` field in the snapshot. Skip if it's already in the
  // basket (e.g., a SPY-on-SPY hypothetical or sector ETF == event symbol).
  if (eventSymbol && !symbols.includes(eventSymbol)) {
    symbols.push(eventSymbol);
  }

  const releaseMs = releaseInstant.getTime();
  const earnings = opts.earnings ?? null;
  const isBmo = earnings != null && releaseMs < earnings.closeMs;

  // TWS must fetch bars up to at least T+120min, plus a small buffer.
  const endInstant = new Date(releaseMs + 125 * 60 * 1000);
  const barsMap: Record<string, TimedClose[]> = {};
  const anchorMap: Record<string, number | null> = {};

  for (const sym of symbols) {
    try {
      barsMap[sym] = await fetchTwsBars(api, sym, endInstant);
    } catch {
      barsMap[sym] = [];
    }
    // Pacing between requests (production: 500ms to stay inside IBKR 60/10min window)
    if (pacingMs > 0) await new Promise((r) => setTimeout(r, pacingMs));

    if (earnings) {
      if (isBmo) {
        // BMO: prior session's daily close (never in the 2.5h intraday window).
        try {
          anchorMap[sym] = await fetchTwsPriorDailyClose(
            api,
            sym,
            releaseInstant,
            earnings.eventDate,
          );
        } catch {
          anchorMap[sym] = null;
        }
        if (pacingMs > 0) await new Promise((r) => setTimeout(r, pacingMs));
      } else {
        // AMC: the event day's official close — last bar at/before 16:00 ET.
        // Never a later after-hours bar: the wire can beat the recorded slot,
        // and a post-16:00 bar may already carry the reaction.
        anchorMap[sym] = lastBarAtOrBefore(barsMap[sym], earnings.closeMs)?.close ?? null;
      }
    }
  }

  const anchorFor = (sym: string): number | null =>
    earnings ? (anchorMap[sym] ?? null) : null;

  const spy = matchBarsToReaction(barsMap.SPY ?? [], releaseMs, anchorFor("SPY"));
  const qqq = matchBarsToReaction(barsMap.QQQ ?? [], releaseMs, anchorFor("QQQ"));
  const tlt = matchBarsToReaction(barsMap.TLT ?? [], releaseMs, anchorFor("TLT"));

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
  // Label only when an anchor was actually applied — if every anchor lookup
  // failed, the matcher silently fell back to window semantics and labeling
  // the snapshot "prior_close" would misdescribe the numbers.
  if (earnings && Object.values(anchorMap).some((v) => v != null && v > 0)) {
    snapshot.pre_anchor = "prior_close";
  }

  if (sectorEtf && barsMap[sectorEtf]) {
    const sector = matchBarsToReaction(barsMap[sectorEtf], releaseMs, anchorFor(sectorEtf));
    if (sector) {
      snapshot.sector = { symbol: sectorEtf, ...sector };
    }
  }

  if (eventSymbol && barsMap[eventSymbol]) {
    const symbolReaction = matchBarsToReaction(
      barsMap[eventSymbol],
      releaseMs,
      anchorFor(eventSymbol),
    );
    if (symbolReaction) {
      snapshot.symbol = { symbol: eventSymbol, ...symbolReaction };
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

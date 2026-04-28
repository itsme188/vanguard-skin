/**
 * Worker-side mirror of the pure helpers in lib/calendar/reaction-snapshot.ts.
 *
 * Cloudflare Workers can't import from the Mac's `lib/` via Next path aliases,
 * so these three helpers are copied by hand. They are pure (no fetch, no db,
 * no side effects) — a byte-identical-JSON-output test in tests/workers/
 * pins the copy to the source. If you change either side, update both.
 *
 * The port covers:
 *   - findNearestBar
 *   - matchBarsToReaction
 *   - composeReleaseInstant (ET wall-clock → UTC Date, DST-aware)
 *   - isEasternDaylight helper
 *   - TimedClose + BenchmarkReaction + ReactionSnapshot types
 *   - resolveSectorEtf + EVENT_SECTOR_MAP + SECTOR_TO_ETF (needed to pick the
 *     sector ETF on the cloud path without going back to the Mac)
 */

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
  // Mirror of the Mac-side type — `lib/calendar/reaction-snapshot.ts`. The
  // event symbol's own bars; lets the recap email contrast the stock with
  // the benchmarks. Optional because cloud + Mac paths both degrade
  // gracefully when bars for the event symbol are unavailable.
  symbol?: BenchmarkReaction & { symbol: string };
}

export interface TimedClose {
  tMs: number;
  close: number;
}

// ── Sector mapping ──────────────────────────────────────────────────

export const CORE_BENCHMARKS = ["SPY", "QQQ", "TLT"] as const;

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

// ── Bar matcher ─────────────────────────────────────────────────────

const BAR_TOLERANCE_MS = 10 * 60 * 1000;

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

// ── ET → UTC composition (DST-aware) ────────────────────────────────

function nthSundayOfMonth(year: number, monthIdx: number, n: number): number {
  const first = new Date(Date.UTC(year, monthIdx, 1));
  const dayOfWeek = first.getUTCDay();
  const firstSunday = 1 + ((7 - dayOfWeek) % 7);
  const target = firstSunday + (n - 1) * 7;
  return Date.UTC(year, monthIdx, target, 7, 0, 0);
}

export function isEasternDaylight(d: Date): boolean {
  const year = d.getUTCFullYear();
  const marSecondSunday = nthSundayOfMonth(year, 2, 2);
  const novFirstSunday  = nthSundayOfMonth(year, 10, 1);
  return d.getTime() >= marSecondSunday && d.getTime() < novFirstSunday;
}

export function composeReleaseInstant(
  eventDate: string,
  releaseTimeEt: string,
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null;
  if (!/^\d{2}:\d{2}$/.test(releaseTimeEt)) return null;

  const [y, m, d] = eventDate.split("-").map(Number);
  const [hh, mm] = releaseTimeEt.split(":").map(Number);
  const etWallUtcNaive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const etOffsetMin = isEasternDaylight(new Date(etWallUtcNaive)) ? -240 : -300;
  const utcMs = etWallUtcNaive - etOffsetMin * 60 * 1000;
  return new Date(utcMs);
}

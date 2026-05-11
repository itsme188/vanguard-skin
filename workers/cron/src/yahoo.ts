/**
 * Yahoo Finance 1-minute bar client for the Worker's cloud-enrich path.
 *
 * Endpoint: /v8/finance/chart/{symbol}?interval=1m&period1={epoch}&period2={epoch}
 * No auth required. Retention: ~10+ days of 1-minute history for liquid US
 * ETFs (SPY, QQQ, TLT, sector ETFs).
 *
 * Why Yahoo over the paid alternatives:
 *   - Polygon Starter $29/mo has 15-min delay → events tick out of our 2h
 *     candidate window before Polygon catches up. Advanced ($199/mo) is
 *     real-time but wildly overpriced for our volume.
 *   - Finnhub /stock/candle is paid-only since 2024 (verified 2026-04-25 —
 *     free tier returns "You don't have access to this resource.").
 *   - Yahoo is free, real-time, well-retained, and has been stable at this
 *     URL for years. Risk: unofficial endpoint could break without notice.
 *     Mitigation: graceful null fallback (same degradation as TWS path).
 *
 * Response shape (trimmed):
 *   {
 *     chart: {
 *       result: [{
 *         timestamp: number[],              // epoch seconds
 *         indicators: {
 *           quote: [{ close: (number|null)[] }]
 *         }
 *       }]
 *     }
 *   }
 */

import {
  matchBarsToReaction,
  CORE_BENCHMARKS,
  type ReactionSnapshot,
  type TimedClose,
} from "./reaction-matcher";

interface YahooChartResult {
  timestamp?: number[];
  indicators?: {
    quote?: Array<{ close?: Array<number | null> }>;
  };
}

interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[];
    error?: { code?: string; description?: string } | null;
  };
}

async function fetchYahooBars(
  symbol: string,
  fromSec: number,
  toSec: number,
): Promise<TimedClose[]> {
  // includePrePost=true is required for earnings releases that land outside
  // regular session (pre-market 04:00–09:30 ET or after-hours 16:00–20:00 ET).
  // Without it, a 16:15 ET earnings release returns zero post-window bars and
  // the reaction snapshot drops to NULL.
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1m&period1=${fromSec}&period2=${toSec}&includePrePost=true`;

  // Yahoo rate-limits default User-Agents much more aggressively than
  // browser UAs. A plain "Mozilla/5.0" is enough to avoid the python-
  // urllib-style throttling.
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) return [];

  const data = (await res.json()) as YahooChartResponse;
  const result = data.chart?.result?.[0];
  if (!result) return [];
  const ts = result.timestamp ?? [];
  const close = result.indicators?.quote?.[0]?.close ?? [];
  if (ts.length === 0 || close.length === 0) return [];

  const bars: TimedClose[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c == null) continue;
    bars.push({ tMs: ts[i] * 1000, close: c });
  }
  return bars;
}

/**
 * Fetch the most recent close price from Yahoo for a symbol.
 *
 * Used by the cloud-side level scan to compare against active price levels
 * when Mac is asleep. Pulls a 15-minute window of 1-min bars and returns the
 * last non-null close; returns null on empty/error so caller can fall through.
 *
 * Single fetch, no pacing — caller orchestrates per-symbol pacing for batches.
 */
export async function fetchYahooLastPrice(
  symbol: string,
): Promise<{ price: number; tMs: number } | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  // 15 min lookback is enough to find a recent print during market hours and
  // captures the last close + a buffer when called shortly after the bell.
  const fromSec = nowSec - 15 * 60;
  try {
    const bars = await fetchYahooBars(symbol, fromSec, nowSec);
    if (bars.length === 0) return null;
    const last = bars[bars.length - 1];
    return { price: last.close, tMs: last.tMs };
  } catch {
    return null;
  }
}

/**
 * Fetch 1-min bars for SPY/QQQ/TLT (+ optional sector ETF) around a release
 * instant and compute per-benchmark reaction. Returns null if all three core
 * benchmarks produce no bars (data gap — off-hours release or Yahoo outage).
 *
 * Emits identical JSON shape to captureReactionFromTws; only `source`
 * differs (`"yahoo"` vs `"tws"`), so downstream reconcile + UI render the
 * same way.
 */
export async function captureReactionFromYahoo(
  releaseInstant: Date,
  sectorEtf: string | null,
  opts: { pacingMs?: number; eventSymbol?: string | null } = {},
): Promise<ReactionSnapshot | null> {
  const pacingMs = opts.pacingMs ?? 200;
  const eventSymbol = opts.eventSymbol?.trim().toUpperCase() || null;
  const releaseMs = releaseInstant.getTime();
  // Window covers pre (T-5min) and post (T+120min) with buffer.
  const fromSec = Math.floor((releaseMs - 15 * 60 * 1000) / 1000);
  const toSec = Math.ceil((releaseMs + 125 * 60 * 1000) / 1000);

  const symbols: string[] = [...CORE_BENCHMARKS];
  if (sectorEtf && !symbols.includes(sectorEtf)) symbols.push(sectorEtf);
  if (eventSymbol && !symbols.includes(eventSymbol)) symbols.push(eventSymbol);

  const barsMap: Record<string, TimedClose[]> = {};
  for (const sym of symbols) {
    try {
      barsMap[sym] = await fetchYahooBars(sym, fromSec, toSec);
    } catch {
      barsMap[sym] = [];
    }
    if (pacingMs > 0 && sym !== symbols[symbols.length - 1]) {
      await new Promise((r) => setTimeout(r, pacingMs));
    }
  }

  const spy = matchBarsToReaction(barsMap.SPY ?? [], releaseMs);
  const qqq = matchBarsToReaction(barsMap.QQQ ?? [], releaseMs);
  const tlt = matchBarsToReaction(barsMap.TLT ?? [], releaseMs);

  if (!spy && !qqq && !tlt) return null;

  const snapshot: ReactionSnapshot = {
    t0_utc: releaseInstant.toISOString(),
    window_min: 120,
    source: "yahoo",
    spy: spy ?? { t_pre: 0, t_post: 0, delta_pct: 0 },
    qqq: qqq ?? { t_pre: 0, t_post: 0, delta_pct: 0 },
    tlt: tlt ?? { t_pre: 0, t_post: 0, delta_pct: 0 },
  };

  if (sectorEtf && barsMap[sectorEtf]) {
    const sector = matchBarsToReaction(barsMap[sectorEtf], releaseMs);
    if (sector) snapshot.sector = { symbol: sectorEtf, ...sector };
  }

  if (eventSymbol && barsMap[eventSymbol]) {
    const symbolReaction = matchBarsToReaction(barsMap[eventSymbol], releaseMs);
    if (symbolReaction) snapshot.symbol = { symbol: eventSymbol, ...symbolReaction };
  }

  return snapshot;
}

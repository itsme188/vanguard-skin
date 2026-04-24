/**
 * Polygon.io 1-minute aggregates client for the Worker's cloud-enrich path.
 *
 * Endpoint: /v2/aggs/ticker/{symbol}/range/1/minute/{from_ms}/{to_ms}
 * Docs:     https://polygon.io/docs/rest/stocks/aggregates
 *
 * Tier: Starter ($29/mo). Free tier limits are 5 req/min which would starve
 * the 4-symbol (SPY/QQQ/TLT + sector ETF) fetches we do per candidate.
 *
 * This client is deliberately minimal — fetch → parse → map to TimedClose[].
 * Error handling: null on non-200 (same degradation as TWS path). Per-symbol
 * failure does not abort the remaining symbol fetches.
 */

import {
  matchBarsToReaction,
  CORE_BENCHMARKS,
  type ReactionSnapshot,
  type TimedClose,
} from "./reaction-matcher";

interface PolygonAgg {
  t: number;  // epoch ms
  c: number;  // close
  v?: number;
}

interface PolygonAggsResponse {
  ticker?: string;
  status?: string;
  resultsCount?: number;
  results?: PolygonAgg[];
}

async function fetchPolygonBars(
  apiKey: string,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<TimedClose[]> {
  const url =
    `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}` +
    `/range/1/minute/${fromMs}/${toMs}` +
    `?adjusted=true&sort=asc&limit=250&apiKey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as PolygonAggsResponse;
  if (!data.results || data.results.length === 0) return [];
  return data.results.map((bar) => ({ tMs: bar.t, close: bar.c }));
}

/**
 * Fetch 1-min bars for SPY/QQQ/TLT (+ optional sector ETF) around a release
 * instant and compute per-benchmark reaction. Returns null if all three core
 * benchmarks produce no bars (data gap — off-hours release or Polygon outage).
 *
 * Mirrors the shape of captureReactionFromTws so the DB stores identical
 * JSON structure; only `source` differs ("polygon" vs "tws").
 */
export async function captureReactionFromPolygon(
  apiKey: string,
  releaseInstant: Date,
  sectorEtf: string | null,
  opts: { pacingMs?: number } = {},
): Promise<ReactionSnapshot | null> {
  const pacingMs = opts.pacingMs ?? 300;
  const releaseMs = releaseInstant.getTime();
  // Fetch a window that covers pre (T-5min) and post (T+120min) with buffer.
  const fromMs = releaseMs - 15 * 60 * 1000;
  const toMs   = releaseMs + 125 * 60 * 1000;

  const symbols: string[] = [...CORE_BENCHMARKS];
  if (sectorEtf && !symbols.includes(sectorEtf)) symbols.push(sectorEtf);

  const barsMap: Record<string, TimedClose[]> = {};
  for (const sym of symbols) {
    try {
      barsMap[sym] = await fetchPolygonBars(apiKey, sym, fromMs, toMs);
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
    source: "polygon",
    spy: spy ?? { t_pre: 0, t_post: 0, delta_pct: 0 },
    qqq: qqq ?? { t_pre: 0, t_post: 0, delta_pct: 0 },
    tlt: tlt ?? { t_pre: 0, t_post: 0, delta_pct: 0 },
  };

  if (sectorEtf && barsMap[sectorEtf]) {
    const sector = matchBarsToReaction(barsMap[sectorEtf], releaseMs);
    if (sector) snapshot.sector = { symbol: sectorEtf, ...sector };
  }

  return snapshot;
}

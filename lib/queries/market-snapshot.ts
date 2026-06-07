/**
 * market-snapshot.ts — "what's the market doing" data for the chat assistant.
 *
 * Local-first: read the latest vs prior close for the major benchmarks
 * (SPY/QQQ/DIA) + the user's held names from the local `prices` table, using
 * the same SPY-anchored consecutive-trading-day pair the anomaly engine uses
 * (so a phantom weekend row or a single stale name can't poison the move).
 *
 * Yahoo fallback: only when the local book is STALE (the Mac has been offline
 * past the freshness window) or has no clean pair at all. The caller injects
 * the quote fetcher so the local path stays a pure, deterministic unit.
 *
 * Every result carries an explicit `asOf` + `stale` + human-readable `note` so
 * the chat system prompt can force the model to be honest about freshness
 * instead of confabulating today's action (the 2026-06-05 failure mode).
 */

import type Database from "better-sqlite3";
import { resolveTradingDayPair } from "@/lib/digest/anomalies";
import { getHoldingsForChat } from "@/lib/queries/chat-tools";
import { todayET, calendarDaysBetween } from "@/lib/calendar/date-utils";

/** Calendar-day tolerance before the local book counts as stale. Matches the
 *  levels stale-price guard: tolerates Fri→Mon + a long-weekend Monday. */
export const MARKET_SNAPSHOT_STALE_DAYS = 4;

/** Major market benchmarks surfaced first, in display order. */
export const DEFAULT_BENCHMARKS = ["SPY", "QQQ", "DIA"];

export interface MarketMove {
  symbol: string;
  name: string | null;
  /** Percent change of latest close vs prior close (or live vs prior on Yahoo). */
  pct: number;
  kind: "benchmark" | "holding";
}

export interface MarketSnapshot {
  source: "local" | "yahoo" | "none";
  /** Date the data represents (YYYY-MM-DD), or null when nothing is available. */
  asOf: string | null;
  /** True when the data is NOT the most recent session (local book behind). */
  stale: boolean;
  /** Calendar days the local book is behind `today` (local path only). */
  staleDays: number | null;
  moves: MarketMove[];
  /** Freshness caveat for the model — always state it to the user. */
  note: string;
}

/** Live-quote fetcher (Yahoo). Injected so the local path is unit-testable.
 *  Returns a map of symbol → { price (latest), prior (previous close) }, or
 *  null when the live source is unavailable. */
export type QuoteFetcher = (
  symbols: string[],
) => Promise<Record<string, { price: number; prior: number }> | null>;

interface SnapshotOptions {
  today?: string;
  fetchQuotes?: QuoteFetcher;
  benchmarks?: string[];
}

/**
 * Default live-quote fetcher — Yahoo Finance chart `meta` (free, no auth).
 * `regularMarketPrice` + `previousClose` give the current print and the prior
 * close in one call. This is a thin network adapter (the DI boundary); the
 * snapshot logic is unit-tested with an injected stub. Returns null if every
 * symbol fails so the caller degrades to stale-local / none.
 */
export const fetchYahooQuotes: QuoteFetcher = async (symbols) => {
  const out: Record<string, { price: number; prior: number }> = {};
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const url =
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
          `?interval=1d&range=5d`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) return;
        const json = (await res.json()) as {
          chart?: { result?: { meta?: { regularMarketPrice?: number; previousClose?: number; chartPreviousClose?: number } }[] };
        };
        const meta = json?.chart?.result?.[0]?.meta;
        const price = meta?.regularMarketPrice;
        const prior = meta?.chartPreviousClose ?? meta?.previousClose;
        if (typeof price === "number" && typeof prior === "number" && prior !== 0) {
          out[sym.toUpperCase()] = { price, prior };
        }
      } catch {
        /* skip this symbol */
      }
    }),
  );
  return Object.keys(out).length > 0 ? out : null;
};

interface UniverseEntry {
  symbol: string;
  name: string | null;
  kind: "benchmark" | "holding";
}

/** Distinct (benchmark + held) symbols, benchmarks first, no duplicates. */
function buildUniverse(db: Database.Database, benchmarks: string[]): UniverseEntry[] {
  const seen = new Set<string>();
  const universe: UniverseEntry[] = [];
  for (const symbol of benchmarks) {
    const up = symbol.toUpperCase();
    if (seen.has(up)) continue;
    seen.add(up);
    universe.push({ symbol: up, name: null, kind: "benchmark" });
  }
  for (const h of getHoldingsForChat(db)) {
    const up = h.symbol?.toUpperCase();
    if (!up || seen.has(up)) continue;
    seen.add(up);
    universe.push({ symbol: up, name: h.security_name, kind: "holding" });
  }
  return universe;
}

function closeOn(db: Database.Database, symbol: string, date: string): number | null {
  const row = db
    .prepare(
      `SELECT p.close_price AS close
         FROM prices p
         JOIN securities s ON s.id = p.security_id
        WHERE UPPER(s.symbol) = UPPER(?) AND p.date = ?
        ORDER BY p.close_price DESC
        LIMIT 1`,
    )
    .get(symbol, date) as { close: number } | undefined;
  return row?.close ?? null;
}

function pct(latest: number, prior: number): number {
  return ((latest - prior) / prior) * 100;
}

/**
 * Resolve a market snapshot, local-first with Yahoo fallback.
 */
export async function getMarketSnapshot(
  db: Database.Database,
  opts: SnapshotOptions = {},
): Promise<MarketSnapshot> {
  const today = opts.today ?? todayET();
  const benchmarks = opts.benchmarks ?? DEFAULT_BENCHMARKS;
  const universe = buildUniverse(db, benchmarks);

  // ── Local path ──────────────────────────────────────────────────────────────
  const pair = resolveTradingDayPair(db);
  let localMoves: MarketMove[] = [];
  let staleDays: number | null = null;
  let localStale = true;

  if (pair) {
    localMoves = universe
      .map((u): MarketMove | null => {
        const latest = closeOn(db, u.symbol, pair.latest);
        const prior = closeOn(db, u.symbol, pair.prior);
        if (latest == null || prior == null || prior === 0) return null;
        return { symbol: u.symbol, name: u.name, pct: pct(latest, prior), kind: u.kind };
      })
      .filter((m): m is MarketMove => m !== null);
    staleDays = calendarDaysBetween(pair.latest, today);
    localStale = staleDays > MARKET_SNAPSHOT_STALE_DAYS;
  }

  // Fresh local data wins outright (local-first) — no live call.
  if (pair && localMoves.length > 0 && !localStale) {
    return {
      source: "local",
      asOf: pair.latest,
      stale: false,
      staleDays,
      moves: localMoves,
      note: `Closing prices as of ${pair.latest} (local book). Intraday moves during the current session are not reflected.`,
    };
  }

  // ── Yahoo fallback (local missing or stale) ───────────────────────────────────
  if (opts.fetchQuotes) {
    let quotes: Awaited<ReturnType<QuoteFetcher>> = null;
    try {
      quotes = await opts.fetchQuotes(universe.map((u) => u.symbol));
    } catch {
      quotes = null;
    }
    if (quotes) {
      const moves = universe
        .map((u): MarketMove | null => {
          const q = quotes![u.symbol];
          if (!q || q.prior === 0) return null;
          return { symbol: u.symbol, name: u.name, pct: pct(q.price, q.prior), kind: u.kind };
        })
        .filter((m): m is MarketMove => m !== null);
      if (moves.length > 0) {
        return {
          source: "yahoo",
          asOf: today,
          stale: false,
          staleDays: null,
          moves,
          note: `Live quotes via Yahoo Finance (as of ${today}); the local book was behind so this is a best-effort live fallback.`,
        };
      }
    }
  }

  // ── Degraded: stale local if we have it, else nothing ─────────────────────────
  if (pair && localMoves.length > 0) {
    return {
      source: "local",
      asOf: pair.latest,
      stale: true,
      staleDays,
      moves: localMoves,
      note: `Local book is ${staleDays} day(s) behind (latest close ${pair.latest}) and live data is unavailable — treat these as STALE and tell the user the data is not current.`,
    };
  }

  return {
    source: "none",
    asOf: null,
    stale: true,
    staleDays: null,
    moves: [],
    note: `No current market data is available. Do not state today's market moves; tell the user the data is unavailable.`,
  };
}

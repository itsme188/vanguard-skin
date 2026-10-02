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
  /** True when the data is NOT the most recent session (local book behind,
   *  or Yahoo quotes more than 3 calendar days old). */
  stale: boolean;
  /** Calendar days the data is behind `today` (local book, or the Yahoo
   *  quotes' own session date). */
  staleDays: number | null;
  moves: MarketMove[];
  /** Freshness caveat for the model — always state it to the user. */
  note: string;
}

/** One live quote: latest price, the PREVIOUS SESSION's close, and the ET
 *  calendar date of the quote itself (null when the source did not say). */
export interface LiveQuote {
  price: number;
  prior: number;
  asOf?: string | null;
}

/** Live-quote fetcher (Yahoo). Injected so the local path is unit-testable.
 *  Returns a map of symbol → LiveQuote, or null when the live source is
 *  unavailable. */
export type QuoteFetcher = (
  symbols: string[],
) => Promise<Record<string, LiveQuote> | null>;

interface SnapshotOptions {
  today?: string;
  fetchQuotes?: QuoteFetcher;
  benchmarks?: string[];
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Parse one Yahoo v8 chart response (`interval=1d&range=5d`) into a
 * one-session quote. Pure — exported for tests.
 *
 * The prior close is the close of the daily bar BEFORE the latest priced bar.
 * During a session the latest bar is today's partial bar (so prior = the last
 * completed session); pre-open / after a weekend the latest bar is the last
 * completed session (so the move is that session's move, dated by
 * `regularMarketTime`). No clock-time special-casing — the bar structure
 * handles both.
 *
 * NEVER `meta.chartPreviousClose`: that is the close before the whole range
 * window (about a week ago on `range=5d`), which turns every "move" into a
 * multi-day move. `meta.previousClose` is used only when the series has fewer
 * than two priced bars.
 */
export function parseYahooChart(json: unknown): LiveQuote | null {
  const result = (json as {
    chart?: {
      result?: {
        meta?: { regularMarketPrice?: unknown; previousClose?: unknown; regularMarketTime?: unknown };
        timestamp?: unknown;
        indicators?: { quote?: { close?: unknown }[] };
      }[];
    };
  } | null)?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta ?? {};

  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closesRaw = result.indicators?.quote?.[0]?.close;
  const closes = Array.isArray(closesRaw) ? closesRaw : [];
  const bars: { t: number; close: number }[] = [];
  for (let i = 0; i < Math.min(timestamps.length, closes.length); i++) {
    const t = timestamps[i];
    const c = closes[i];
    if (finite(t) && finite(c) && c > 0) bars.push({ t, close: c });
  }
  bars.sort((a, b) => a.t - b.t);

  const latestBar = bars.length > 0 ? bars[bars.length - 1] : null;
  const price = finite(meta.regularMarketPrice) ? meta.regularMarketPrice : latestBar?.close;
  const prior =
    bars.length >= 2
      ? bars[bars.length - 2].close
      : finite(meta.previousClose)
        ? meta.previousClose
        : undefined;
  if (!finite(price) || !finite(prior) || prior === 0) return null;

  const asOf = finite(meta.regularMarketTime)
    ? todayET(new Date(meta.regularMarketTime * 1000))
    : null;
  return { price, prior, asOf };
}

/**
 * Default live-quote fetcher — Yahoo Finance v8 chart (free, no auth), parsed
 * by `parseYahooChart`. This is a thin network adapter (the DI boundary); the
 * snapshot logic is unit-tested with an injected stub. Returns null if every
 * symbol fails so the caller degrades to stale-local / none.
 */
export const fetchYahooQuotes: QuoteFetcher = async (symbols) => {
  const out: Record<string, LiveQuote> = {};
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const url =
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
          `?interval=1d&range=5d`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) return;
        const quote = parseYahooChart(await res.json());
        if (quote) out[sym.toUpperCase()] = quote;
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
  if (row?.close != null) return row.close;

  // Benchmark fallback — tracked-not-held index ETFs (DIA) live only in
  // benchmark_prices (Yahoo top-off path), never in prices. Same precedent
  // as findCrossedLevels' benchmark CTE.
  const bench = db
    .prepare(
      `SELECT close_price AS close
         FROM benchmark_prices
        WHERE UPPER(symbol) = UPPER(?) AND date = ?
        LIMIT 1`,
    )
    .get(symbol, date) as { close: number } | undefined;
  return bench?.close ?? null;
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
        // Date the snapshot by the quotes' own session (the most common
        // per-symbol ET date; ties → the later date), not by today — pre-open
        // or on a weekend the latest Yahoo session is an earlier day.
        const counts = new Map<string, number>();
        for (const u of universe) {
          const d = quotes[u.symbol]?.asOf;
          if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
        }
        let asOf: string | null = null;
        let best = 0;
        for (const [d, n] of counts) {
          if (n > best || (n === best && asOf !== null && d > asOf)) {
            asOf = d;
            best = n;
          }
        }
        const quoteDate = asOf ?? today;
        const yahooStaleDays = Math.max(0, calendarDaysBetween(quoteDate, today));
        // A gap of up to 3 calendar days is the normal "latest session" case
        // (pre-open → yesterday, Monday pre-open → Friday). Beyond that the
        // quotes are genuinely behind.
        const yahooStale = yahooStaleDays > 3;
        const sessionNote =
          quoteDate === today
            ? `Live quotes via Yahoo Finance; moves are the latest session (${quoteDate}) vs the prior session close.`
            : `Live quotes via Yahoo Finance; moves are the latest session (${quoteDate}) vs the prior session close. The market has not printed a newer session since ${quoteDate}, so these are NOT today's moves — say they are the ${quoteDate} session.`;
        return {
          source: "yahoo",
          asOf: quoteDate,
          stale: yahooStale,
          staleDays: yahooStaleDays,
          moves,
          note: `${sessionNote} The local book was behind so this is a best-effort live fallback.`,
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

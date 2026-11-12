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
 * Owner ruling A (2026-11-12): the fallback asks ONLY for the three index
 * funds (`OUTSIDE_QUOTE_SYMBOLS`). A held ticker is never sent outside. A held
 * name without a fresh local price comes back from the local book, stale,
 * with `price_as_of` (the date of its last local price) and no move the book
 * does not have. Guard: tests/queries/market-snapshot-no-held-tickers-outside.test.ts.
 *
 * Every result carries an explicit `asOf` + `stale` + human-readable `note` so
 * the chat system prompt can force the model to be honest about freshness
 * instead of confabulating today's action (the 2026-06-05 failure mode).
 */

import type Database from "better-sqlite3";
import { resolveTradingDayPair, type TradingDayPair } from "@/lib/digest/anomalies";
import { getIbkrTodayHoldings, type TodayHolding } from "@/lib/queries/today-holdings";
import type { DayMoveBasis } from "@/lib/compute/day-move";
import { todayET, nowET, calendarDaysBetween } from "@/lib/calendar/date-utils";
import { isMarketClosed } from "@/lib/calendar/market-holidays";

/** Calendar-day tolerance before the local book counts as stale. Matches the
 *  levels stale-price guard: tolerates Fri→Mon + a long-weekend Monday. */
export const MARKET_SNAPSHOT_STALE_DAYS = 4;

/** Major market benchmarks surfaced first, in display order. */
export const DEFAULT_BENCHMARKS = ["SPY", "QQQ", "DIA"];

/**
 * The ONLY symbols ever sent to the outside quote source (owner ruling A,
 * 2026-11-12): the three index funds. A benchmark list naming anything else
 * still sends only these; a held ticker is never sent.
 */
export const OUTSIDE_QUOTE_SYMBOLS: ReadonlySet<string> = new Set(["SPY", "QQQ", "DIA"]);

export interface MarketMove {
  symbol: string;
  name: string | null;
  /**
   * Percent change of latest close vs prior close (or live vs prior on Yahoo).
   * null on a held row whose name has NO prior close in the local book (a
   * name first bought during the session): there is no price move to
   * report, but the row still carries its position and `day_effect`.
   */
  pct: number | null;
  kind: "benchmark" | "holding";
  /**
   * Direction of the held position, holdings only. `pct` is the PRICE move,
   * so a short (or a written option) LOSES when pct is positive. A symbol
   * held long in one account and short in another is TWO rows, one per side
   * (owner ruling 2026-10-08; there is no "mixed").
   */
  position?: MarketPosition;
  // ── Holdings only (absent on benchmark rows) ──────────────────────────────
  /** Accounts holding this side of the symbol, sorted by name. */
  accounts?: string[];
  /** Signed quantity on this side, summed over `accounts`. Negative = short. */
  quantity?: number;
  /** Signed market value in USD at the latest local price, summed over
   *  `accounts`; null when any leg has no price. */
  market_value?: number | null;
  /**
   * The session's dollar effect on this row in USD, measured with the Today
   * line's rule (lib/compute/day-move.ts): quantity held through the session
   * is measured close to close, quantity opened or added is measured from its
   * own cost. null = not measured; `day_effect_reason` says why.
   */
  day_effect?: number | null;
  /** How `day_effect` was measured. */
  day_effect_basis?: DayMoveBasis;
  /** True when `day_effect` covers only some of `accounts` (the rest are
   *  named in `day_effect_reason`). */
  day_effect_partial?: boolean;
  /** A leg of this row was opened during the session. */
  opened_today?: boolean;
  /** A leg of this row was held before and added to during the session. */
  added_today?: boolean;
  /** Why `day_effect` is null, partial, or leaves quantity out; else null. */
  day_effect_reason?: string | null;
  /**
   * Holdings only: the date of the price this row reads (YYYY-MM-DD): the
   * local book's last price for the name, or the index quote's session for a
   * held index fund on the live fallback. null when the book has no price.
   */
  price_as_of?: string | null;
  /**
   * Holdings only: true when this row's price is not the snapshot's session
   * (`price_as_of` differs from `asOf`, or there is none), or the whole
   * snapshot is stale. A stale row's `pct` is the book's move on
   * `price_as_of`, never the current session's.
   */
  price_stale?: boolean;
}

export type MarketPosition = "long" | "short";

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
  /** Injected clock for the session-aware note (tests). Defaults to the real clock. */
  now?: Date;
  fetchQuotes?: QuoteFetcher;
  benchmarks?: string[];
  /**
   * Exact account name: held rows cover this account only (a single-account
   * chat must not see other accounts' positions). A name matching no account
   * yields no held rows, never the whole book. Omitted = every account.
   */
  accountName?: string;
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

/** Most Yahoo requests `fetchYahooQuotes` keeps in flight at once. */
export const YAHOO_QUOTE_CONCURRENCY = 6;

/**
 * Default live-quote fetcher — Yahoo Finance v8 chart (free, no auth), parsed
 * by `parseYahooChart`. This is a thin network adapter (the DI boundary); the
 * snapshot logic is unit-tested with an injected stub. Returns null if every
 * symbol fails so the caller degrades to stale-local / none.
 */
export const fetchYahooQuotes: QuoteFetcher = async (symbols) => {
  const out: Record<string, LiveQuote> = {};
  // Fixed pool: each worker takes the next symbol until the list is empty, so
  // at most YAHOO_QUOTE_CONCURRENCY requests are in flight (the universe is
  // the whole book, not a top-50 slice).
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < symbols.length) {
      const sym = symbols[next++];
      try {
        const url =
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
          `?interval=1d&range=5d`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) continue;
        const quote = parseYahooChart(await res.json());
        if (quote) out[sym.toUpperCase()] = quote;
      } catch {
        /* skip this symbol */
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(YAHOO_QUOTE_CONCURRENCY, symbols.length) }, () => worker()),
  );
  return Object.keys(out).length > 0 ? out : null;
};

/** One account's position in one security, with its day move already measured. */
interface HeldLeg {
  account: string;
  holding: TodayHolding;
}

interface UniverseEntry {
  symbol: string;
  name: string | null;
  kind: "benchmark" | "holding";
  position?: MarketPosition;
  /** True only for an index fund in OUTSIDE_QUOTE_SYMBOLS listed as a benchmark. */
  outsideQuote: boolean;
  /** Holdings only: every account's leg on this side of the symbol. */
  legs?: HeldLeg[];
}

/**
 * Benchmarks first, then one entry per held (symbol, side).
 *
 * Full held universe, shorts included. A short's move is the security's price
 * move (closeOn is price-only): the sign is not flipped, so each entry carries
 * the position's direction instead. A symbol held on the same side in several
 * accounts is one entry; long in one account and short in another is two.
 *
 * Each account's rows come from `getIbkrTodayHoldings` (despite the name it
 * takes any account id): the ONE implementation of the opened-today rule, so
 * the chat's dollar day effect and the Today line cannot disagree. A held
 * benchmark keeps its benchmark row AND gets a holding row, because only the
 * holding row carries dollars.
 */
function buildUniverse(
  db: Database.Database,
  benchmarks: string[],
  pair: TradingDayPair | null,
  accountName: string | undefined,
): UniverseEntry[] {
  const seen = new Set<string>();
  const universe: UniverseEntry[] = [];
  for (const symbol of benchmarks) {
    const up = symbol.toUpperCase();
    if (seen.has(up)) continue;
    seen.add(up);
    universe.push({ symbol: up, name: null, kind: "benchmark", outsideQuote: OUTSIDE_QUOTE_SYMBOLS.has(up) });
  }

  const accounts = (
    accountName === undefined
      ? db.prepare("SELECT id, name FROM accounts ORDER BY id").all()
      : db.prepare("SELECT id, name FROM accounts WHERE name = ? ORDER BY id").all(accountName)
  ) as { id: number; name: string }[];

  const held = new Map<string, UniverseEntry>();
  for (const account of accounts) {
    for (const holding of getIbkrTodayHoldings(db, account.id, pair)) {
      const up = holding.symbol?.toUpperCase();
      if (!up || holding.quantity === 0) continue;
      const side: MarketPosition = holding.quantity < 0 ? "short" : "long";
      const key = `${up}|${side}`;
      const entry = held.get(key);
      if (entry) {
        entry.legs!.push({ account: account.name, holding });
        continue;
      }
      held.set(key, {
        symbol: up,
        name: holding.security_name,
        kind: "holding",
        position: side,
        outsideQuote: false,
        legs: [{ account: account.name, holding }],
      });
    }
  }
  // Largest gross exposure first, then symbol and side, so the order is stable.
  const grossValue = (u: UniverseEntry) =>
    Math.abs((u.legs ?? []).reduce((sum, l) => sum + (l.holding.current_value ?? 0), 0));
  universe.push(
    ...[...held.values()].sort(
      (a, b) =>
        grossValue(b) - grossValue(a) ||
        a.symbol.localeCompare(b.symbol) ||
        (a.position ?? "").localeCompare(b.position ?? ""),
    ),
  );
  return universe;
}

/** Why one leg's day effect is null or leaves quantity out; null when whole. */
function legNote(h: TodayHolding): string | null {
  if (h.today_gain === null) {
    if (h.change_undated) {
      return "no holdings snapshot exists at the prior close, so this position cannot be dated to the session; left out";
    }
    if (h.day_move_basis === "excluded") {
      return "opened today with no usable cost; left out rather than measured from the prior close";
    }
    return "a closing price needed for the measurement is missing";
  }
  if (h.change_undated) {
    return "quantity changed but no holdings snapshot exists at the prior close; only the quantity last seen is measured";
  }
  if (h.added_cost_unknown) {
    return "added to today and the added quantity's cost is not known; only the quantity held at the prior close is measured";
  }
  return null;
}

const NO_LOCAL_SESSION_REASON =
  "The local book is behind, so what was held, opened or added this session is not known; no dollar day effect is given.";

// The book HAS the latest session; the one before it is missing (a close
// stored under a closed day, a skipped sync), so the consecutive pair the
// dollar day effect needs cannot form. Saying "behind" here told the owner
// the book had not synced a session that was in fact in it (QA 2026-10-13).
const NO_PRICED_NAMES_REASON =
  "The local book has recent sessions but no usable prices for this name, so what was held, opened or added this session cannot be measured; no dollar day effect is given.";

const NO_PRIOR_SESSION_REASON =
  "The local book has this session, but the previous session's close is missing from it, so what was held, opened or added this session cannot be measured; no dollar day effect is given.";

/** Added to a held index fund's reason when its percent move is the index quote. */
const INDEX_QUOTE_NOTE = "Report the percent price move only.";

/** Added to every other held row's reason on the live fallback (owner ruling A). */
const HELD_LOCAL_ONLY_NOTE =
  "Held names are never sent to the outside quote source: this row is the local book's last price (price_as_of), not the current session; pct is the book's move on that date, or null when the book has none.";

/** The newest date the local book prices this symbol on; null when never. */
function lastLocalPriceDate(db: Database.Database, symbol: string): string | null {
  const row = db
    .prepare(
      `SELECT MAX(p.date) AS date
         FROM prices p
         JOIN securities s ON s.id = p.security_id
        WHERE UPPER(s.symbol) = UPPER(?)`,
    )
    .get(symbol) as { date: string | null } | undefined;
  return row?.date ?? null;
}

/** Stamp `price_stale` on every held row against the snapshot's own session. */
function stampHeldFreshness(moves: MarketMove[], asOf: string | null, snapshotStale: boolean): MarketMove[] {
  return moves.map((m) =>
    m.kind === "holding"
      ? { ...m, price_stale: snapshotStale || m.price_as_of == null || m.price_as_of !== asOf }
      : m,
  );
}

/**
 * The latest trading-day date the local book prices SPY on, closed-day rows
 * dropped the way `resolveTradingDayPair` drops them; null when none.
 */
function latestLocalSession(db: Database.Database): string | null {
  const rows = db
    .prepare(
      `SELECT p.date AS date
         FROM prices p
         JOIN securities s ON s.id = p.security_id
        WHERE UPPER(s.symbol) = 'SPY'
        ORDER BY p.date DESC
        LIMIT 10`,
    )
    .all() as { date: string }[];
  return rows.map((r) => r.date).find((d) => !isMarketClosed(d)) ?? null;
}

type PositionFields = Omit<MarketMove, "symbol" | "name" | "pct" | "kind">;

/**
 * The position fields of a held row; empty for a benchmark so its row keeps
 * the percent-only shape. `unmeasuredReason` is set on the live fallback,
 * where the local book cannot measure the session (behind, or missing the
 * prior close): quantity and value are still the book's, but no dollar day
 * effect is claimed, and the reason says which.
 */
function positionFields(u: UniverseEntry, unmeasuredReason: string | null): PositionFields {
  if (!u.legs || !u.position) return {};
  const legs = [...u.legs].sort((a, b) => a.account.localeCompare(b.account));
  const many = legs.length > 1;
  const base = {
    position: u.position,
    accounts: legs.map((l) => l.account),
    quantity: legs.reduce((sum, l) => sum + l.holding.quantity, 0),
    market_value: legs.some((l) => l.holding.current_value === null)
      ? null
      : legs.reduce((sum, l) => sum + (l.holding.current_value ?? 0), 0),
  };
  if (unmeasuredReason !== null) {
    return {
      ...base,
      day_effect: null,
      day_effect_basis: "unpriced",
      day_effect_partial: false,
      opened_today: false,
      added_today: false,
      day_effect_reason: unmeasuredReason,
    };
  }

  const measured = legs.filter((l) => l.holding.today_gain !== null);
  const measuredBases = new Set(measured.map((l) => l.holding.day_move_basis));
  let basis: DayMoveBasis;
  if (measured.length === 0) {
    basis = legs.some((l) => l.holding.day_move_basis === "excluded") ? "excluded" : "unpriced";
  } else if (measuredBases.size === 1) {
    basis = measured[0].holding.day_move_basis;
  } else {
    // Legs measured differently (one close to close, one from cost).
    basis = "mixed";
  }
  const notes = legs
    .map((l) => {
      const note = legNote(l.holding);
      return note === null ? null : many ? `${l.account}: ${note}` : note;
    })
    .filter((n): n is string => n !== null);

  return {
    ...base,
    day_effect:
      measured.length === 0
        ? null
        : measured.reduce((sum, l) => sum + (l.holding.today_gain ?? 0), 0),
    day_effect_basis: basis,
    day_effect_partial: measured.length > 0 && measured.length < legs.length,
    opened_today: legs.some((l) => l.holding.opened_today),
    added_today: legs.some((l) => !l.holding.opened_today && l.holding.added_today_qty !== 0),
    day_effect_reason: notes.length > 0 ? notes.join(" | ") : null,
  };
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
  const now = opts.now ?? new Date();
  const today = opts.today ?? todayET(now);
  const benchmarks = opts.benchmarks ?? DEFAULT_BENCHMARKS;

  // ── Local path ──────────────────────────────────────────────────────────────
  // The chat snapshot keeps the intraday move (owner ruling 2026-10-08): the
  // pair is resolved with no options, once, and the same pair measures both
  // the percent moves and every held row's dollar day effect.
  const pair = resolveTradingDayPair(db);
  const universe = buildUniverse(db, benchmarks, pair, opts.accountName);
  let localMoves: MarketMove[] = [];
  let staleDays: number | null = null;
  let localStale = true;

  if (pair) {
    localMoves = universe
      .map((u): MarketMove | null => {
        const latest = closeOn(db, u.symbol, pair.latest);
        const prior = closeOn(db, u.symbol, pair.prior);
        if (latest == null) {
          // A benchmark with no close has nothing to say. A HELD name with no
          // price on the latest session is still a position (owner ruling A):
          // listed from the book, stale, dated by its last local price, with
          // no move. It is never fetched from outside.
          if (u.kind !== "holding") return null;
          return {
            symbol: u.symbol,
            name: u.name,
            pct: null,
            kind: u.kind,
            ...positionFields(u, null),
            price_as_of: lastLocalPriceDate(db, u.symbol),
          };
        }
        const held = u.kind === "holding" ? { price_as_of: pair.latest } : {};
        if (prior == null || prior === 0) {
          // A benchmark with no prior close has nothing to say. A HELD name
          // without one (first bought during the session, so nothing was
          // priced before) is still a position: the Today line measures it
          // from its cost, and the chat must list the same row with the same
          // day effect rather than drop it and contradict the line's total.
          if (u.kind !== "holding") return null;
          return { symbol: u.symbol, name: u.name, pct: null, kind: u.kind, ...positionFields(u, null), ...held };
        }
        return { symbol: u.symbol, name: u.name, pct: pct(latest, prior), kind: u.kind, ...positionFields(u, null), ...held };
      })
      .filter((m): m is MarketMove => m !== null);
    staleDays = calendarDaysBetween(pair.latest, today);
    localStale = staleDays > MARKET_SNAPSHOT_STALE_DAYS;
  }

  // Fresh local data wins outright (local-first) — no live call.
  // The fresh path needs a priced row, not only a held name the book cannot
  // price (that row alone is no market data).
  const localPriced = localMoves.some((m) => m.pct !== null || m.price_as_of === pair?.latest);
  if (pair && localPriced && !localStale) {
    // A price dated today (ET) before the 16:00 ET close is a pre-market /
    // intraday quote, not a close — never call it one.
    const sessionOpen =
      pair.latest === today && todayET(now) === today && nowET(now) < "16:00";
    const note = sessionOpen
      ? `Latest pre-market / intraday quotes as of ${pair.latest} (local book) versus the prior close. The ${pair.latest} session has not closed yet, so these are NOT closing prices — do not call them a close or an end-of-day move.`
      : `Closing prices as of ${pair.latest} (local book). Intraday moves during the current session are not reflected.`;
    return {
      source: "local",
      asOf: pair.latest,
      stale: false,
      staleDays,
      moves: stampHeldFreshness(localMoves, pair.latest, false),
      note,
    };
  }

  // ── Yahoo fallback (local missing or stale) ───────────────────────────────────
  // Why the book could not measure the session. The missing-prior-close
  // wording is true only when the book's latest SPY session IS the session the
  // quotes cover (no pair formed, so the session before it is missing). A book
  // whose latest session is older than the quotes' is behind. Decided once the
  // quotes' own session date is known (`bookReasons`).
  const latestLocal = pair === null ? latestLocalSession(db) : null;
  // A fresh pair with no priced names: the book is not behind, it has nothing
  // usable for this universe.
  const pairButNoMoves = pair !== null && !localStale && !localPriced;
  const bookReasons = (quoteDate: string | null) => {
    const missingPrior =
      latestLocal !== null &&
      quoteDate !== null &&
      latestLocal === quoteDate &&
      calendarDaysBetween(latestLocal, today) <= MARKET_SNAPSHOT_STALE_DAYS;
    if (missingPrior) {
      return {
        reason: NO_PRIOR_SESSION_REASON,
        note: `The local book has the ${latestLocal} session but the previous session's close is missing from it, so no dollar day effect can be measured; the percent moves are a live fallback.`,
      };
    }
    if (pairButNoMoves) {
      return {
        reason: NO_PRICED_NAMES_REASON,
        note: "The local book has recent sessions but no usable prices for these names, so no dollar day effect can be measured; the percent moves are a live fallback.",
      };
    }
    return {
      reason: NO_LOCAL_SESSION_REASON,
      note: "The local book was behind so this is a best-effort live fallback.",
    };
  };
  if (opts.fetchQuotes) {
    let quotes: Awaited<ReturnType<QuoteFetcher>> = null;
    try {
      // Owner ruling A: only the index funds listed as benchmarks, each once.
      // A held ticker is never sent; a held index fund reads its index quote.
      const outside = [...new Set(universe.filter((u) => u.outsideQuote).map((u) => u.symbol))];
      quotes = outside.length > 0 ? await opts.fetchQuotes(outside) : null;
    } catch {
      quotes = null;
    }
    if (quotes) {
      // Date the snapshot by the quotes' own session (the most common
      // per-symbol ET date; ties → the later date), not by today — pre-open
      // or on a weekend the latest Yahoo session is an earlier day.
      // One vote per symbol, however many rows it has.
      const counts = new Map<string, number>();
      for (const symbol of OUTSIDE_QUOTE_SYMBOLS) {
        const d = quotes[symbol]?.asOf;
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
      const reasons = bookReasons(asOf);
      // An outside quote is read only for an index fund; whatever else the
      // source returned is ignored.
      const indexQuote = (symbol: string): LiveQuote | null => {
        if (!OUTSIDE_QUOTE_SYMBOLS.has(symbol)) return null;
        const q = quotes![symbol];
        return q && q.prior !== 0 ? q : null;
      };
      const localByKey = new Map(
        localMoves.filter((m) => m.kind === "holding").map((m) => [`${m.symbol}|${m.position}`, m]),
      );
      const moves = universe
        .map((u): MarketMove | null => {
          const q = indexQuote(u.symbol);
          if (u.kind !== "holding") {
            if (!q) return null;
            return { symbol: u.symbol, name: u.name, pct: pct(q.price, q.prior), kind: u.kind };
          }
          if (q) {
            return {
              symbol: u.symbol,
              name: u.name,
              pct: pct(q.price, q.prior),
              kind: u.kind,
              ...positionFields(u, `${reasons.reason} ${INDEX_QUOTE_NOTE}`),
              price_as_of: q.asOf ?? quoteDate,
            };
          }
          // Every other held name: the local book's, stale, never fetched.
          const local = localByKey.get(`${u.symbol}|${u.position}`);
          const fromPair = local && local.pct !== null && pair ? local : null;
          return {
            symbol: u.symbol,
            name: u.name,
            pct: fromPair ? fromPair.pct : null,
            kind: u.kind,
            ...positionFields(u, `${reasons.reason} ${HELD_LOCAL_ONLY_NOTE}`),
            price_as_of: fromPair ? pair!.latest : lastLocalPriceDate(db, u.symbol),
          };
        })
        .filter((m): m is MarketMove => m !== null);
      if (moves.some((m) => m.kind === "benchmark")) {
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
          moves: stampHeldFreshness(moves, quoteDate, yahooStale),
          note: `${sessionNote} ${reasons.note} Held names are not sent to the outside source: each held row is the local book's, with price_as_of (its last local price date) and price_stale.`,
        };
      }
    }
  }

  // ── Degraded: stale local if we have it, else nothing ─────────────────────────
  if (pair && localPriced) {
    return {
      source: "local",
      asOf: pair.latest,
      stale: true,
      staleDays,
      moves: stampHeldFreshness(localMoves, pair.latest, true),
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

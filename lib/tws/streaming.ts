import type Database from "better-sqlite3";
import { MarketDataType, SecType, IBApiTickType } from "@stoqey/ib";
import type { Subscription } from "rxjs";
import { getIbApi } from "./client";
import { mapSecurityType } from "./security-type-map";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { bumpIfPricesAffectSyntheticCloses } from "@/lib/compute/tax-convention";

// ─── Types ──────────────────────────────────────────────────────

export interface LiveQuote {
  securityId: number;
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  close: number | null;     // previous close for change calc
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  timestamp: number;         // epoch ms
}

interface StreamingState {
  cache: Map<number, LiveQuote>;
  subscriptions: Map<number, Subscription>;
  clientCount: number;
  shutdownTimer: ReturnType<typeof setTimeout> | null;
  active: boolean;
}

// ─── globalThis State (survives HMR) ────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __tws_streaming: StreamingState | undefined;
}

function getState(): StreamingState {
  if (!globalThis.__tws_streaming) {
    globalThis.__tws_streaming = {
      cache: new Map(),
      subscriptions: new Map(),
      clientCount: 0,
      shutdownTimer: null,
      active: false,
    };
  }
  return globalThis.__tws_streaming;
}

// ─── Tick extraction ────────────────────────────────────────────

function extractTickValue(
  ticks: ReadonlyMap<number, { value?: number }>,
  ...tickTypes: number[]
): number | null {
  for (const t of tickTypes) {
    const entry = ticks.get(t);
    if (entry?.value != null && entry.value > 0) return entry.value;
  }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────

/** Get the current quote cache. */
export function getQuoteCache(): Map<number, LiveQuote> {
  return getState().cache;
}

/** Get all cached quotes as array. */
export function getQuotes(): LiveQuote[] {
  return Array.from(getState().cache.values());
}

/** Check if streaming is active. */
export function isStreaming(): boolean {
  return getState().active;
}

/** Register a new SSE client. Returns client cleanup function. */
export function registerClient(): () => void {
  const state = getState();
  state.clientCount++;

  // Cancel any pending shutdown
  if (state.shutdownTimer) {
    clearTimeout(state.shutdownTimer);
    state.shutdownTimer = null;
  }

  return () => {
    state.clientCount--;
    // If no clients remain, schedule shutdown after grace period
    if (state.clientCount <= 0) {
      state.clientCount = 0;
      state.shutdownTimer = setTimeout(() => {
        stopStreaming();
      }, 30_000); // 30s grace period
    }
  };
}

/**
 * Start streaming market data for current holdings.
 * Uses delayed/frozen data (no exchange subscription needed).
 */
export function startStreaming(
  db: Database.Database,
  options?: {
    securityIds?: number[];
    onUpdate?: (quote: LiveQuote) => void;
  }
): void {
  const api = getIbApi();
  if (!api) throw new Error("TWS not connected");

  const state = getState();
  if (state.active) return; // already streaming

  // Enable delayed data for after-hours
  api.setMarketDataType(MarketDataType.DELAYED_FROZEN);

  // Get securities to stream
  let securities: {
    id: number;
    symbol: string;
    security_type: string | null;
    ib_con_id: number | null;
    currency: string | null;
  }[];

  if (options?.securityIds?.length) {
    const placeholders = options.securityIds.map(() => "?").join(",");
    securities = db
      .prepare(
        `SELECT id, symbol, security_type, ib_con_id, currency FROM securities WHERE id IN (${placeholders})`
      )
      .all(...options.securityIds) as typeof securities;
  } else {
    // Stream all securities with positions and ib_con_id. Latest is keyed
    // per-(account, security) via latestHoldingsPredicate (default
    // keyBy/includeShorts), replacing the prior aliasless, account-only
    // `MAX(as_of_date) ... WHERE account_id = h.account_id` subquery — which
    // (a) dropped positions that only restate on monthly statements
    // whenever a daily sync wrote newer rows for other securities in the
    // same account, and (b) carried NO quantity guard at all, so a
    // quantity=0 tombstone (closed/sold position) still consumed one of the
    // 50 IB streaming slots. `includeShorts` default (`quantity != 0`) is a
    // deliberate behavior fix: tombstoned securities must not stream.
    //
    // Because the query still joins holdings to securities, a security held
    // in MULTIPLE accounts yields one row per account's latest holding —
    // GROUP BY s.id collapses those back to one row per security. The
    // priority rule for the LIMIT 50 cutoff (Codex F9: a bare
    // `ORDER BY h.as_of_date` was ambiguous under `SELECT DISTINCT` once a
    // security could appear via more than one account row) is
    // freshest-anywhere-first: a multi-account security ranks by whichever
    // account has the MOST RECENT latest-holding date (MAX(h.as_of_date)
    // across its rows), with symbol as the deterministic tiebreak.
    securities = db
      .prepare(
        `SELECT s.id, s.symbol, s.security_type, s.ib_con_id, s.currency
         FROM securities s
         JOIN holdings h ON h.security_id = s.id
         WHERE s.ib_con_id IS NOT NULL
           AND ${latestHoldingsPredicate()}
           AND (s.security_type IS NULL OR s.security_type NOT IN ('mutual_fund'))
         GROUP BY s.id
         ORDER BY MAX(h.as_of_date) DESC, s.symbol
         LIMIT 50`
      )
      .all() as typeof securities;
  }

  state.active = true;

  for (const sec of securities) {
    const secType = mapSecurityType(sec.security_type);
    // Options stay USD (listed equity/index options are USD-denominated
    // regardless of the underlying's currency); other types use the
    // security's own stored currency (Task 6/7b: foreign-currency valuation)
    // so a KRW-denominated held security isn't queried as USD.
    const currency = secType === SecType.OPT ? "USD" : sec.currency || "USD";
    const contract = sec.ib_con_id
      ? { conId: sec.ib_con_id, secType, exchange: "SMART", currency }
      : { symbol: sec.symbol, secType, exchange: "SMART", currency };

    // Initialize cache entry
    if (!state.cache.has(sec.id)) {
      state.cache.set(sec.id, {
        securityId: sec.id,
        symbol: sec.symbol,
        last: null,
        bid: null,
        ask: null,
        close: null,
        change: null,
        changePercent: null,
        volume: null,
        timestamp: Date.now(),
      });
    }

    const sub = api.getMarketData(contract, "", false, false).subscribe({
      next: (update) => {
        const ticks = update.all;
        const quote = state.cache.get(sec.id)!;

        const last = extractTickValue(ticks, IBApiTickType.LAST, IBApiTickType.DELAYED_LAST);
        const bid = extractTickValue(ticks, IBApiTickType.BID, IBApiTickType.DELAYED_BID);
        const ask = extractTickValue(ticks, IBApiTickType.ASK, IBApiTickType.DELAYED_ASK);
        const close = extractTickValue(ticks, IBApiTickType.CLOSE, IBApiTickType.DELAYED_CLOSE);
        const volume = extractTickValue(ticks, IBApiTickType.VOLUME, IBApiTickType.DELAYED_VOLUME);

        if (last != null) quote.last = last;
        if (bid != null) quote.bid = bid;
        if (ask != null) quote.ask = ask;
        if (close != null) quote.close = close;
        if (volume != null) quote.volume = volume;

        // Compute change from close
        const price = quote.last ?? quote.bid ?? quote.ask;
        if (price != null && quote.close != null && quote.close > 0) {
          quote.change = price - quote.close;
          quote.changePercent = (quote.change / quote.close) * 100;
        }

        quote.timestamp = Date.now();
        options?.onUpdate?.(quote);
      },
      error: () => {
        // Silently ignore per-security errors
      },
    });

    state.subscriptions.set(sec.id, sub);
  }
}

/** Stop all market data subscriptions and clear state. */
export function stopStreaming(): void {
  const state = getState();

  for (const [, sub] of state.subscriptions) {
    try {
      sub.unsubscribe();
    } catch {
      // ignore
    }
  }

  state.subscriptions.clear();
  state.active = false;

  // Reset market data type
  try {
    const api = getIbApi();
    api?.setMarketDataType(MarketDataType.REALTIME);
  } catch {
    // ignore
  }
}

/** Write current cache to prices table as a snapshot. */
export function snapshotToDb(db: Database.Database): number {
  const state = getState();
  const today = new Date().toISOString().slice(0, 10);
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO prices (security_id, date, close_price, source)
    VALUES (?, ?, ?, 'tws')
  `);

  let count = 0;
  const tx = db.transaction(() => {
    const pairs: { securityId: number; date: string }[] = [];
    for (const [secId, quote] of state.cache) {
      const price = quote.last ?? quote.bid;
      if (price != null && price > 0) {
        upsert.run(secId, today, price);
        count++;
        pairs.push({ securityId: secId, date: today });
      }
    }
    bumpIfPricesAffectSyntheticCloses(db, pairs);
  });
  tx();

  return count;
}

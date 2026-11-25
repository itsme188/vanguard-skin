import {
  MarketDataType,
  OptionType,
  SecType,
  IBApiTickType,
  type Contract,
  type IBApiNext,
} from "@stoqey/ib";
import type Database from "better-sqlite3";
import { getIbApi } from "./client";
import { marketDataTypeGeneration, setMarketDataTypeCounted } from "./market-data-type";
import { TRIAL_OPTION_MULTIPLIER } from "@/lib/analysis/gains-at-risk-constants";

/**
 * One option contract's quote from the broker, for a trial position on the
 * Gains at risk page (step 2, rulings R8 and R10). One click, one request:
 *
 *   1. the underlying's broker contract id and symbol from its securities row
 *      (none: `no-underlying-contract`; the app never adds a security here);
 *   2. ONE `getContractDetails` for the exact contract (symbol, OPT, SMART,
 *      USD, expiry, strike, right) with the multiplier pinned to 100, so an
 *      adjusted contract with another multiplier cannot answer. No match (an
 *      empty reply, or the broker's error 200 "no security definition"):
 *      `no-contract`. Several matches: the one whose trading class is the
 *      underlying's symbol, else `ambiguous-contract`;
 *   3. ONE market-data snapshot of that contract and ONE of the underlying
 *      (by its contract id), in parallel, read through `snapshotTicks` (the
 *      shared single-contract read, also used by the step 3 batch): the
 *      market-data type is set to DELAYED_FROZEN through the one setter
 *      (lib/tws/market-data-type.ts) and put back to REALTIME afterwards, and
 *      IB's non-positive "no quote" sentinel never counts as a price. When the
 *      type was set by someone else while the snapshots were in flight (the
 *      setter's counter moved), the type is set again and the snapshots are
 *      taken once more; a second change answers `broker-busy` (step 3 D2).
 *
 * The whole quote runs under `withOptionQuoteLock`, shared with the step 3
 * quote batch (lib/tws/option-quote-batch.ts), so a single quote and a batch
 * never interleave on the broker connection.
 *
 * What the reply can honestly say (R8): `tickKind` is "delayed" when any
 * figure used (bid, ask, last, the underlying's last) came from a DELAYED_*
 * tick, else "live". A frozen quote cannot be told apart here; the session
 * label (lib/calendar/market-session.ts) covers that. `fetchedAt` is the
 * instant of the click, never the quote's own time.
 *
 * `ok: true` only with BOTH a positive bid and a positive ask, the bid not
 * above the ask (a crossed quote is not a market; a locked one is); the mid
 * is their plain average. Otherwise `no-two-sided-quote` with whatever did
 * arrive. A model price is never produced here.
 *
 * NOT on the historical-data limiter: market-data snapshots are not subject
 * to the 55-requests/10-minute HISTORICAL window (same rationale as
 * atm-straddle.ts). Never throws. Logs at most one content-free line: a
 * stage and an error code, never a symbol, a strike or a price.
 */

export type OptionQuoteRefusal =
  | "not-connected"
  | "no-underlying-contract"
  | "no-contract"
  | "ambiguous-contract"
  | "no-two-sided-quote"
  | "timeout"
  | "broker-error"
  /** Step 3 (D2): the market-data type was changed by another caller twice while this quote was in flight. */
  | "broker-busy";

export type QuoteTickKind = "live" | "delayed";

export interface OptionQuoteRequest {
  underlyingSecurityId: number;
  right: "put" | "call";
  /** YYYY-MM-DD. */
  expiry: string;
  strike: number;
}

export type OptionQuoteResult =
  | {
      ok: true;
      bid: number;
      ask: number;
      mid: number;
      last: number | null;
      underlyingLast: number | null;
      tickKind: QuoteTickKind;
      /** ISO instant of the click (the request), never the quote's own time. */
      fetchedAt: string;
    }
  | { ok: false; reason: OptionQuoteRefusal; bid: number | null; ask: number | null; last: number | null };

/** Per-request timeout: the same value as lib/tws/snapshot.ts and atm-straddle.ts. */
export const OPTION_QUOTE_TIMEOUT_MS = 15_000;

/**
 * The quote route's per-process limit: at most OPTION_QUOTE_RATE_LIMIT
 * requests that reach the broker in any rolling OPTION_QUOTE_RATE_WINDOW_MS.
 * State lives on globalThis (Turbopack HMR resets module state, lib/tws/CLAUDE.md).
 */
export const OPTION_QUOTE_RATE_LIMIT = 30;
export const OPTION_QUOTE_RATE_WINDOW_MS = 60_000;

const limiterState = globalThis as unknown as { __tws_optionQuoteTimes?: number[] };

/**
 * Takes one slot at `now` (epoch ms), or answers how many whole seconds until
 * the oldest slot in the window frees. A refusal takes no slot.
 */
export function takeOptionQuoteSlot(now: number = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const times = (limiterState.__tws_optionQuoteTimes ?? []).filter((t) => now - t < OPTION_QUOTE_RATE_WINDOW_MS);
  if (times.length >= OPTION_QUOTE_RATE_LIMIT) {
    limiterState.__tws_optionQuoteTimes = times;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((times[0] + OPTION_QUOTE_RATE_WINDOW_MS - now) / 1000)) };
  }
  times.push(now);
  limiterState.__tws_optionQuoteTimes = times;
  return { ok: true };
}

/** Tests only: forget every slot. */
export function resetOptionQuoteLimiter(): void {
  limiterState.__tws_optionQuoteTimes = [];
}

/**
 * Step 3 (D7) count-then-take: takes min(n, free) slots at `now` in ONE
 * synchronous call over the same window as takeOptionQuoteSlot, so no slot can
 * change hands between the count and the take. `retryAfterSeconds` is null
 * when every asked slot was granted, else the whole seconds until the oldest
 * slot in the window frees.
 */
export function reserveOptionQuoteSlots(n: number, now: number = Date.now()): { granted: number; retryAfterSeconds: number | null } {
  const times = (limiterState.__tws_optionQuoteTimes ?? []).filter((t) => now - t < OPTION_QUOTE_RATE_WINDOW_MS);
  const asked = Math.max(0, Math.floor(n));
  const granted = Math.min(asked, Math.max(0, OPTION_QUOTE_RATE_LIMIT - times.length));
  for (let i = 0; i < granted; i++) times.push(now);
  limiterState.__tws_optionQuoteTimes = times;
  if (granted === asked) return { granted, retryAfterSeconds: null };
  return { granted, retryAfterSeconds: Math.max(1, Math.ceil((times[0] + OPTION_QUOTE_RATE_WINDOW_MS - now) / 1000)) };
}

const lockState = globalThis as unknown as { __tws_optionQuoteLock?: Promise<void> };

/**
 * The longest a caller waits for the option-quote lock before it is refused
 * "broker busy" with zero broker requests (S2 fix round 1). A Get quote
 * clicked during a candidate batch must not hang for the batch's two minutes.
 */
export const OPTION_QUOTE_LOCK_WAIT_MS = 20_000;

/** Thrown (rejected) by withOptionQuoteLock when the wait exceeded its bound; `fn` never ran. */
export class OptionQuoteLockBusy extends Error {}

/**
 * Serialises the single quote and the step 3 batch (D2): a promise chain on
 * globalThis. `fn` starts only after every earlier holder has finished; the
 * lock is released when `fn` settles, whether it resolves or throws. A caller
 * waits at most `maxWaitMs` (default OPTION_QUOTE_LOCK_WAIT_MS); past it the
 * call rejects with OptionQuoteLockBusy, `fn` never runs, and its place in the
 * chain is passed on at once when its turn comes. Waiting counts toward the
 * caller's own deadline (the caller measures it).
 */
export function withOptionQuoteLock<T>(fn: () => Promise<T>, opts: { maxWaitMs?: number } = {}): Promise<T> {
  const previous = lockState.__tws_optionQuoteLock ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  lockState.__tws_optionQuoteLock = previous.then(() => held);
  return new Promise<T>((resolve, reject) => {
    let gaveUp = false;
    const timer = setTimeout(() => {
      gaveUp = true;
      reject(new OptionQuoteLockBusy());
    }, opts.maxWaitMs ?? OPTION_QUOTE_LOCK_WAIT_MS);
    void previous.then(async () => {
      clearTimeout(timer);
      if (gaveUp) {
        release();
        return;
      }
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      } finally {
        release();
      }
    });
  });
}

/**
 * The calendar day of a broker expiry field, YYYY-MM-DD, or null. The broker's
 * `lastTradeDateOrContractMonth` can carry a time suffix ("20261218 16:00
 * US/Eastern": the package's decoder may leave it on), so the field is never
 * compared as a whole string: only its leading YYYYMMDD day is read. A bare
 * contract month (YYYYMM) or anything else is null. The one parser of that
 * field in lib/tws (the chain reader and the quote batch both read it).
 */
export function brokerExpiryDay(raw: unknown): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:\s|$)/.exec(String(raw ?? "").trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** IB's "No security definition has been found for the request". */
export const IB_NO_SECURITY_DEFINITION = 200;

/** The timeout marker of `withTimeout` (shared with the step 3 batch and chain reader). */
export class QuoteTimeout extends Error {}

/** Races a broker promise against `ms`; a loss rejects with QuoteTimeout. The broker request itself is not cancelled. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new QuoteTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface TickFigure {
  value: number;
  delayed: boolean;
}

/**
 * Step 3: the per-snapshot backstop. The package completes a snapshot "after
 * 11s latest" (`getMarketData`, node_modules/@stoqey/ib/dist/api-next/api-next.d.ts);
 * this is a little above that, for a snapshot that never completes.
 */
export const OPTION_SNAPSHOT_BACKSTOP_MS = 13_000;

export type SnapshotTicksResult =
  | { ok: true; ticks: ReadonlyMap<number, { value?: number }>; arrivedAt: string }
  | {
      ok: false;
      reason: "timeout" | "disconnected" | "error";
      error?: unknown;
      /** The request itself threw while being sent (the connection failing), as opposed to the stream erroring. */
      sendFailed?: true;
    };

/**
 * The shared single-contract read (step 3, D7): ONE snapshot subscription,
 * `api.getMarketData(contract, "", true, false)`, keeping the latest
 * `update.all`. Resolves on the snapshot's own completion (`arrivedAt` read
 * from `opts.now()` then), on the backstop, on an error (a disconnect when the
 * connection is gone) or on a throw while sending; always unsubscribes, and
 * ticks after that are ignored. It is never cut short for a caller's deadline.
 *
 * Package fact (@stoqey/ib 1.5.3, api-next.js getMarketData): unsubscribing a
 * SNAPSHOT sends no cancelMktData to the broker; the broker ends a snapshot
 * itself. So unsubscribing here only stops listening.
 *
 * Used by fetchOptionQuote and the step 3 batch; never copied.
 */
export function snapshotTicks(
  api: Pick<IBApiNext, "getMarketData">,
  contract: Contract,
  opts: { backstopMs?: number; now: () => Date },
): Promise<SnapshotTicksResult> {
  return new Promise<SnapshotTicksResult>((resolve) => {
    let settled = false;
    let subscription: { unsubscribe(): void } | undefined;
    let latest: ReadonlyMap<number, { value?: number }> = new Map();
    const unsubscribe = (): void => {
      try {
        subscription?.unsubscribe();
      } catch {
        // Stopping to listen is best effort.
      }
    };
    const finish = (result: SnapshotTicksResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), opts.backstopMs ?? OPTION_SNAPSHOT_BACKSTOP_MS);
    try {
      subscription = api.getMarketData(contract, "", true, false).subscribe({
        next: (update) => {
          if (!settled && update?.all) latest = update.all as ReadonlyMap<number, { value?: number }>;
        },
        error: (error: unknown) => finish({ ok: false, reason: getIbApi() === null ? "disconnected" : "error", error }),
        complete: () => finish({ ok: true, ticks: latest, arrivedAt: opts.now().toISOString() }),
      });
      // A snapshot that settled synchronously inside subscribe(): stop listening now.
      if (settled) unsubscribe();
    } catch (error) {
      finish({ ok: false, reason: getIbApi() === null ? "disconnected" : "error", error, sendFailed: true });
    }
  });
}

/** The live tick first, then the delayed one; only a strictly positive finite value counts (IB's sentinel rule). */
function readTick(ticks: ReadonlyMap<number, { value?: number }>, live: number, delayed: number): TickFigure | null {
  for (const [type, isDelayed] of [
    [live, false],
    [delayed, true],
  ] as const) {
    const v = ticks.get(type)?.value;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return { value: v, delayed: isDelayed };
  }
  return null;
}

/**
 * The two-sided rule, shared by the single quote and the batch: a positive bid
 * AND a positive ask (IB's sentinel never counts), the bid not above the ask.
 * A crossed quote is not a market; a locked one (bid equals ask) is. Live ticks
 * first, then delayed. A model price is never produced.
 */
export function twoSidedQuote(
  ticks: ReadonlyMap<number, { value?: number }>,
):
  | { ok: true; bid: TickFigure; ask: TickFigure; last: TickFigure | null }
  | { ok: false; bid: number | null; ask: number | null; last: number | null } {
  const bid = readTick(ticks, IBApiTickType.BID, IBApiTickType.DELAYED_BID);
  const ask = readTick(ticks, IBApiTickType.ASK, IBApiTickType.DELAYED_ASK);
  const last = readTick(ticks, IBApiTickType.LAST, IBApiTickType.DELAYED_LAST);
  if (bid === null || ask === null || bid.value > ask.value) {
    return { ok: false, bid: bid?.value ?? null, ask: ask?.value ?? null, last: last?.value ?? null };
  }
  return { ok: true, bid, ask, last };
}

/** The underlying's last price (live, then delayed), sentinel excluded. */
export function underlyingLastTick(ticks: ReadonlyMap<number, { value?: number }>): TickFigure | null {
  return readTick(ticks, IBApiTickType.LAST, IBApiTickType.DELAYED_LAST);
}

/** A content-free description of a broker error for a log line: a code or an error class name, never a message. */
export function errorCode(err: unknown): string {
  if (err instanceof QuoteTimeout) return "timeout";
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? `code ${code}` : err instanceof Error ? err.name : "unknown";
}

const refuse = (
  reason: OptionQuoteRefusal,
  figures: { bid?: number | null; ask?: number | null; last?: number | null } = {},
): OptionQuoteResult => ({ ok: false, reason, bid: figures.bid ?? null, ask: figures.ask ?? null, last: figures.last ?? null });

function multiplierIs100(m: unknown): boolean {
  return Number(m) === TRIAL_OPTION_MULTIPLIER;
}

export async function fetchOptionQuote(
  db: Database.Database,
  req: OptionQuoteRequest,
  deps: { api?: IBApiNext | null; now?: () => Date; timeoutMs?: number } = {},
): Promise<OptionQuoteResult> {
  const timeoutMs = deps.timeoutMs ?? OPTION_QUOTE_TIMEOUT_MS;
  const connected = (): boolean => getIbApi() !== null;
  try {
    const api = deps.api === undefined ? getIbApi() : deps.api;
    if (!api) return refuse("not-connected");
    const fetchedAt = (deps.now ?? (() => new Date()))().toISOString();
    return await withOptionQuoteLock(() => quoteUnderLock(db, req, api, deps, fetchedAt, timeoutMs, connected));
  } catch (err) {
    if (err instanceof OptionQuoteLockBusy) {
      console.warn("[option-quote] lock wait exceeded: broker-busy");
      return refuse("broker-busy");
    }
    console.warn(`[option-quote] stopped: ${errorCode(err)}`);
    return refuse(connected() ? "broker-error" : "not-connected");
  }
}

async function quoteUnderLock(
  db: Database.Database,
  req: OptionQuoteRequest,
  api: IBApiNext,
  deps: { now?: () => Date; timeoutMs?: number },
  fetchedAt: string,
  timeoutMs: number,
  connected: () => boolean,
): Promise<OptionQuoteResult> {
  try {
    const und = db
      .prepare("SELECT symbol, ib_con_id FROM securities WHERE id = ?")
      .get(req.underlyingSecurityId) as { symbol: string | null; ib_con_id: number | null } | undefined;
    const symbol = (und?.symbol ?? "").trim().toUpperCase();
    if (!und || und.ib_con_id === null || symbol === "") return refuse("no-underlying-contract");
    const underlyingConId = und.ib_con_id;

    const lastTradeDateOrContractMonth = req.expiry.replace(/-/g, "");
    const right = req.right === "put" ? OptionType.Put : OptionType.Call;
    const lookup: Contract = {
      symbol,
      secType: SecType.OPT,
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth,
      strike: req.strike,
      right,
      multiplier: TRIAL_OPTION_MULTIPLIER,
    };

    let details: Awaited<ReturnType<IBApiNext["getContractDetails"]>>;
    try {
      details = await withTimeout(api.getContractDetails(lookup), timeoutMs);
    } catch (err) {
      if (err instanceof QuoteTimeout) return refuse("timeout");
      if ((err as { code?: unknown } | null)?.code === IB_NO_SECURITY_DEFINITION) return refuse("no-contract");
      if (!connected()) return refuse("not-connected");
      console.warn(`[option-quote] contract lookup failed: ${errorCode(err)}`);
      return refuse("broker-error");
    }
    const matches = (details ?? []).filter((d) => d?.contract?.conId && multiplierIs100(d.contract.multiplier));
    let match = matches.length === 1 ? matches[0] : undefined;
    if (matches.length === 0) return refuse("no-contract");
    if (matches.length > 1) {
      const standard = matches.filter((d) => (d.contract.tradingClass ?? "").trim().toUpperCase() === symbol);
      if (standard.length !== 1) return refuse("ambiguous-contract");
      match = standard[0];
    }
    const optionContract: Contract = {
      conId: match!.contract.conId,
      symbol,
      secType: SecType.OPT,
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth,
      strike: req.strike,
      right,
      multiplier: TRIAL_OPTION_MULTIPLIER,
    };
    const underlyingContract: Contract = { conId: underlyingConId, secType: SecType.STK, exchange: "SMART", currency: "USD" };

    const now = deps.now ?? (() => new Date());
    // The snapshot backstop: the caller's timeout when given (tests), else a little above the package's 11 s.
    const backstopMs = deps.timeoutMs ?? OPTION_SNAPSHOT_BACKSTOP_MS;

    // A throw while SENDING (the type setting, or a snapshot call that throws synchronously)
    // is the broker connection failing, not an empty quote.
    let sendError: unknown = null;
    let option: SnapshotTicksResult | null = null;
    let underlying: SnapshotTicksResult | null = null;
    let busy = false;
    try {
      let own = setMarketDataTypeCounted(api, MarketDataType.DELAYED_FROZEN);
      for (let attempt = 0; ; attempt++) {
        [option, underlying] = await Promise.all([
          snapshotTicks(api, optionContract, { backstopMs, now }),
          snapshotTicks(api, underlyingContract, { backstopMs, now }),
        ]);
        if (!option.ok && option.sendFailed) {
          sendError = option.error;
          break;
        }
        if (marketDataTypeGeneration() === own) break;
        // Someone else set the type while the snapshots were in flight (D2): set it again and ask once more.
        if (attempt >= 1) {
          busy = true;
          break;
        }
        own = setMarketDataTypeCounted(api, MarketDataType.DELAYED_FROZEN);
      }
    } catch (err) {
      sendError = err;
    } finally {
      // Restored only while still connected (as the batch does): a dropped connection has no type to restore.
      if (connected()) {
        try {
          setMarketDataTypeCounted(api, MarketDataType.REALTIME);
        } catch {
          // Non-critical, best-effort reset (same as atm-straddle.ts).
        }
      }
    }

    if (sendError !== null) {
      if (!connected()) return refuse("not-connected");
      console.warn(`[option-quote] request failed: ${errorCode(sendError)}`);
      return refuse("broker-error");
    }
    if (busy) {
      console.warn("[option-quote] market-data type changed during the request: broker-busy");
      return refuse("broker-busy");
    }
    if (option === null) return refuse("broker-error");
    if (!option.ok && option.reason === "timeout") return refuse("timeout");
    if (!option.ok) {
      if (!connected()) return refuse("not-connected");
      console.warn(`[option-quote] snapshot failed: ${errorCode(option.error)}`);
      return refuse("no-two-sided-quote");
    }

    const quote = twoSidedQuote(option.ticks);
    const underlyingLast = underlying?.ok ? underlyingLastTick(underlying.ticks) : null;

    // Two-sided means both sides AND not crossed: a bid above the ask is not a market.
    // A locked market (bid equals ask) is a market.
    if (!quote.ok) return refuse("no-two-sided-quote", { bid: quote.bid, ask: quote.ask, last: quote.last });
    const { bid, ask, last } = quote;
    const delayed = [bid, ask, last, underlyingLast].some((f) => f !== null && f.delayed);
    return {
      ok: true,
      bid: bid.value,
      ask: ask.value,
      // Rounded to 1/10,000 only to drop binary noise: a half-cent mid stays a half cent.
      mid: Math.round(((bid.value + ask.value) / 2) * 10_000) / 10_000,
      last: last?.value ?? null,
      underlyingLast: underlyingLast?.value ?? null,
      tickKind: delayed ? "delayed" : "live",
      fetchedAt,
    };
  } catch (err) {
    console.warn(`[option-quote] stopped: ${errorCode(err)}`);
    return refuse(connected() ? "broker-error" : "not-connected");
  }
}

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
 *      (by its contract id), in parallel, following lib/tws/atm-straddle.ts:
 *      the market-data type is set to DELAYED_FROZEN for the request and put
 *      back to REALTIME afterwards, and IB's non-positive "no quote" sentinel
 *      never counts as a price.
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
  | "broker-error";

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

/** IB's "No security definition has been found for the request". */
const IB_NO_SECURITY_DEFINITION = 200;

class QuoteTimeout extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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

interface TickFigure {
  value: number;
  delayed: boolean;
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

function errorCode(err: unknown): string {
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

    let optionTicks: ReadonlyMap<number, { value?: number }> | null = null;
    let optionTimedOut = false;
    let underlyingTicks: ReadonlyMap<number, { value?: number }> | null = null;
    let optionError: unknown = null;
    // A throw while SENDING (setMarketDataType, or a snapshot call that throws synchronously)
    // is the broker connection failing, not an empty quote.
    let sendError: unknown = null;
    try {
      api.setMarketDataType(MarketDataType.DELAYED_FROZEN);
      const [o, u] = await Promise.allSettled([
        withTimeout(api.getMarketDataSnapshot(optionContract, "", false), timeoutMs),
        withTimeout(api.getMarketDataSnapshot(underlyingContract, "", false), timeoutMs),
      ]);
      if (o.status === "fulfilled") optionTicks = o.value as ReadonlyMap<number, { value?: number }>;
      else if (o.reason instanceof QuoteTimeout) optionTimedOut = true;
      else optionError = o.reason;
      if (u.status === "fulfilled") underlyingTicks = u.value as ReadonlyMap<number, { value?: number }>;
    } catch (err) {
      sendError = err;
    } finally {
      try {
        api.setMarketDataType(MarketDataType.REALTIME);
      } catch {
        // Non-critical, best-effort reset (same as atm-straddle.ts).
      }
    }

    if (sendError !== null) {
      if (!connected()) return refuse("not-connected");
      console.warn(`[option-quote] request failed: ${errorCode(sendError)}`);
      return refuse("broker-error");
    }
    if (optionTimedOut) return refuse("timeout");
    if (optionTicks === null) {
      if (!connected()) return refuse("not-connected");
      console.warn(`[option-quote] snapshot failed: ${errorCode(optionError)}`);
      return refuse("no-two-sided-quote");
    }

    const bid = readTick(optionTicks, IBApiTickType.BID, IBApiTickType.DELAYED_BID);
    const ask = readTick(optionTicks, IBApiTickType.ASK, IBApiTickType.DELAYED_ASK);
    const last = readTick(optionTicks, IBApiTickType.LAST, IBApiTickType.DELAYED_LAST);
    const underlyingLast = underlyingTicks
      ? readTick(underlyingTicks, IBApiTickType.LAST, IBApiTickType.DELAYED_LAST)
      : null;

    // Two-sided means both sides AND not crossed: a bid above the ask is not a market.
    // A locked market (bid equals ask) is a market.
    if (bid === null || ask === null || bid.value > ask.value) {
      return refuse("no-two-sided-quote", { bid: bid?.value ?? null, ask: ask?.value ?? null, last: last?.value ?? null });
    }
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

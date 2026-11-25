import { OptionType, SecType, type Contract, type IBApiNext } from "@stoqey/ib";
import type Database from "better-sqlite3";
import { getIbApi } from "./client";
import {
  brokerExpiryDay,
  errorCode,
  IB_NO_SECURITY_DEFINITION,
  OPTION_QUOTE_TIMEOUT_MS,
  QuoteTimeout,
  withTimeout,
} from "./option-quote";
import { CANDIDATE_BOUNDS, TRIAL_OPTION_MULTIPLIER } from "@/lib/analysis/gains-at-risk-constants";
import { todayET } from "@/lib/calendar/date-utils";
// The one "has this contract stopped trading" rule (the expiry day ends at the 16:00 Eastern close).
import { isExpiredAsOf } from "@/lib/compute/options-greeks";

/**
 * The guarded option-chain reader for the Gains at risk candidate table (step 3,
 * rulings P11, D1, D7). It reads the chain of ONE underlying that has a
 * securities row with a broker contract id; it never looks a symbol up and
 * never adds a security. `GET /api/tws/option-chain` is left as it is.
 *
 *   - Without expiries: ONE `getSecDefOptParams(symbol, "", STK, conId)`. The
 *     merged structure list is used ONLY to list expiries: from entries of the
 *     standard class only (multiplier 100 AND trading class = the underlying's
 *     symbol, so an adjusted class's expiry is never offered and then found
 *     empty), still trading at the injected clock by `isExpiredAsOf` (today's
 *     expiry is not offered from the 16:00 Eastern close), ascending, unique,
 *     YYYY-MM-DD.
 *   - With 1 to 3 expiries: ONE `getContractDetails` per expiry for the right
 *     (symbol, OPT, SMART, USD, expiry, right, multiplier 100). Kept: details
 *     with a positive contract id, multiplier 100, the standard trading class
 *     (the underlying's own symbol) and the asked expiry; the rest are counted
 *     `droppedNonStandard`. A strike with two kept contracts is dropped, and
 *     counted once in `droppedAmbiguous`. Strikes ascending. Each kept strike
 *     carries the broker's contract id, trading class and multiplier (D1).
 *
 * Its own request bound (D7): at most OPTION_CHAIN_RATE_LIMIT broker requests
 * in any rolling OPTION_CHAIN_RATE_WINDOW_MS, the app's own figure (not a
 * broker one). A pull costs 1 (expiries) or one per chosen expiry (strikes),
 * reserved all or nothing before the first request. Not on the
 * historical-data limiter. A contract-details request has no cancel: on a
 * timeout the reader stops sending and ignores the late reply. One
 * content-free log line per failure (a stage and a code).
 */

export const OPTION_CHAIN_RATE_LIMIT = 12;
export const OPTION_CHAIN_RATE_WINDOW_MS = 60_000;

const limiterState = globalThis as unknown as { __tws_optionChainTimes?: number[] };

/** All or nothing: n slots at `now`, or none with the whole seconds until enough free. */
export function reserveOptionChainSlots(n: number, now: number = Date.now()): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const times = (limiterState.__tws_optionChainTimes ?? []).filter((t) => now - t < OPTION_CHAIN_RATE_WINDOW_MS);
  limiterState.__tws_optionChainTimes = times;
  const asked = Math.max(0, Math.floor(n));
  if (asked > OPTION_CHAIN_RATE_LIMIT) return { ok: false, retryAfterSeconds: Math.ceil(OPTION_CHAIN_RATE_WINDOW_MS / 1000) };
  const free = OPTION_CHAIN_RATE_LIMIT - times.length;
  if (asked > free) {
    // The (asked - free)th oldest slot must leave the window first.
    const freesAt = times[asked - free - 1] + OPTION_CHAIN_RATE_WINDOW_MS;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((freesAt - now) / 1000)) };
  }
  for (let i = 0; i < asked; i++) times.push(now);
  return { ok: true };
}

/** Tests only: forget every slot. */
export function resetOptionChainLimiter(): void {
  limiterState.__tws_optionChainTimes = [];
}

export interface ChainContract {
  conId: number;
  strike: number;
  tradingClass: string;
  multiplier: 100;
}

export type OptionChainRequest = {
  underlyingSecurityId: number;
  right: "put" | "call";
  /** YYYY-MM-DD, 1 to CANDIDATE_BOUNDS.maxExpiriesPerPull when present. */
  expiries?: string[];
};

export type OptionChainResult =
  | { ok: true; kind: "expiries"; expiries: string[] }
  | {
      ok: true;
      kind: "strikes";
      byExpiry: { expiry: string; contracts: ChainContract[]; droppedNonStandard: number; droppedAmbiguous: number }[];
    }
  | { ok: false; reason: "not-connected" | "no-underlying-contract" | "rate-limit" | "timeout" | "broker-error"; retryAfterSeconds?: number };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function fetchOptionChain(
  db: Database.Database,
  req: OptionChainRequest,
  deps: { api?: IBApiNext | null; now?: () => Date; timeoutMs?: number } = {},
): Promise<OptionChainResult> {
  // A malformed request is a programming error of the caller (the route checks the body first).
  if (req.expiries !== undefined) {
    if (req.expiries.length < 1 || req.expiries.length > CANDIDATE_BOUNDS.maxExpiriesPerPull) {
      throw new RangeError(`expiries: 1 to ${CANDIDATE_BOUNDS.maxExpiriesPerPull}`);
    }
    if (!req.expiries.every((e) => ISO_DAY.test(e))) throw new RangeError("expiries: YYYY-MM-DD");
  }
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? OPTION_QUOTE_TIMEOUT_MS;
  const connected = (): boolean => getIbApi() !== null;
  try {
    const api = deps.api === undefined ? getIbApi() : deps.api;
    if (!api) return { ok: false, reason: "not-connected" };

    const und = db
      .prepare("SELECT symbol, ib_con_id FROM securities WHERE id = ?")
      .get(req.underlyingSecurityId) as { symbol: string | null; ib_con_id: number | null } | undefined;
    const symbol = (und?.symbol ?? "").trim().toUpperCase();
    if (!und || und.ib_con_id === null || symbol === "") return { ok: false, reason: "no-underlying-contract" };

    const slots = reserveOptionChainSlots(req.expiries ? req.expiries.length : 1, now().getTime());
    if (!slots.ok) return { ok: false, reason: "rate-limit", retryAfterSeconds: slots.retryAfterSeconds };

    const failure = (stage: string, err: unknown): OptionChainResult => {
      if (err instanceof QuoteTimeout) return { ok: false, reason: "timeout" };
      if (!connected()) return { ok: false, reason: "not-connected" };
      console.warn(`[option-chain] ${stage} failed: ${errorCode(err)}`);
      return { ok: false, reason: "broker-error" };
    };

    if (!req.expiries) {
      let params: Awaited<ReturnType<IBApiNext["getSecDefOptParams"]>>;
      try {
        params = await withTimeout(api.getSecDefOptParams(symbol, "", SecType.STK, und.ib_con_id), timeoutMs);
      } catch (err) {
        return failure("structure", err);
      }
      const at = now();
      const today = todayET(at);
      const days = new Set<string>();
      for (const p of params ?? []) {
        if (Number(p?.multiplier) !== TRIAL_OPTION_MULTIPLIER) continue;
        if ((p?.tradingClass ?? "").trim().toUpperCase() !== symbol) continue;
        for (const raw of p.expirations ?? []) {
          const day = brokerExpiryDay(raw);
          if (day !== null && !isExpiredAsOf(day, today, at)) days.add(day);
        }
      }
      return { ok: true, kind: "expiries", expiries: [...days].sort() };
    }

    const right = req.right === "put" ? OptionType.Put : OptionType.Call;
    const byExpiry: Extract<OptionChainResult, { kind: "strikes" }>["byExpiry"] = [];
    for (const expiry of req.expiries) {
      const lastTradeDateOrContractMonth = expiry.replace(/-/g, "");
      const lookup: Contract = {
        symbol,
        secType: SecType.OPT,
        exchange: "SMART",
        currency: "USD",
        lastTradeDateOrContractMonth,
        right,
        multiplier: TRIAL_OPTION_MULTIPLIER,
      };
      let details: Awaited<ReturnType<IBApiNext["getContractDetails"]>>;
      try {
        details = await withTimeout(api.getContractDetails(lookup), timeoutMs);
      } catch (err) {
        // "No security definition": the broker lists nothing for that expiry and right.
        if ((err as { code?: unknown } | null)?.code === IB_NO_SECURITY_DEFINITION) details = [];
        else return failure("strikes", err);
      }
      let droppedNonStandard = 0;
      const byStrike = new Map<number, ChainContract[]>();
      for (const d of details ?? []) {
        const c = d?.contract;
        const conId = Number(c?.conId);
        const strike = Number(c?.strike);
        const standard =
          Number.isInteger(conId) &&
          conId > 0 &&
          Number(c?.multiplier) === TRIAL_OPTION_MULTIPLIER &&
          (c?.tradingClass ?? "").trim().toUpperCase() === symbol &&
          brokerExpiryDay(c?.lastTradeDateOrContractMonth) === expiry &&
          Number.isFinite(strike) &&
          strike > 0;
        if (!standard) {
          droppedNonStandard++;
          continue;
        }
        const list = byStrike.get(strike) ?? [];
        list.push({ conId, strike, tradingClass: symbol, multiplier: TRIAL_OPTION_MULTIPLIER });
        byStrike.set(strike, list);
      }
      let droppedAmbiguous = 0;
      const contracts: ChainContract[] = [];
      for (const [, list] of [...byStrike.entries()].sort((a, b) => a[0] - b[0])) {
        if (list.length === 1) contracts.push(list[0]);
        else droppedAmbiguous++;
      }
      byExpiry.push({ expiry, contracts, droppedNonStandard, droppedAmbiguous });
    }
    return { ok: true, kind: "strikes", byExpiry };
  } catch (err) {
    console.warn(`[option-chain] stopped: ${errorCode(err)}`);
    return { ok: false, reason: connected() ? "broker-error" : "not-connected" };
  }
}

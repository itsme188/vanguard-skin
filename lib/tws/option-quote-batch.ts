import { MarketDataType, OptionType, SecType, type Contract, type IBApiNext } from "@stoqey/ib";
import type Database from "better-sqlite3";
import { getIbApi } from "./client";
import { isSyncing as defaultIsSyncing } from "./sync-state";
import { marketDataTypeGeneration, setMarketDataTypeCounted } from "./market-data-type";
import {
  brokerExpiryDay,
  errorCode,
  OptionQuoteLockBusy,
  IB_NO_SECURITY_DEFINITION,
  OPTION_QUOTE_TIMEOUT_MS,
  QuoteTimeout,
  reserveOptionQuoteSlots,
  snapshotTicks,
  twoSidedQuote,
  underlyingLastTick,
  withOptionQuoteLock,
  withTimeout,
  type QuoteTickKind,
  type SnapshotTicksResult,
  type TickFigure,
} from "./option-quote";
import {
  CANDIDATE_BOUNDS,
  CANDIDATE_MAX_OBSERVATION_GAP_SECONDS,
  MONEY_UNITS_PER_DOLLAR,
  TRIAL_OPTION_MULTIPLIER,
} from "@/lib/analysis/gains-at-risk-constants";

/**
 * Broker quotes for up to 15 candidate option contracts on ONE underlying
 * (Gains at risk step 3, rulings P10, D1, D2, D6, D7, F5, F7, F9). Nothing is
 * stored.
 *
 * Before any broker request, in this order: the connection (`not-connected`),
 * the underlying's securities row with a broker contract id
 * (`no-underlying-contract`), a running sync (`sync-running`), then the lock
 * shared with the single quote (`withOptionQuoteLock`; the wait counts toward
 * the deadline and is bounded by OPTION_QUOTE_LOCK_WAIT_MS, past which the
 * whole pull is refused `broker-busy`). Under the lock: the sync again (a sync
 * that started during the wait refuses the whole pull), the connection and
 * the deadline (past it every row reads `not-quoted-timed-out`), and only then
 * the shared quote limiter, counted and taken in one call
 * (`reserveOptionQuoteSlots`): no free slot refuses the whole pull
 * (`rate-limit`), fewer than asked quotes the first `granted` contracts and
 * returns the rest `not-quoted-rate-limit` with no request for them. None of
 * the refusals before the limiter spends a slot.
 *
 * Then the type is set to DELAYED_FROZEN once through the one setter; ONE
 * underlying snapshot (re-read once when the type was changed by someone else
 * while it was in flight; a second change makes every contract that would use
 * it `not-quoted-broker-busy`);
 * then per contract, ONE AFTER ANOTHER (never two open subscriptions): one
 * contract-details request by contract id, the D1 identity check, the D6
 * underlying-age check, one option snapshot awaited to its own end, the D2
 * generation check (one retry), the two-sided rule, the 1/10,000 grid and the
 * D6 gap check.
 *
 * Before EVERY new broker operation (F7) the batch checks the connection, the
 * deadline and the sync: disconnected, this and every later contract read
 * `broker-disconnected`; past the deadline, `not-quoted-timed-out`; a sync
 * running, `not-quoted-sync-running`; and nothing more is sent. An operation
 * already started is awaited (a snapshot to its own end or the 13 s backstop,
 * a contract-details call up to its 15 s timeout), so the worst overrun past
 * the deadline is one operation. The package sends no broker cancel for a
 * snapshot (lib/tws/option-quote.ts `snapshotTicks`), so the type is restored
 * and the lock released only after nothing is pending: in a `finally`,
 * REALTIME once through the setter when still connected, then the lock.
 *
 * An ok row ALWAYS carries the underlying's own price and both arrival times,
 * at most CANDIDATE_MAX_OBSERVATION_GAP_SECONDS apart (F5); otherwise the row
 * is refused, never filled from an older price. Never throws for a broker or
 * clock event. One content-free log line per failure stage (stage and code,
 * never a symbol, strike or price).
 */

export const OPTION_QUOTE_BATCH_DEADLINE_MS = 120_000;

/** The package's documented longest snapshot ("after 11s latest"), used to decide when the underlying is too old to start a contract. */
const PACKAGE_SNAPSHOT_MAX_SECONDS = 11;

export interface BatchContractRequest {
  conId: number;
  right: "put" | "call";
  /** YYYY-MM-DD. */
  expiry: string;
  strike: number;
  multiplier: 100;
  tradingClass: string;
}

export interface OptionQuoteBatchRequest {
  underlyingSecurityId: number;
  /** 1 to CANDIDATE_BOUNDS.maxContractsPerPull. */
  contracts: BatchContractRequest[];
}

export type BatchContractRefusal =
  | "not-standard-contract"
  | "not-quoted-rate-limit"
  | "not-quoted-timed-out"
  | "broker-disconnected"
  | "not-quoted-broker-busy"
  | "not-quoted-sync-running"
  | "not-quoted-prices-too-far-apart"
  | "not-quoted-no-underlying-price"
  | "off-tick-grid"
  | "no-two-sided-quote"
  | "timeout"
  | "broker-error";

export type BatchContractResult =
  | {
      conId: number;
      ok: true;
      bid: number;
      ask: number;
      mid: number;
      last: number | null;
      tickKind: QuoteTickKind;
      optionObservedAt: string;
      underlyingObservedAt: string;
      underlyingPrice: number;
    }
  | {
      conId: number;
      ok: false;
      reason: BatchContractRefusal;
      retryAfterSeconds?: number;
      bid: number | null;
      ask: number | null;
      last: number | null;
    };

export type OptionQuoteBatchResult =
  | { ok: true; contracts: BatchContractResult[] }
  | {
      ok: false;
      /** `broker-busy`: the lock wait exceeded OPTION_QUOTE_LOCK_WAIT_MS; nothing was sent and no slot spent. */
      reason: "not-connected" | "no-underlying-contract" | "sync-running" | "rate-limit" | "broker-busy";
      retryAfterSeconds?: number;
    };

export interface OptionQuoteBatchDeps {
  api?: IBApiNext | null;
  now?: () => Date;
  /** Per contract-details request; default OPTION_QUOTE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Overall deadline from the call; default OPTION_QUOTE_BATCH_DEADLINE_MS. */
  deadlineMs?: number;
  isSyncing?: () => boolean;
}

const refusal = (
  conId: number,
  reason: BatchContractRefusal,
  figures: { bid?: number | null; ask?: number | null; last?: number | null; retryAfterSeconds?: number } = {},
): BatchContractResult => ({
  conId,
  ok: false,
  reason,
  ...(figures.retryAfterSeconds !== undefined ? { retryAfterSeconds: figures.retryAfterSeconds } : {}),
  bid: figures.bid ?? null,
  ask: figures.ask ?? null,
  last: figures.last ?? null,
});

/** A price on the 1/10,000 grid as whole units, or null when it is off the grid (never rounded onto it). */
function gridUnits(price: number): number | null {
  const scaled = price * MONEY_UNITS_PER_DOLLAR;
  const units = Math.round(scaled);
  return Math.abs(scaled - units) <= 1e-6 && Number.isSafeInteger(units) ? units : null;
}

function rightIs(raw: unknown, right: "put" | "call"): boolean {
  const r = String(raw ?? "").trim().toUpperCase();
  return right === "put" ? r === OptionType.Put || r === "PUT" : r === OptionType.Call || r === "CALL";
}

/** D1: the broker's own description must be exactly the standard contract the chain reader named. */
function isStandardMatch(
  details: Awaited<ReturnType<IBApiNext["getContractDetails"]>> | null | undefined,
  want: BatchContractRequest,
  underlyingSymbol: string,
): boolean {
  const list = details ?? [];
  const sameId = list.filter((d) => Number(d?.contract?.conId) === want.conId);
  if (list.length !== 1 || sameId.length !== 1) return false;
  const c = sameId[0].contract;
  const tradingClass = (c.tradingClass ?? "").trim().toUpperCase();
  return (
    (c.symbol ?? "").trim().toUpperCase() === underlyingSymbol &&
    rightIs(c.right, want.right) &&
    brokerExpiryDay(c.lastTradeDateOrContractMonth) === want.expiry &&
    Number(c.strike) === want.strike &&
    Number(c.multiplier) === TRIAL_OPTION_MULTIPLIER &&
    tradingClass === want.tradingClass.trim().toUpperCase() &&
    tradingClass === underlyingSymbol
  );
}

export async function fetchOptionQuoteBatch(
  db: Database.Database,
  req: OptionQuoteBatchRequest,
  deps: OptionQuoteBatchDeps = {},
): Promise<OptionQuoteBatchResult> {
  // A malformed request is a programming error of the caller (the route checks the body first).
  if (req.contracts.length < 1 || req.contracts.length > CANDIDATE_BOUNDS.maxContractsPerPull) {
    throw new RangeError(`contracts: 1 to ${CANDIDATE_BOUNDS.maxContractsPerPull}`);
  }
  const now = deps.now ?? (() => new Date());
  const syncing = deps.isSyncing ?? defaultIsSyncing;
  const deadline = now().getTime() + (deps.deadlineMs ?? OPTION_QUOTE_BATCH_DEADLINE_MS);
  const connected = (): boolean => getIbApi() !== null;
  try {
    const api = deps.api === undefined ? getIbApi() : deps.api;
    if (!api) return { ok: false, reason: "not-connected" };

    const und = db
      .prepare("SELECT symbol, ib_con_id FROM securities WHERE id = ?")
      .get(req.underlyingSecurityId) as { symbol: string | null; ib_con_id: number | null } | undefined;
    const symbol = (und?.symbol ?? "").trim().toUpperCase();
    if (!und || und.ib_con_id === null || symbol === "") return { ok: false, reason: "no-underlying-contract" };

    if (syncing()) return { ok: false, reason: "sync-running" };

    return await withOptionQuoteLock(() =>
      quoteUnderLock(api, req, {
        symbol,
        underlyingConId: und.ib_con_id!,
        now,
        syncing,
        deadline,
        connected,
        timeoutMs: deps.timeoutMs ?? OPTION_QUOTE_TIMEOUT_MS,
      }),
    );
  } catch (err) {
    if (err instanceof OptionQuoteLockBusy) {
      console.warn("[option-quote-batch] lock wait exceeded: broker-busy");
      return { ok: false, reason: "broker-busy" };
    }
    console.warn(`[option-quote-batch] stopped: ${errorCode(err)}`);
    const reason: BatchContractRefusal = connected() ? "broker-error" : "broker-disconnected";
    return { ok: true, contracts: req.contracts.map((c) => refusal(c.conId, reason)) };
  }
}

interface RunContext {
  symbol: string;
  underlyingConId: number;
  now: () => Date;
  syncing: () => boolean;
  deadline: number;
  connected: () => boolean;
  timeoutMs: number;
}

interface UnderlyingObservation {
  /** null: the snapshot carried no positive last (or failed while still connected, or `busy`). */
  price: TickFigure | null;
  /** The type was changed by someone else during the read and during its one re-read (D2). */
  busy?: true;
  atMs: number;
  at: string;
}

async function quoteUnderLock(api: IBApiNext, req: OptionQuoteBatchRequest, ctx: RunContext): Promise<OptionQuoteBatchResult> {
  // F7: a sync that started while this pull waited for the lock refuses the whole pull, before any request.
  if (ctx.syncing()) return { ok: false, reason: "sync-running" };

  const n = req.contracts.length;
  const rows: (BatchContractResult | undefined)[] = new Array(n);
  let granted = n;
  const fillFrom = (from: number, reason: BatchContractRefusal): void => {
    for (let i = from; i < granted; i++) if (rows[i] === undefined) rows[i] = refusal(req.contracts[i].conId, reason);
  };
  const log = (stage: string, err?: unknown): void => {
    console.warn(`[option-quote-batch] ${stage}${err === undefined ? "" : `: ${errorCode(err)}`}`);
  };
  /** F7: checked before every new broker operation. null = go ahead. */
  const gate = (): BatchContractRefusal | null => {
    if (!ctx.connected()) return "broker-disconnected";
    if (ctx.now().getTime() > ctx.deadline) return "not-quoted-timed-out";
    if (ctx.syncing()) return "not-quoted-sync-running";
    return null;
  };

  const gapMs = CANDIDATE_MAX_OBSERVATION_GAP_SECONDS * 1000;
  const freshForMs = (CANDIDATE_MAX_OBSERVATION_GAP_SECONDS - PACKAGE_SNAPSHOT_MAX_SECONDS) * 1000;
  const underlyingContract: Contract = { conId: ctx.underlyingConId, secType: SecType.STK, exchange: "SMART", currency: "USD" };

  /** The type generation this batch last set (D2). */
  let own = 0;

  /**
   * One underlying read, gated (F7) before each request. When the type was changed by someone
   * else while it was in flight, the type is set again and the underlying re-read ONCE; a second
   * change gives a `busy` observation (every contract that would use it reads broker busy).
   */
  const observeUnderlying = async (): Promise<UnderlyingObservation | { stop: BatchContractRefusal }> => {
    for (let attempt = 0; ; attempt++) {
      const g = gate();
      if (g !== null) return { stop: g };
      const r: SnapshotTicksResult = await snapshotTicks(api, underlyingContract, { now: ctx.now });
      if (!r.ok && (r.reason === "disconnected" || !ctx.connected())) return { stop: "broker-disconnected" };
      if (marketDataTypeGeneration() !== own) {
        if (attempt >= 1) {
          log("market-data type changed twice during the underlying read: broker-busy");
          const at = ctx.now();
          return { price: null, busy: true, atMs: at.getTime(), at: at.toISOString() };
        }
        const g2 = gate();
        if (g2 !== null) return { stop: g2 };
        own = setMarketDataTypeCounted(api, MarketDataType.DELAYED_FROZEN);
        continue;
      }
      if (r.ok) return { price: underlyingLastTick(r.ticks), atMs: Date.parse(r.arrivedAt), at: r.arrivedAt };
      log(`underlying snapshot ${r.reason}`, r.error);
      const at = ctx.now();
      return { price: null, atMs: at.getTime(), at: at.toISOString() };
    }
  };
  const noUnderlyingReason = (u: UnderlyingObservation): BatchContractRefusal =>
    u.busy ? "not-quoted-broker-busy" : "not-quoted-no-underlying-price";

  let cursor = 0;
  let typeAttempted = false;
  try {
    // F7 and fix round 1: connection and deadline after the lock, BEFORE the limiter, so a
    // refusal here spends no slot.
    const first = gate();
    if (first !== null) {
      fillFrom(0, first);
      return { ok: true, contracts: rows as BatchContractResult[] };
    }
    const slots = reserveOptionQuoteSlots(n, ctx.now().getTime());
    if (slots.granted === 0) return { ok: false, reason: "rate-limit", retryAfterSeconds: slots.retryAfterSeconds ?? 1 };
    granted = slots.granted;
    for (let i = granted; i < n; i++) {
      rows[i] = refusal(req.contracts[i].conId, "not-quoted-rate-limit", { retryAfterSeconds: slots.retryAfterSeconds ?? 1 });
    }

    typeAttempted = true;
    own = setMarketDataTypeCounted(api, MarketDataType.DELAYED_FROZEN);

    let underlying: UnderlyingObservation;
    {
      const u = await observeUnderlying();
      if ("stop" in u) {
        fillFrom(0, u.stop);
        return { ok: true, contracts: rows as BatchContractResult[] };
      }
      underlying = u;
    }

    contracts: for (cursor = 0; cursor < granted; cursor++) {
      const want = req.contracts[cursor];
      const stop = (reason: BatchContractRefusal): void => fillFrom(cursor, reason);

      // 1. The broker's own description of the contract, by contract id (D1).
      let g = gate();
      if (g !== null) {
        stop(g);
        break;
      }
      let details: Awaited<ReturnType<IBApiNext["getContractDetails"]>>;
      try {
        details = await withTimeout(
          api.getContractDetails({ conId: want.conId, secType: SecType.OPT, exchange: "SMART", currency: "USD" }),
          ctx.timeoutMs,
        );
      } catch (err) {
        if (err instanceof QuoteTimeout) {
          log("contract lookup timeout");
          rows[cursor] = refusal(want.conId, "timeout");
          continue;
        }
        if ((err as { code?: unknown } | null)?.code === IB_NO_SECURITY_DEFINITION) {
          rows[cursor] = refusal(want.conId, "not-standard-contract");
          continue;
        }
        if (!ctx.connected()) {
          stop("broker-disconnected");
          break;
        }
        log("contract lookup failed", err);
        rows[cursor] = refusal(want.conId, "broker-error");
        continue;
      }
      if (!isStandardMatch(details, want, ctx.symbol)) {
        rows[cursor] = refusal(want.conId, "not-standard-contract");
        continue;
      }

      // 2. D6: an underlying too old to start this contract is observed again first.
      if (ctx.now().getTime() - underlying.atMs > freshForMs) {
        const u = await observeUnderlying();
        if ("stop" in u) {
          stop(u.stop);
          break;
        }
        underlying = u;
      }
      if (underlying.price === null) {
        rows[cursor] = refusal(want.conId, noUnderlyingReason(underlying));
        continue;
      }

      // 3. The option snapshot, awaited to its own end; one retry when the type moved under it (D2).
      const optionContract: Contract = {
        conId: want.conId,
        symbol: ctx.symbol,
        secType: SecType.OPT,
        exchange: "SMART",
        currency: "USD",
        lastTradeDateOrContractMonth: want.expiry.replace(/-/g, ""),
        strike: want.strike,
        right: want.right === "put" ? OptionType.Put : OptionType.Call,
        multiplier: TRIAL_OPTION_MULTIPLIER,
      };
      let option: SnapshotTicksResult | null = null;
      for (let attempt = 0; ; attempt++) {
        g = gate();
        if (g !== null) {
          stop(g);
          break contracts;
        }
        option = await snapshotTicks(api, optionContract, { now: ctx.now });
        if (!option.ok && (option.sendFailed || option.reason === "disconnected")) break;
        if (marketDataTypeGeneration() === own) break;
        if (attempt >= 1) {
          log("market-data type changed twice: broker-busy");
          rows[cursor] = refusal(want.conId, "not-quoted-broker-busy");
          option = null;
          break;
        }
        g = gate();
        if (g !== null) {
          stop(g);
          break contracts;
        }
        own = setMarketDataTypeCounted(api, MarketDataType.DELAYED_FROZEN);
      }
      if (option === null) continue;
      if (!option.ok) {
        if (option.reason === "disconnected" || !ctx.connected()) {
          stop("broker-disconnected");
          break;
        }
        if (option.sendFailed) {
          log("option snapshot send failed", option.error);
          rows[cursor] = refusal(want.conId, "broker-error");
        } else if (option.reason === "timeout") {
          log("option snapshot timeout");
          rows[cursor] = refusal(want.conId, "timeout");
        } else {
          log("option snapshot failed", option.error);
          rows[cursor] = refusal(want.conId, "no-two-sided-quote");
        }
        continue;
      }

      // 4. The shared two-sided rule, then the grid (D9: never rounded onto it).
      const quote = twoSidedQuote(option.ticks);
      if (!quote.ok) {
        rows[cursor] = refusal(want.conId, "no-two-sided-quote", { bid: quote.bid, ask: quote.ask, last: quote.last });
        continue;
      }
      const bidUnits = gridUnits(quote.bid.value);
      const askUnits = gridUnits(quote.ask.value);
      if (bidUnits === null || askUnits === null) {
        rows[cursor] = refusal(want.conId, "off-tick-grid");
        continue;
      }

      // 5. D6 / F5: the two prices must be observed close together; one more underlying read, then refuse.
      const optionAtMs = Date.parse(option.arrivedAt);
      if (Math.abs(optionAtMs - underlying.atMs) > gapMs) {
        const u = await observeUnderlying();
        if ("stop" in u) {
          stop(u.stop);
          break;
        }
        underlying = u;
        if (underlying.price === null) {
          rows[cursor] = refusal(want.conId, noUnderlyingReason(underlying));
          continue;
        }
        if (Math.abs(optionAtMs - underlying.atMs) > gapMs) {
          rows[cursor] = refusal(want.conId, "not-quoted-prices-too-far-apart");
          continue;
        }
      }

      const underlyingPrice: TickFigure = underlying.price!;
      const delayed = [quote.bid, quote.ask, quote.last, underlyingPrice].some((f) => f !== null && f.delayed);
      rows[cursor] = {
        conId: want.conId,
        ok: true,
        bid: quote.bid.value,
        ask: quote.ask.value,
        mid: (bidUnits + askUnits) / (2 * MONEY_UNITS_PER_DOLLAR),
        last: quote.last?.value ?? null,
        tickKind: delayed ? "delayed" : "live",
        optionObservedAt: option.arrivedAt,
        underlyingObservedAt: underlying.at,
        underlyingPrice: underlyingPrice.value,
      };
    }
  } catch (err) {
    log("stopped", err);
    fillFrom(cursor, ctx.connected() ? "broker-error" : "broker-disconnected");
  } finally {
    // Every snapshot this batch started has settled (each is awaited); only now restore the type.
    if (typeAttempted && ctx.connected()) {
      try {
        setMarketDataTypeCounted(api, MarketDataType.REALTIME);
      } catch {
        // Non-critical, best-effort reset (same as the single quote).
      }
    }
  }
  fillFrom(0, "not-quoted-timed-out");
  return { ok: true, contracts: rows as BatchContractResult[] };
}

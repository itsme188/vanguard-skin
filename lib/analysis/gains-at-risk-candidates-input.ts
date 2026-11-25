/**
 * Gains at risk, step 3: the bodies, replies and sentences of the four new
 * routes (single-name drivers, chain, quotes, candidates).
 *
 * A plain module shared by the routes and the page: it value-imports only
 * other plain `lib/analysis` modules (the import-free constants, the money
 * module and the step 1 input rules). Every engine, query and broker name
 * below is a TYPE import, erased at build, so nothing server-side reaches the
 * browser (P18; the import walk in tests/dashboard/gains-at-risk-view-source.test.ts).
 *
 * The call-2 validator (`candidatesProblem`) is server code and lives in
 * `lib/compute/gains-at-risk-candidate-check.ts` (plan OPEN 1); the route runs
 * it after `candidatesBodyProblem` here.
 */

import { CANDIDATE_BOUNDS, TRIAL_OPTION_MULTIPLIER, TRIAL_POSITION_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import { budgetToUnits } from "@/lib/analysis/gains-at-risk-candidate-money";
import { gainsAtRiskBodyProblem, isCalendarDay } from "@/lib/analysis/gains-at-risk-input";
import type { GainsAtRiskBody, GainsAtRiskResponse } from "@/lib/analysis/gains-at-risk-input";
import type { CandidateUnderlyingEntry, SingleNameDriverEntry } from "@/lib/compute/gains-at-risk-drivers";
import type { CandidateQuoteFields, CandidateRequestItem } from "@/lib/compute/gains-at-risk-candidate-check";
import type { CandidateRow } from "@/lib/compute/gains-at-risk-candidates";
import type { TrialEntryRefusal, TrialEntryResult } from "@/lib/compute/gains-at-risk-trial";
import type { ChainContract, OptionChainResult } from "@/lib/tws/option-chain-reader";
import type { BatchContractRefusal, BatchContractRequest, OptionQuoteBatchResult } from "@/lib/tws/option-quote-batch";

export type { CandidateQuoteFields, CandidateRequestItem, CandidateRow, ChainContract, BatchContractRequest, BatchContractRefusal };

const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isPositiveId = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** A trading class: 1 to 12 letters and digits (fix round 1). */
export const TRADING_CLASS_MAX_LENGTH = 12;
const TRADING_CLASS = /^[A-Za-z0-9]{1,12}$/;
const isTradingClass = (x: unknown): x is string => typeof x === "string" && TRADING_CLASS.test(x);

/**
 * The furthest expiry a chain or quotes body may name, in years after today
 * (fix round 1). Listed options run about three years out at most.
 */
export const CANDIDATE_EXPIRY_MAX_YEARS = 3;

/** The same month and day CANDIDATE_EXPIRY_MAX_YEARS on (Feb 28 when that day does not exist). */
export function latestCandidateExpiry(today: string): string {
  const candidate = `${Number(today.slice(0, 4)) + CANDIDATE_EXPIRY_MAX_YEARS}${today.slice(4)}`;
  return isCalendarDay(candidate) ? candidate : `${candidate.slice(0, 8)}28`;
}

/**
 * The day rules a body can check without a clock: a real day, not before
 * today, not past `latestCandidateExpiry`. Whether today's expiry still
 * trades (the 16:00 Eastern close) is checked on the server with the chain
 * reader's own rule (`expiryNotLiveProblem`, lib/compute/gains-at-risk-candidate-quotes.ts).
 */
function expiryDayProblem(value: unknown, field: string, today: string): string | null {
  if (typeof value !== "string" || !isCalendarDay(value)) return `${field} must be a real day written YYYY-MM-DD.`;
  if (value < today) return `${field} cannot be before today.`;
  const latest = latestCandidateExpiry(today);
  if (value > latest) return `${field} cannot be more than ${CANDIDATE_EXPIRY_MAX_YEARS} years from today (latest ${latest}).`;
  return null;
}

// ─── Single-name drivers (P1, F8) ─────────────────────────────────────────

/** POST /api/compute/gains-at-risk/single-name-drivers. */
export interface SingleNameDriversBody {
  /** The security ids of the current trial positions' underlyings. */
  trialUnderlyingIds: number[];
}

/** The drivers route's `data` (F8 folded in). */
export interface SingleNameDriversResponse {
  drivers: SingleNameDriverEntry[];
  candidateUnderlyings: CandidateUnderlyingEntry[];
}

/** `{ trialUnderlyingIds }`: positive whole numbers, at most `maxPositions`. */
export function singleNameDriversBodyProblem(body: unknown): string | null {
  if (!isPlainObject(body)) return "The request body must be an object.";
  const ids = body.trialUnderlyingIds;
  const max = TRIAL_POSITION_BOUNDS.maxPositions;
  if (!Array.isArray(ids) || ids.length > max) return `trialUnderlyingIds must be a list of at most ${max} security ids.`;
  if (!ids.every(isPositiveId)) return "trialUnderlyingIds must each be a security id (a positive whole number).";
  return null;
}

// ─── The chain (P11, D1, D7) ──────────────────────────────────────────────

/** POST /api/tws/option-candidates/chain. Without `expiries`: the expiries; with 1 to 3: their strikes. */
export interface ChainBody {
  underlyingSecurityId: number;
  right: "put" | "call";
  expiries?: string[];
}

export type ChainResponse =
  | { kind: "expiries"; underlyingSecurityId: number; right: "put" | "call"; expiries: string[] }
  | {
      kind: "strikes";
      underlyingSecurityId: number;
      right: "put" | "call";
      /** The app's own valuation price (`trialValuationPrice`); null when it has none (then no defaults). */
      valuationPrice: number | null;
      byExpiry: {
        expiry: string;
        contracts: ChainContract[];
        /** P11: the five nearest out-of-the-money strikes of this expiry, by contract id. */
        defaultConIds: number[];
        droppedNonStandard: number;
        droppedAmbiguous: number;
      }[];
    };

export function chainBodyProblem(body: unknown, today: string): string | null {
  if (!isPlainObject(body)) return "The request body must be an object.";
  if (!isPositiveId(body.underlyingSecurityId)) return "underlyingSecurityId must be a security id (a positive whole number).";
  if (body.right !== "put" && body.right !== "call") return "right must be put or call.";
  if (body.expiries !== undefined) {
    const e = body.expiries;
    const max = CANDIDATE_BOUNDS.maxExpiriesPerPull;
    if (!Array.isArray(e) || e.length < 1 || e.length > max) return `expiries must be a list of 1 to ${max} days.`;
    for (let i = 0; i < e.length; i++) {
      const problem = expiryDayProblem(e[i], `expiries[${i}]`, today);
      if (problem) return problem;
    }
    if (new Set(e).size !== e.length) return "expiries must not repeat a day.";
  }
  return null;
}

/** A chain body that passed `chainBodyProblem`, rebuilt from its known fields only. */
export function cleanChainBody(body: ChainBody): ChainBody {
  return {
    underlyingSecurityId: body.underlyingSecurityId,
    right: body.right,
    ...(body.expiries !== undefined ? { expiries: [...body.expiries] } : {}),
  };
}

/**
 * P11 default: the `n` strikes nearest `price` on the out-of-the-money side
 * (a put: strictly below; a call: strictly above), ascending. No price, no
 * defaults.
 */
export function defaultCandidateStrikes(
  contracts: readonly ChainContract[],
  price: number | null,
  right: "put" | "call",
  n: number = CANDIDATE_BOUNDS.defaultStrikesPerExpiry,
): number[] {
  if (price === null || !Number.isFinite(price) || price <= 0 || n <= 0) return [];
  const side = [...new Set(contracts.map((c) => c.strike))].filter((s) => (right === "put" ? s < price : s > price));
  side.sort((a, b) => Math.abs(a - price) - Math.abs(b - price) || a - b);
  return side.slice(0, n).sort((a, b) => a - b);
}

type ChainFailure = Extract<OptionChainResult, { ok: false }>["reason"];

/** The chain route's refusals. */
export function chainRefusalSentence(reason: ChainFailure, retryAfterSeconds?: number): string {
  switch (reason) {
    case "not-connected":
      return "Connect the broker to fetch quotes.";
    case "no-underlying-contract":
      return "The broker contract for the underlying is not on file, so the broker cannot be asked.";
    case "rate-limit":
      return `Too many option-chain requests in a minute. Try again in ${retryAfterSeconds ?? 60} seconds.`;
    case "timeout":
      return "The broker did not answer in time. Try again.";
    case "broker-error":
      return "The broker could not answer. Try again.";
  }
}

// ─── The quotes (call 1: P10, P13, D1, D4, D6, F2, F5) ──────────────────────

/** POST /api/tws/option-candidates/quotes. */
export interface QuotesBody {
  underlyingSecurityId: number;
  /** 1 to CANDIDATE_BOUNDS.maxContractsPerPull, as the chain reader returned them. */
  contracts: BatchContractRequest[];
}

/** F2: what call 1 returns for a solved row and what the page keeps (the shape `trialStateFromEntry` reads). */
export interface CandidateEntryRecord {
  /** `buildTrialEntryById`'s record, untouched: its position carries `brokerContractId` (F3). */
  entry: Extract<TrialEntryResult, { ok: true }>;
  /** F5: a candidate is always solved at the quote's own underlying. */
  underlyingPriceSource: "client-quote";
  /** The app's own valuation price at the pull (`trialValuationPrice`); null when it has none. */
  appValuation: { price: number; date: string; source: "book" | "daily-bar" | "stored-price" } | null;
}

export type QuoteRow =
  | { conId: number; status: "quoted"; quote: CandidateQuoteFields; record: CandidateEntryRecord }
  | { conId: number; status: "no-entry"; quote: CandidateQuoteFields; refusal: TrialEntryRefusal; sentence: string }
  | {
      conId: number;
      status: "not-quoted";
      reason: BatchContractRefusal;
      retryAfterSeconds?: number;
      sentence: string;
      bid: number | null;
      ask: number | null;
    };

export interface QuotesResponse {
  underlyingSecurityId: number;
  /** In request order; `rows` follows it, one row per contract. */
  requestedConIds: number[];
  rows: QuoteRow[];
}

export function quotesBodyProblem(body: unknown, today: string): string | null {
  if (!isPlainObject(body)) return "The request body must be an object.";
  if (!isPositiveId(body.underlyingSecurityId)) return "underlyingSecurityId must be a security id (a positive whole number).";
  const list = body.contracts;
  const max = CANDIDATE_BOUNDS.maxContractsPerPull;
  if (!Array.isArray(list) || list.length < 1 || list.length > max) return `contracts must be a list of 1 to ${max} contracts.`;
  const seen = new Set<number>();
  for (let i = 0; i < list.length; i++) {
    const at = `contracts[${i}]`;
    const c = list[i];
    if (!isPlainObject(c)) return `${at} must be an object.`;
    if (!isPositiveId(c.conId)) return `${at}.conId must be the broker's contract id (a positive whole number).`;
    if (seen.has(c.conId)) return `${at}.conId is a duplicate: each contract may appear once.`;
    seen.add(c.conId);
    if (c.right !== "put" && c.right !== "call") return `${at}.right must be put or call.`;
    const expiry = expiryDayProblem(c.expiry, `${at}.expiry`, today);
    if (expiry) return expiry;
    if (!(isFiniteNumber(c.strike) && c.strike > 0 && c.strike <= TRIAL_POSITION_BOUNDS.maxStrike)) {
      return `${at}.strike must be a number above 0 and at most ${TRIAL_POSITION_BOUNDS.maxStrike}.`;
    }
    if (c.multiplier !== TRIAL_OPTION_MULTIPLIER) return `${at}.multiplier must be ${TRIAL_OPTION_MULTIPLIER}.`;
    if (!isTradingClass(c.tradingClass)) {
      return `${at}.tradingClass must be the contract's trading class (1 to ${TRADING_CLASS_MAX_LENGTH} letters and digits).`;
    }
  }
  return null;
}

/** A quotes body that passed `quotesBodyProblem`, rebuilt from its known fields only. */
export function cleanQuotesBody(body: QuotesBody): QuotesBody {
  return {
    underlyingSecurityId: body.underlyingSecurityId,
    contracts: body.contracts.map((c) => ({
      conId: c.conId,
      right: c.right,
      expiry: c.expiry,
      strike: c.strike,
      multiplier: TRIAL_OPTION_MULTIPLIER,
      tradingClass: c.tradingClass,
    })),
  };
}

/** One contract the batch did not quote: the sentence beside the row. */
export function batchRefusalSentence(reason: BatchContractRefusal, retryAfterSeconds?: number): string {
  switch (reason) {
    case "not-standard-contract":
      return "Not a standard contract. Type it in the trial form if you want it.";
    case "not-quoted-rate-limit":
      return `Not quoted: too many quotes in a minute. Try again in ${retryAfterSeconds ?? 60} seconds.`;
    case "not-quoted-timed-out":
      return "Not quoted: timed out. Refresh the quotes.";
    case "broker-disconnected":
      return "Not quoted: broker disconnected.";
    case "not-quoted-broker-busy":
      return "Not quoted: the broker was busy with another request. Try again in a moment.";
    case "not-quoted-sync-running":
      return "Not quoted: a sync started. Try again in a moment.";
    case "not-quoted-prices-too-far-apart":
      return "Not quoted: prices read too far apart. Refresh the quotes.";
    case "not-quoted-no-underlying-price":
      return "Not quoted: the broker gave no price for the underlying.";
    case "off-tick-grid":
      return "Not quoted: the broker's price is finer than the table can size exactly.";
    case "no-two-sided-quote":
      return "No quote.";
    case "timeout":
      return "Not quoted: the broker did not answer in time.";
    case "broker-error":
      return "Not quoted: the broker could not answer.";
  }
}

type QuotesFailure = Extract<OptionQuoteBatchResult, { ok: false }>["reason"];

/** The quotes route's whole-pull refusals (nothing was sent to the broker). */
export function quotesRefusalSentence(reason: QuotesFailure, retryAfterSeconds?: number): string {
  switch (reason) {
    case "not-connected":
      return "Connect the broker to fetch quotes.";
    case "no-underlying-contract":
      return "The broker contract for the underlying is not on file, so the broker cannot be asked.";
    case "sync-running":
      return "A sync is running. Try again in a moment.";
    case "rate-limit":
      return `Too many quotes in a minute. Try again in ${retryAfterSeconds ?? 60} seconds.`;
    case "broker-busy":
      return "The broker was busy with another request. Try again in a moment.";
  }
}

/**
 * Retry-After for a lock-busy pull (503): the seconds the refused pull already
 * waited for the shared quote lock (OPTION_QUOTE_LOCK_WAIT_MS, 20 s). A single
 * quote holds the lock for one contract-details call and one snapshot (well
 * under that); a batch can hold it longer, and a retry then waits its own 20 s
 * in line again, so waiting the same span once more is the honest figure.
 */
export const QUOTE_LOCK_BUSY_RETRY_AFTER_SECONDS = 20;

// ─── The candidates (call 2: P10, P12, D3, D9) ──────────────────────────────

export interface CandidatesBody extends GainsAtRiskBody {
  /** Whole cents, above 0, at most CANDIDATE_BOUNDS.maxBudgetUsd (D9). */
  budgetUsd: number;
  /** One of `moves`. */
  selectedMove: number;
  /** 1 to CANDIDATE_BOUNDS.maxCandidates, in call 1's shape. */
  candidates: CandidateRequestItem[];
}

/** The candidates route's `data`: the compute route's reply for the same body, plus one row per candidate. */
export type CandidatesResponse = GainsAtRiskResponse & { budgetUsd: number; selectedMove: number; rows: CandidateRow[] };

/**
 * Shape only: the gains-at-risk body, the budget (whole cents, D9), the
 * selected move (one of moves) and candidates as a list. The route then runs
 * the server-side `candidatesProblem` (D3, F4) before anything else.
 */
export function candidatesBodyProblem(body: unknown, today: string): string | null {
  const base = gainsAtRiskBodyProblem(body, today);
  if (base) return base;
  const b = body as Record<string, unknown>;
  if (typeof b.budgetUsd !== "number" || budgetToUnits(b.budgetUsd) === null) {
    return `budgetUsd must be whole cents above 0 and at most ${CANDIDATE_BOUNDS.maxBudgetUsd}.`;
  }
  if (b.selectedMove === undefined) return "selectedMove must be one of moves.";
  if (!Array.isArray(b.candidates)) return "candidates must be a list.";
  // Fix round 1: the trading class is bounded here; the server validator checks everything else.
  for (let i = 0; i < b.candidates.length; i++) {
    const c = b.candidates[i];
    if (isPlainObject(c) && c.tradingClass !== undefined && !isTradingClass(c.tradingClass)) {
      return `candidates[${i}].tradingClass must be the contract's trading class (1 to ${TRADING_CLASS_MAX_LENGTH} letters and digits).`;
    }
  }
  return null;
}

/** Candidates that passed `candidatesProblem`, rebuilt from their known fields only. */
export function cleanCandidateItems(list: CandidateRequestItem[]): CandidateRequestItem[] {
  return list.map((c) => ({
    conId: c.conId,
    underlyingSecurityId: c.underlyingSecurityId,
    right: c.right,
    expiry: c.expiry,
    strike: c.strike,
    multiplier: TRIAL_OPTION_MULTIPLIER,
    tradingClass: c.tradingClass,
    quote: {
      bid: c.quote.bid,
      ask: c.quote.ask,
      mid: c.quote.mid,
      tickKind: c.quote.tickKind,
      session: c.quote.session,
      optionObservedAt: c.quote.optionObservedAt,
      underlyingObservedAt: c.quote.underlyingObservedAt,
      underlyingPrice: c.quote.underlyingPrice,
    },
    entry: {
      kind: "option",
      underlyingSecurityId: c.entry.underlyingSecurityId,
      right: c.entry.right,
      side: "buy",
      expiry: c.entry.expiry,
      strike: c.entry.strike,
      contracts: c.entry.contracts,
      pricePaid: c.entry.pricePaid,
      entryUnderlyingPrice: c.entry.entryUnderlyingPrice,
      valuationPriceAtEntry: c.entry.valuationPriceAtEntry,
      entryVolatility: c.entry.entryVolatility,
      brokerContractId: c.entry.brokerContractId,
    },
  }));
}

/** The compute and candidates routes' answer for a driver the server's list does not carry (T20). */
export const DRIVER_NOT_LISTED_SENTENCE = "driver is not one of the names this page can stress.";

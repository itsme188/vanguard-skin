/**
 * Gains at risk, step 3: the call-2 validator (D3, F4).
 *
 * Call 2 (the candidates compute) trusts client-supplied quotes and entries,
 * so it checks them with a validator of its own, never the `trialPositions`
 * check: a bought option only; right put or call; bid and ask finite,
 * positive and on the 1/10,000 grid, bid at or below ask (a locked market is
 * a market; a crossed one is refused); the mid exactly (bid + ask) / 2 in
 * scaled whole numbers; the entry's price paid equal to the mid; the entry's
 * contract fields equal to the candidate's; multiplier 100; and the WHOLE
 * entry inside `TRIAL_POSITION_BOUNDS` (F4), with every scaled product a safe
 * integer. One canonical price sizes the row and drives its P&L. Each failure
 * is one sentence naming the field (`candidates[i].<field>`), for a 400.
 *
 * Server only (F4, plan OPEN 1): it reads the expiry through the option-expiry
 * reader under `lib/compute`. The page reaches its types by type-only import.
 */

import {
  CANDIDATE_BOUNDS,
  CANDIDATE_MAX_OBSERVATION_GAP_SECONDS,
  TRIAL_OPTION_MULTIPLIER,
  TRIAL_POSITION_BOUNDS,
} from "@/lib/analysis/gains-at-risk-constants";
import { toMoneyUnits } from "@/lib/analysis/gains-at-risk-candidate-money";
import { normalizeOptionExpiration } from "./option-expiry";
import { isTrialCalendarDay } from "./gains-at-risk-trial";

export interface CandidateQuoteFields {
  bid: number;
  ask: number;
  mid: number;
  tickKind: "live" | "delayed";
  session: "regular-session" | "market-closed";
  // F5: always the quote's own underlying, at most 30 s from the option.
  optionObservedAt: string;
  underlyingObservedAt: string;
  underlyingPrice: number;
}

export interface CandidateRequestItem {
  conId: number;
  underlyingSecurityId: number;
  right: "put" | "call";
  expiry: string;
  strike: number;
  multiplier: 100;
  tradingClass: string;
  quote: CandidateQuoteFields;
  /** As call 1 returned it (buildTrialEntryById's position), never re-solved. brokerContractId === conId (F3). */
  entry: {
    kind: "option";
    underlyingSecurityId: number;
    right: "put" | "call";
    side: "buy";
    expiry: string;
    strike: number;
    contracts: number;
    pricePaid: number;
    entryUnderlyingPrice: number;
    valuationPriceAtEntry: number;
    entryVolatility: number;
    brokerContractId: number;
  };
}

type Obj = Record<string, unknown>;

const isObject = (x: unknown): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);
const isId = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const isInBounds = (x: unknown, max: number): x is number =>
  typeof x === "number" && Number.isFinite(x) && x > 0 && x <= max;
/** A real calendar day already in dashed form (the option-expiry reader leaves it unchanged). */
const isDashedExpiry = (x: unknown): x is string =>
  typeof x === "string" && normalizeOptionExpiration(x) === x && isTrialCalendarDay(x);
const instant = (x: unknown): number | null => {
  if (typeof x !== "string" || x.trim() === "") return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
};

/** Two prices equal in units of 1/10,000 of a dollar (float noise ignored); off the grid, they must be identical. */
function sameScaledPrice(a: number, b: number): boolean {
  const ua = toMoneyUnits(a);
  const ub = toMoneyUnits(b);
  return ua !== null && ub !== null ? ua === ub : a === b;
}

/** D3 + F4: null, or one sentence naming the field (`candidates[i].<field>`). */
export function candidateItemProblem(item: unknown, index: number): string | null {
  const at = `candidates[${index}]`;
  if (!isObject(item)) return `${at} must be an object.`;
  const B = TRIAL_POSITION_BOUNDS;

  // ─── The contract (D1) ───
  if (!isId(item.conId)) return `${at}.conId must be a positive whole number.`;
  if (!isId(item.underlyingSecurityId)) return `${at}.underlyingSecurityId must be a positive whole number.`;
  if (item.right !== "put" && item.right !== "call") return `${at}.right must be put or call.`;
  if (!isDashedExpiry(item.expiry)) return `${at}.expiry must be a real date written YYYY-MM-DD.`;
  if (!isInBounds(item.strike, B.maxStrike)) return `${at}.strike must be above 0 and at most ${B.maxStrike}.`;
  if (item.multiplier !== TRIAL_OPTION_MULTIPLIER) return `${at}.multiplier must be ${TRIAL_OPTION_MULTIPLIER}.`;
  if (typeof item.tradingClass !== "string" || item.tradingClass.trim() === "") {
    return `${at}.tradingClass must name the contract's trading class.`;
  }

  // ─── The quote (D3, D9) ───
  const q = item.quote;
  if (!isObject(q)) return `${at}.quote must be an object.`;
  if (typeof q.bid !== "number" || !Number.isFinite(q.bid) || !(q.bid > 0)) return `${at}.quote.bid must be a price above 0.`;
  const bidUnits = toMoneyUnits(q.bid);
  if (bidUnits === null) return `${at}.quote.bid is not a whole number of hundredths of a cent.`;
  if (!Number.isSafeInteger(bidUnits)) return `${at}.quote.bid is too large to size exactly.`;
  if (typeof q.ask !== "number" || !Number.isFinite(q.ask) || !(q.ask > 0)) return `${at}.quote.ask must be a price above 0.`;
  const askUnits = toMoneyUnits(q.ask);
  if (askUnits === null) return `${at}.quote.ask is not a whole number of hundredths of a cent.`;
  if (!Number.isSafeInteger(askUnits)) return `${at}.quote.ask is too large to size exactly.`;
  if (bidUnits > askUnits) return `${at}.quote.bid is above the ask (a crossed quote is not a market).`;
  const perContractUnits = (bidUnits + askUnits) * 50;
  if (!Number.isSafeInteger(perContractUnits)) return `${at}.quote.bid and ask are too large to size exactly.`;
  if (!Number.isSafeInteger(perContractUnits * B.maxContracts)) {
    return `${at}.quote.bid and ask are too large to size ${B.maxContracts} contracts exactly.`;
  }
  // The mid on the 1/20,000 grid, equal to bid + ask in units.
  if (typeof q.mid !== "number" || !Number.isFinite(q.mid)) return `${at}.quote.mid must be a number.`;
  const twiceMid = q.mid * 2 * 10_000;
  const twiceMidUnits = Math.round(twiceMid);
  if (Math.abs(twiceMid - twiceMidUnits) > 1e-6 || twiceMidUnits !== bidUnits + askUnits) {
    return `${at}.quote.mid must be exactly halfway between the bid and the ask.`;
  }
  if (q.tickKind !== "live" && q.tickKind !== "delayed") return `${at}.quote.tickKind must be live or delayed.`;
  if (q.session !== "regular-session" && q.session !== "market-closed") {
    return `${at}.quote.session must be regular-session or market-closed.`;
  }
  const optionAt = instant(q.optionObservedAt);
  if (optionAt === null) return `${at}.quote.optionObservedAt must be a time.`;
  const underlyingAt = instant(q.underlyingObservedAt);
  if (underlyingAt === null) return `${at}.quote.underlyingObservedAt must be a time.`;
  // F5 / D6: the underlying is the quote's own, read close to the option.
  if (Math.abs(optionAt - underlyingAt) > CANDIDATE_MAX_OBSERVATION_GAP_SECONDS * 1000) {
    return `${at}.quote.underlyingObservedAt is more than ${CANDIDATE_MAX_OBSERVATION_GAP_SECONDS} seconds from the option quote.`;
  }
  if (!isInBounds(q.underlyingPrice, B.maxPrice)) {
    return `${at}.quote.underlyingPrice must be above 0 and at most ${B.maxPrice}.`;
  }

  // ─── The entry (D3, F4: the whole entry) ───
  const e = item.entry;
  if (!isObject(e)) return `${at}.entry must be an object.`;
  if (e.kind !== "option") return `${at}.entry.kind must be option.`;
  if (e.side !== "buy") return `${at}.entry.side must be buy: the table compares bought options only.`;
  if (e.underlyingSecurityId !== item.underlyingSecurityId) return `${at}.entry.underlyingSecurityId must equal the candidate's.`;
  if (e.right !== item.right) return `${at}.entry.right must equal the candidate's.`;
  if (!isDashedExpiry(e.expiry)) return `${at}.entry.expiry must be a real date written YYYY-MM-DD.`;
  if (e.expiry !== item.expiry) return `${at}.entry.expiry must equal the candidate's.`;
  if (!isInBounds(e.strike, B.maxStrike)) return `${at}.entry.strike must be above 0 and at most ${B.maxStrike}.`;
  if (e.strike !== item.strike) return `${at}.entry.strike must equal the candidate's.`;
  if (e.brokerContractId !== item.conId) return `${at}.entry.brokerContractId must equal the candidate's conId.`;
  if (!(typeof e.contracts === "number" && Number.isSafeInteger(e.contracts) && e.contracts >= 1 && e.contracts <= B.maxContracts)) {
    return `${at}.entry.contracts must be a whole number from 1 to ${B.maxContracts}.`;
  }
  if (!isInBounds(e.pricePaid, B.maxPrice)) return `${at}.entry.pricePaid must be above 0 and at most ${B.maxPrice}.`;
  if (e.pricePaid !== q.mid) return `${at}.entry.pricePaid must equal the quote's mid.`;
  if (!isInBounds(e.entryUnderlyingPrice, B.maxPrice)) {
    return `${at}.entry.entryUnderlyingPrice must be above 0 and at most ${B.maxPrice}.`;
  }
  // F5/P13: the entry was solved at the quote's own underlying; compared in scaled whole units, as the mid is.
  if (!sameScaledPrice(e.entryUnderlyingPrice, q.underlyingPrice as number)) {
    return `${at}.entry.entryUnderlyingPrice must equal the quote's underlying price.`;
  }
  if (!isInBounds(e.valuationPriceAtEntry, B.maxPrice)) {
    return `${at}.entry.valuationPriceAtEntry must be above 0 and at most ${B.maxPrice}.`;
  }
  if (!isInBounds(e.entryVolatility, B.maxVolatility)) {
    return `${at}.entry.entryVolatility must be above 0 and at most ${B.maxVolatility}.`;
  }
  return null;
}

/** The list: 1..maxCandidates, unique conId, each item checked. */
export function candidatesProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return "candidates must be a list.";
  const max = CANDIDATE_BOUNDS.maxCandidates;
  if (value.length === 0) return "candidates must hold at least one candidate.";
  if (value.length > max) return `candidates must hold at most ${max} candidates.`;
  const seen = new Set<number>();
  for (const [i, item] of value.entries()) {
    const problem = candidateItemProblem(item, i);
    if (problem !== null) return problem;
    const conId = (item as CandidateRequestItem).conId;
    if (seen.has(conId)) return `candidates[${i}].conId is a duplicate: each contract may appear once.`;
    seen.add(conId);
  }
  return null;
}

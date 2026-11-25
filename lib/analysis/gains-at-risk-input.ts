/**
 * Gains at risk: the request body's rules (Gains at risk, step 1, Task 5).
 *
 * A plain module (no database or query code at run time) so the page and the route
 * share one set of rules. `gainsAtRiskBodyProblem` answers null for a valid
 * body, or one plain sentence naming the field at fault.
 *
 * Per-row override checks (positive, at least intrinsic, solvable; for an
 * owner's beta figure: a fixed row or the driver itself) are the engine's
 * refusals, listed on the row; this module checks only the shape and bounds.
 */

import { ANALYSIS_SCOPES, type AnalysisScope } from "@/lib/analysis/view-param";
// Import-free bounds module (C12). Never value-import the engine here: it pulls
// a broker SDK through the TWS type map, and this module reaches the browser.
import { BETA_OVERRIDE_BOUNDS, TRIAL_POSITION_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import type { GainsAtRiskResult, TrialPositionInput } from "@/lib/compute/gains-at-risk";
import type { YearGainResult } from "@/lib/compute/year-gain";
// Type only: erased at build, so no query code reaches the client bundle.
import type { PositionsFreshness } from "@/lib/queries/positions-freshness";
// Type only (step 2): the trial entry, the quote, the bar fetch and the session label.
import type {
  TrialEntryRefusal,
  TrialEntryRequest,
  TrialEntryResult,
  TrialSecurityRefusal,
  lookupTrialSecurity,
} from "@/lib/compute/gains-at-risk-trial";
import type { OptionQuoteRefusal, OptionQuoteRequest, OptionQuoteResult } from "@/lib/tws/option-quote";
import type { EnsureDailyBarsResult } from "@/lib/tws/daily-bar-capture";
import type { QuoteSessionLabel } from "@/lib/calendar/market-session";

export const GAINS_AT_RISK_DRIVERS = ["SPY", "QQQ", "VTI"] as const;
export type GainsAtRiskDriver = (typeof GAINS_AT_RISK_DRIVERS)[number];

/**
 * The volatility-change bounds, in points. Plain constants so this module
 * (read by the client view) value-imports no engine code; they equal the
 * repricer's `VOL_MOVE_MIN` / `VOL_MOVE_MAX` (`lib/compute/option-reprice.ts`),
 * pinned by tests/lib/gains-at-risk-view.test.ts.
 */
export const GAINS_AT_RISK_VOL_MIN = -20;
export const GAINS_AT_RISK_VOL_MAX = 60;

export const GAINS_AT_RISK_BOUNDS = { moveAbsMax: 0.6, maxMoves: 41, maxOverrides: 200, maxYearsOut: 2 } as const;

export interface GainsAtRiskBody {
  scope: AnalysisScope;
  driverSymbol: string;
  valuationDate: string;
  moves: number[];
  volChangePoints: number;
  priceOverrides?: Record<string, number>;
  /**
   * The owner's own figure per name (its move per unit of driver move), keyed
   * by the position's `identitySecurityId` (C6). Page state only; never stored.
   */
  betaOverrides?: Record<string, number>;
  /**
   * Step 2: trial positions, fixed at the click by the trial-entry route.
   * Page state only; never stored. At most TRIAL_POSITION_BOUNDS.maxPositions.
   * A retained option whose expiry has passed is accepted here (P11): the
   * engine returns it refused "expired" and every other trial still counts.
   */
  trialPositions?: TrialPositionInput[];
}

export interface GainsAtRiskResponse {
  result: GainsAtRiskResult;
  /** Every account, whatever the stress scope (F14). */
  yearGain: YearGainResult;
  /** Every account (F14). */
  yearGainFreshness: PositionsFreshness;
  /** The stress scope. */
  scopeFreshness: PositionsFreshness;
}

/** A real calendar day in YYYY-MM-DD (2026-02-30 fails); the engine's own test. */
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * The same month and day, maxYearsOut years on. When that day does not exist
 * (today is Feb 29 and the later year is not a leap year) it is Feb 28.
 */
export function latestValuationDate(today: string): string {
  const candidate = `${Number(today.slice(0, 4)) + GAINS_AT_RISK_BOUNDS.maxYearsOut}${today.slice(4)}`;
  return isCalendarDay(candidate) ? candidate : `${candidate.slice(0, 8)}28`;
}

const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

const POSITIVE_INTEGER_KEY = /^[1-9]\d*$/;

/**
 * null when the body is valid; otherwise one plain sentence naming the field.
 * `today` is the Eastern day (`todayET()`), passed in so the rule is testable.
 */
export function gainsAtRiskBodyProblem(body: unknown, today: string): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "The request body must be an object.";
  }
  const b = body as Record<string, unknown>;

  if (typeof b.scope !== "string" || !(ANALYSIS_SCOPES as readonly string[]).includes(b.scope)) {
    return `scope must be one of ${ANALYSIS_SCOPES.join(", ")}.`;
  }

  if (typeof b.driverSymbol !== "string" || !(GAINS_AT_RISK_DRIVERS as readonly string[]).includes(b.driverSymbol)) {
    return `driverSymbol must be one of ${GAINS_AT_RISK_DRIVERS.join(", ")}.`;
  }

  if (typeof b.valuationDate !== "string" || !isCalendarDay(b.valuationDate)) {
    return "valuationDate must be a real day written YYYY-MM-DD.";
  }
  if (b.valuationDate < today) {
    return "valuationDate cannot be before today.";
  }
  const latest = latestValuationDate(today);
  if (b.valuationDate > latest) {
    return `valuationDate cannot be more than ${GAINS_AT_RISK_BOUNDS.maxYearsOut} years from today (latest ${latest}).`;
  }

  const limit = GAINS_AT_RISK_BOUNDS.moveAbsMax;
  if (!Array.isArray(b.moves) || b.moves.length === 0 || b.moves.length > GAINS_AT_RISK_BOUNDS.maxMoves) {
    return `moves must be a list of 1 to ${GAINS_AT_RISK_BOUNDS.maxMoves} numbers.`;
  }
  if (b.moves.some((m) => !isFiniteNumber(m) || Math.abs(m) > limit)) {
    return `moves must each be a number between -${limit} and ${limit}.`;
  }

  if (!isFiniteNumber(b.volChangePoints) || b.volChangePoints < GAINS_AT_RISK_VOL_MIN || b.volChangePoints > GAINS_AT_RISK_VOL_MAX) {
    return `volChangePoints must be a number between ${GAINS_AT_RISK_VOL_MIN} and ${GAINS_AT_RISK_VOL_MAX}.`;
  }

  if (b.priceOverrides !== undefined) {
    const o = b.priceOverrides;
    if (typeof o !== "object" || o === null || Array.isArray(o)) {
      return "priceOverrides must be an object of security id to price.";
    }
    const entries = Object.entries(o as Record<string, unknown>);
    if (entries.length > GAINS_AT_RISK_BOUNDS.maxOverrides) {
      return `priceOverrides can hold at most ${GAINS_AT_RISK_BOUNDS.maxOverrides} entries.`;
    }
    for (const [key, value] of entries) {
      if (!POSITIVE_INTEGER_KEY.test(key)) {
        return "priceOverrides keys must be security ids (positive whole numbers).";
      }
      if (!isFiniteNumber(value)) {
        return "priceOverrides values must be numbers.";
      }
    }
  }

  if (b.betaOverrides !== undefined) {
    const o = b.betaOverrides;
    if (typeof o !== "object" || o === null || Array.isArray(o)) {
      return "betaOverrides must be an object of security id to figure.";
    }
    const entries = Object.entries(o as Record<string, unknown>);
    if (entries.length > BETA_OVERRIDE_BOUNDS.maxEntries) {
      return `betaOverrides can hold at most ${BETA_OVERRIDE_BOUNDS.maxEntries} entries.`;
    }
    for (const [key, value] of entries) {
      if (!POSITIVE_INTEGER_KEY.test(key)) {
        return "betaOverrides keys must be security ids (positive whole numbers).";
      }
      if (!isFiniteNumber(value) || value < BETA_OVERRIDE_BOUNDS.min || value > BETA_OVERRIDE_BOUNDS.max) {
        return `betaOverrides values must each be a number between ${BETA_OVERRIDE_BOUNDS.min} and ${BETA_OVERRIDE_BOUNDS.max}.`;
      }
    }
  }

  if (b.trialPositions !== undefined) {
    const problem = trialPositionsProblem(b.trialPositions);
    if (problem) return problem;
  }

  return null;
}

// ─── Step 2: trial positions and the three form routes (P9, P11) ──────────

const B = TRIAL_POSITION_BOUNDS;

/** A positive safe integer: a security id. */
const isPositiveId = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
/** A whole number from 1 to `max`. */
const isCount = (x: unknown, max: number): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 1 && x <= max;
/** A finite number above 0 and at most `max`. */
const isPositiveUpTo = (x: unknown, max: number): x is number => isFiniteNumber(x) && x > 0 && x <= max;
const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The longest symbol the form may send (trimmed). */
export const TRIAL_SYMBOL_MAX_LENGTH = 32;

/**
 * null when `value` is a valid list of trial positions; else one sentence
 * naming trialPositions. Shape and bounds only: the security itself is
 * checked on the server (checkTrialSecurity). A past expiry is NOT refused
 * here (P11).
 */
function trialPositionsProblem(value: unknown): string | null {
  const F = "trialPositions";
  if (!Array.isArray(value)) return `${F} must be a list.`;
  if (value.length > B.maxPositions) return `${F} can hold at most ${B.maxPositions} positions.`;
  const ids = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const at = `${F}[${i}]`;
    const t = value[i];
    if (!isPlainObject(t)) return `${at} must be an object.`;
    if (typeof t.id !== "string" || t.id.length === 0 || t.id.length > B.idMaxLength) {
      return `${at}.id must be text of 1 to ${B.idMaxLength} characters.`;
    }
    if (ids.has(t.id)) return `${F} has two positions with the id ${JSON.stringify(t.id)}.`;
    ids.add(t.id);
    if (t.kind === "option") {
      if (!isPositiveId(t.underlyingSecurityId)) return `${at}.underlyingSecurityId must be a security id (a positive whole number).`;
      if (t.right !== "put" && t.right !== "call") return `${at}.right must be put or call.`;
      if (t.side !== "buy" && t.side !== "write") return `${at}.side must be buy or write.`;
      if (typeof t.expiry !== "string" || !isCalendarDay(t.expiry)) return `${at}.expiry must be a real day written YYYY-MM-DD.`;
      if (!isPositiveUpTo(t.strike, B.maxStrike)) return `${at}.strike must be a number above 0 and at most ${B.maxStrike}.`;
      if (!isCount(t.contracts, B.maxContracts)) return `${at}.contracts must be a whole number from 1 to ${B.maxContracts}.`;
      if (!isPositiveUpTo(t.pricePaid, B.maxPrice)) return `${at}.pricePaid must be a number above 0 and at most ${B.maxPrice}.`;
      if (!isPositiveUpTo(t.entryUnderlyingPrice, B.maxPrice)) {
        return `${at}.entryUnderlyingPrice must be a number above 0 and at most ${B.maxPrice}.`;
      }
      if (!isPositiveUpTo(t.entryVolatility, B.maxVolatility)) {
        return `${at}.entryVolatility must be a number above 0 and at most ${B.maxVolatility}.`;
      }
      if (!isPositiveUpTo(t.valuationPriceAtEntry, B.maxPrice)) {
        return `${at}.valuationPriceAtEntry must be a number above 0 and at most ${B.maxPrice}.`;
      }
    } else if (t.kind === "shares") {
      if (!isPositiveId(t.securityId)) return `${at}.securityId must be a security id (a positive whole number).`;
      if (t.side !== "buy" && t.side !== "sell") return `${at}.side must be buy or sell.`;
      if (!isCount(t.quantity, B.maxShares)) return `${at}.quantity must be a whole number from 1 to ${B.maxShares}.`;
      if (!isPositiveUpTo(t.price, B.maxPrice)) return `${at}.price must be a number above 0 and at most ${B.maxPrice}.`;
    } else {
      return `${at}.kind must be option or shares.`;
    }
  }
  return null;
}

/**
 * The trial positions of a body that passed `gainsAtRiskBodyProblem`, rebuilt
 * from their known fields only (an unknown key never reaches the engine).
 */
export function cleanTrialPositions(list: TrialPositionInput[]): TrialPositionInput[] {
  return list.map((t) =>
    t.kind === "option"
      ? {
          kind: "option",
          id: t.id,
          underlyingSecurityId: t.underlyingSecurityId,
          right: t.right,
          side: t.side,
          expiry: t.expiry,
          strike: t.strike,
          contracts: t.contracts,
          pricePaid: t.pricePaid,
          entryUnderlyingPrice: t.entryUnderlyingPrice,
          entryVolatility: t.entryVolatility,
          valuationPriceAtEntry: t.valuationPriceAtEntry,
        }
      : { kind: "shares", id: t.id, securityId: t.securityId, side: t.side, quantity: t.quantity, price: t.price },
  );
}

/** The security a trial position is on (the underlying for an option). */
export function trialPositionSecurityId(t: TrialPositionInput): number {
  return t.kind === "option" ? t.underlyingSecurityId : t.securityId;
}

function symbolProblem(value: unknown, field: string): string | null {
  if (typeof value !== "string") return `${field} must be text.`;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > TRIAL_SYMBOL_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return `${field} must be a symbol of 1 to ${TRIAL_SYMBOL_MAX_LENGTH} characters.`;
  }
  return null;
}

/** POST /api/compute/gains-at-risk/trial-entry. */
export type TrialEntryBody = { action: "lookup"; symbol: string } | { action: "entry"; request: TrialEntryRequest };

/** A name the app knows (lookupTrialSecurity), as the lookup action returns it. */
export type TrialLookup = NonNullable<ReturnType<typeof lookupTrialSecurity>>;

/** The trial-entry route's `data` on 200. */
export type TrialEntryResponse =
  | { action: "lookup"; security: TrialLookup }
  | {
      action: "entry";
      /** buildTrialEntry's record, untouched (its own `underlyingPriceSource` says "quote" for a client quote). */
      entry: Extract<TrialEntryResult, { ok: true }>;
      /** Where the underlying price came from, as the server can stand behind it: "client-quote" when the client sent it. */
      underlyingPriceSource: "client-quote" | "book" | "daily-bar" | "stored-price";
      /** The app's own valuation price for the name at the click (trialValuationPrice); null when it has none. */
      appValuation: { price: number; date: string; source: "book" | "daily-bar" | "stored-price" } | null;
    };

/**
 * null when the trial-entry body is valid; else one sentence naming the
 * field. A NEW option entry needs an expiry not before `today` (P11; the
 * entry itself also refuses today after the 16:00 close).
 */
export function trialEntryBodyProblem(body: unknown, today: string): string | null {
  if (!isPlainObject(body)) return "The request body must be an object.";
  if (body.action === "lookup") return symbolProblem(body.symbol, "symbol");
  if (body.action !== "entry") return "action must be lookup or entry.";
  const r = body.request;
  if (!isPlainObject(r)) return "request must be an object.";
  const symbol = symbolProblem(r.symbol, "request.symbol");
  if (symbol) return symbol;
  if (r.kind === "option") {
    if (r.right !== "put" && r.right !== "call") return "request.right must be put or call.";
    if (r.side !== "buy" && r.side !== "write") return "request.side must be buy or write.";
    if (typeof r.expiry !== "string" || !isCalendarDay(r.expiry)) return "request.expiry must be a real day written YYYY-MM-DD.";
    if (r.expiry < today) return "request.expiry cannot be before today.";
    if (!isPositiveUpTo(r.strike, B.maxStrike)) return `request.strike must be a number above 0 and at most ${B.maxStrike}.`;
    if (!isCount(r.contracts, B.maxContracts)) return `request.contracts must be a whole number from 1 to ${B.maxContracts}.`;
    if (!isPositiveUpTo(r.price, B.maxPrice)) return `request.price must be a number above 0 and at most ${B.maxPrice}.`;
    if (r.quotedUnderlyingPrice !== undefined && !isPositiveUpTo(r.quotedUnderlyingPrice, B.maxPrice)) {
      return `request.quotedUnderlyingPrice must be a number above 0 and at most ${B.maxPrice}.`;
    }
    return null;
  }
  if (r.kind === "shares") {
    if (r.side !== "buy" && r.side !== "sell") return "request.side must be buy or sell.";
    if (!isCount(r.quantity, B.maxShares)) return `request.quantity must be a whole number from 1 to ${B.maxShares}.`;
    if (!isPositiveUpTo(r.price, B.maxPrice)) return `request.price must be a number above 0 and at most ${B.maxPrice}.`;
    return null;
  }
  return "request.kind must be option or shares.";
}

/** A trial-entry body that passed `trialEntryBodyProblem`, rebuilt from its known fields only. */
export function cleanTrialEntryBody(body: TrialEntryBody): TrialEntryBody {
  if (body.action === "lookup") return { action: "lookup", symbol: body.symbol };
  const r = body.request;
  return {
    action: "entry",
    request:
      r.kind === "option"
        ? {
            kind: "option",
            symbol: r.symbol,
            right: r.right,
            side: r.side,
            expiry: r.expiry,
            strike: r.strike,
            contracts: r.contracts,
            price: r.price,
            ...(r.quotedUnderlyingPrice !== undefined ? { quotedUnderlyingPrice: r.quotedUnderlyingPrice } : {}),
          }
        : { kind: "shares", symbol: r.symbol, side: r.side, quantity: r.quantity, price: r.price },
  };
}

/**
 * POST /api/tws/option-quote: the body is an OptionQuoteRequest. With `today`
 * (the route passes `todayET()`), an expiry before today is refused too, so
 * no broker request is spent on a contract that cannot trade.
 */
export function optionQuoteBodyProblem(body: unknown, today?: string): string | null {
  if (!isPlainObject(body)) return "The request body must be an object.";
  if (!isPositiveId(body.underlyingSecurityId)) return "underlyingSecurityId must be a security id (a positive whole number).";
  if (body.right !== "put" && body.right !== "call") return "right must be put or call.";
  if (typeof body.expiry !== "string" || !isCalendarDay(body.expiry)) return "expiry must be a real day written YYYY-MM-DD.";
  if (today !== undefined && body.expiry < today) return "expiry cannot be before today.";
  if (!isPositiveUpTo(body.strike, B.maxStrike)) return `strike must be a number above 0 and at most ${B.maxStrike}.`;
  return null;
}

/** The option-quote route's `data` on 200: the request echoed (P6), the quote, and the session at the click. */
export interface OptionQuoteResponse {
  request: OptionQuoteRequest;
  quote: OptionQuoteResult;
  session: QuoteSessionLabel;
}

/** POST /api/tws/daily-bars/ensure: body { securityId }. */
export function ensureBarsBodyProblem(body: unknown): string | null {
  if (!isPlainObject(body)) return "The request body must be an object.";
  if (!isPositiveId(body.securityId)) return "securityId must be a security id (a positive whole number).";
  return null;
}

/** The ensure route's `data` on 200 (the security id echoed, P6). */
export interface EnsureBarsResponse {
  securityId: number;
  result: Extract<EnsureDailyBarsResult, { ok: true }>;
}

// ─── Sentences (shared by the routes and the page) ─────────────────────────

/** R10, and the server's check of a security (P9). */
export function trialSecurityRefusalSentence(reason: TrialSecurityRefusal, symbol: string | null): string {
  const name = symbol ?? "That security";
  switch (reason) {
    case "not-found":
      return symbol ? `The app does not know ${symbol} yet. Add it to the watchlist first.` : "The app does not know that security.";
    case "is-an-option":
      return `${name} is an option. Enter its underlying instead.`;
    case "foreign-currency":
      return `${name} is not priced in US dollars. Trial positions are US-dollar only.`;
    case "no-contract-id":
      return `The broker contract for ${symbol ?? "that security"} is not on file, so the broker cannot be asked about it.`;
  }
}

/** The entry's refusals (422). */
export function trialEntryRefusalSentence(reason: TrialEntryRefusal, symbol: string): string {
  switch (reason) {
    case "unknown-symbol":
      return `The app does not know ${symbol} yet. Add it to the watchlist first.`;
    case "is-an-option":
      return trialSecurityRefusalSentence("is-an-option", symbol);
    case "foreign-currency":
      return trialSecurityRefusalSentence("foreign-currency", symbol);
    case "no-underlying-price":
      return `${symbol} is not a security the app holds a price for.`;
    case "below-intrinsic":
      return "That price is below what the option is worth if exercised now. Check the price.";
    case "not-solvable":
      return "No volatility explains that price. Check the price.";
    case "expired":
      return "That contract has expired or stops trading today. Choose a later expiry.";
    case "no-option-terms":
      return "The contract's terms are not complete. Check the expiry, strike and price.";
  }
}

/** The quote's refusals, for the page (the route answers them with 200, except not-connected). */
export function optionQuoteRefusalSentence(reason: OptionQuoteRefusal): string {
  switch (reason) {
    case "not-connected":
      return "Connect the broker to fetch quotes.";
    case "no-underlying-contract":
      return "The broker contract for the underlying is not on file, so the broker cannot be asked.";
    case "no-contract":
      return "The broker does not list that contract. Check the expiry and strike.";
    case "ambiguous-contract":
      return "The broker lists more than one contract with those terms. Type the price.";
    case "no-two-sided-quote":
      return "No quote. Type the price.";
    case "timeout":
      return "The broker did not answer in time. Try again, or type the price.";
    case "broker-error":
      return "The broker could not answer. Try again, or type the price.";
  }
}

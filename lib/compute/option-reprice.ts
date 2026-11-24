/**
 * Option repricing under a scenario shock — the ONE option treatment both
 * scenario engines share (spec: docs/superpowers/specs/
 * 2026-10-06-scenario-option-repricing-design.md).
 *
 * Replaces the linear elasticity estimate (Ω = Δ·S/V, capped at 8), which
 * drew a large move as a straight line and understated a short put's loss
 * several times over. An option is repriced with Black-Scholes at the shocked
 * underlying price; nothing here is a guessed figure — an option that cannot
 * be priced is reported as unmodelled.
 */

import { callPrice, putPrice, impliedVolatility, yearsToExpiry, isExpiredAsOf } from "./options-greeks";
import { normalizeExpirationDate, isOptionSecurityType, type OptionElasticityInputs } from "./option-elasticity";
import { daysToExpiry } from "./option-expiry";
import { todayET } from "@/lib/calendar/date-utils";

export type OptionIvSource = "own-price" | "broker-underlying";
/** Where v0 comes from: the option's own quote, or the model (no quote of its own). */
export type OptionPriceSource = "own-price" | "model";

export type OptionUnmodelledReason =
  | "no-option-terms"
  | "expired"
  | "no-option-price"
  | "no-underlying-price"
  | "no-volatility";

/** Shocked volatility never goes to or below zero (the formula divides by it). */
export const MIN_SHOCKED_VOL = 0.01;
/** Range of the custom scenario's volatility slider, in points (spec §6). */
export const VOL_MOVE_MIN = -20;
export const VOL_MOVE_MAX = 60;

export interface OptionRepriceShock {
  /** The UNDERLYING's scenario move, e.g. -0.2. Floored at -100% here. */
  underlyingMove: number;
  /** Volatility change as a decimal (15 points = 0.15). Absent or non-finite = 0. */
  volChange?: number;
  riskFreeRate: number;
  /** Injected for tests; default the ET calendar date / the wall clock. */
  today?: string;
  now?: Date;
  /**
   * YYYY-MM-DD, not before `today`. Today means the current instant; a later
   * day means that day's close. Passing it (or `modelWhenUnpriced`) adds
   * `priceSource` and the expiry flags to a modelled result.
   */
  valuationDate?: string;
  /** With no own price: value both legs from the model at the broker's underlying IV. */
  modelWhenUnpriced?: boolean;
}

export type OptionRepriceResult =
  | {
      modelled: true;
      /** Model value today, per share. Equals the market price on the own-price source. */
      v0: number;
      /** Model value at the shocked underlying and shocked volatility (at the valuation date when one is passed), per share. */
      v1: number;
      /**
       * v1 - v0, per share. Describes `v1` only, never `v1IfMoveFirst`.
       * On a `priceSource: "model"` row, an override row or an
       * `expiresBeforeDate` row the caller computes dollars as
       * perShareChange x quantity x multiplier x FX.
       */
      perShareChange: number;
      /**
       * For an own-priced row only: perShareChange / own price, floored at
       * -100%; multiply by market value for dollars. On a
       * `priceSource: "model"` row do NOT multiply it by market value: the
       * market value is zero there, and when v0 is 0 this is 0 while
       * perShareChange is not. Like perShareChange it describes `v1` only;
       * for `expiresBeforeDate` the caller computes both cases itself.
       */
      changePercent: number;
      sigma: number;
      sigmaShocked: number;
      ivSource: OptionIvSource;
      /** Present ONLY when `valuationDate` or `modelWhenUnpriced` was passed. */
      priceSource?: OptionPriceSource;
      /** The contract expires before the valuation date; v1 is its exercise value at today's underlying price. */
      expiresBeforeDate?: true;
      /**
       * With `expiresBeforeDate`: exercise value at the MOVED price, per share
       * (the move lands before expiry). Not reflected in perShareChange or
       * changePercent; the caller computes this case's change itself.
       */
      v1IfMoveFirst?: number;
    }
  | { modelled: false; reason: OptionUnmodelledReason };

/** A real calendar day in YYYY-MM-DD (round-trips, so 2026-06-31 and 2026-02-30 fail). */
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function intrinsic(type: "CALL" | "PUT", S: number, K: number): number {
  return type === "CALL" ? Math.max(S - K, 0) : Math.max(K - S, 0);
}

/** Black-Scholes value floored at exercise value (the early-exercise treatment). */
function modelValue(type: "CALL" | "PUT", S: number, K: number, T: number, r: number, sigma: number): number {
  const floor = intrinsic(type, S, K);
  if (S <= 0) return floor;
  const bs = type === "CALL" ? callPrice(S, K, T, r, sigma) : putPrice(S, K, T, r, sigma);
  return Number.isFinite(bs) ? Math.max(bs, floor) : floor;
}

/**
 * The shocked value v1 at the valuation date. `daysLeft` null = the current
 * instant (T1 = T0). Later dates are valued at that day's close:
 *   - days left > 0: the model at the moved price and shocked vol, T1 = days / 365;
 *   - expires on the date: exercise value at the moved price;
 *   - expired before the date: exercise value at TODAY's price, flagged, with
 *     the moved-price exercise value alongside (the caller picks the worse case).
 */
function valueAtDate(
  type: "CALL" | "PUT",
  S: number,
  K: number,
  T0: number,
  r: number,
  sigma: number,
  sigmaShocked: number,
  move: number,
  daysLeft: number | null,
  v0: number,
): { v1: number; flags: { expiresBeforeDate?: true; v1IfMoveFirst?: number } } {
  const movedS = S * (1 + move);
  if (daysLeft == null) {
    // No move and no volatility change is the same calculation twice; return it
    // as an exact zero rather than a floating-point near-zero.
    const v1 = move === 0 && sigmaShocked === sigma ? v0 : modelValue(type, movedS, K, T0, r, sigmaShocked);
    return { v1, flags: {} };
  }
  if (daysLeft > 0) return { v1: modelValue(type, movedS, K, daysLeft / 365, r, sigmaShocked), flags: {} };
  if (daysLeft === 0) return { v1: intrinsic(type, movedS, K), flags: {} };
  return { v1: intrinsic(type, S, K), flags: { expiresBeforeDate: true, v1IfMoveFirst: intrinsic(type, movedS, K) } };
}

export function repriceOptionUnderShock(pos: OptionElasticityInputs, shock: OptionRepriceShock): OptionRepriceResult {
  const rawType = (pos.option_type ?? "").trim().toUpperCase();
  const type = rawType.startsWith("P") ? "PUT" : rawType.startsWith("C") ? "CALL" : null;
  const K = pos.strike_price;
  const expiry = pos.expiration_date ? normalizeExpirationDate(pos.expiration_date) : null;
  if (!type || K == null || !(K > 0) || !expiry) return { modelled: false, reason: "no-option-terms" };

  const today = shock.today ?? todayET();
  const now = shock.now ?? new Date();
  const timeAware = shock.valuationDate !== undefined || shock.modelWhenUnpriced === true;
  if (shock.valuationDate !== undefined && !isCalendarDay(shock.valuationDate)) {
    throw new Error("valuationDate is not a valid date");
  }
  const valuationDate = shock.valuationDate ?? today;
  if (valuationDate < today) throw new Error("valuationDate is before today");
  if (isExpiredAsOf(expiry, today, now)) return { modelled: false, reason: "expired" };

  const V = pos.own_price;
  const hasOwnPrice = V != null && V > 0;
  if (!hasOwnPrice && shock.modelWhenUnpriced !== true) return { modelled: false, reason: "no-option-price" };
  const S = pos.underlying_price;
  if (S == null || !(S > 0)) return { modelled: false, reason: "no-underlying-price" };

  const T = yearsToExpiry(expiry, today, now);
  const r = shock.riskFreeRate;

  // Days from the valuation date to expiry; null means "value at the current
  // instant" (no date passed, or the date is today), so T1 = T0.
  const daysLeft = valuationDate === today ? null : daysToExpiry(expiry, valuationDate);
  // Second guard: a day count that is missing or not finite (NaN would fall
  // into the "expires before the date" branch) is never valued.
  if (valuationDate !== today && (daysLeft == null || !Number.isFinite(daysLeft))) {
    return { modelled: false, reason: "no-option-terms" };
  }

  const move = Math.max(Number.isFinite(shock.underlyingMove) ? shock.underlyingMove : 0, -1);
  const volChange = typeof shock.volChange === "number" && Number.isFinite(shock.volChange) ? shock.volChange : 0;
  const brokerIv =
    pos.underlying_iv != null && Number.isFinite(pos.underlying_iv) && pos.underlying_iv > 0 ? pos.underlying_iv : null;

  if (!hasOwnPrice) {
    // No quote of its own: both legs come from the model at the broker's
    // underlying IV. Never a default volatility.
    if (brokerIv == null) return { modelled: false, reason: "no-volatility" };
    const sigma = brokerIv;
    const sigmaShocked = Math.max(sigma + volChange, MIN_SHOCKED_VOL);
    const v0 = modelValue(type, S, K, T, r, sigma);
    const later = valueAtDate(type, S, K, T, r, sigma, sigmaShocked, move, daysLeft, v0);
    if (!Number.isFinite(v0) || !Number.isFinite(later.v1)) return { modelled: false, reason: "no-volatility" };
    const perShareChange = later.v1 - v0;
    return {
      modelled: true,
      v0,
      v1: later.v1,
      perShareChange,
      changePercent: v0 > 0 ? Math.max(-1, perShareChange / v0) : 0,
      sigma,
      sigmaShocked,
      ivSource: "broker-underlying",
      priceSource: "model",
      ...later.flags,
    };
  }

  let sigma: number;
  let ivSource: OptionIvSource;
  const solved = impliedVolatility(V, S, K, T, r, type);
  // A quote below exercise value is stale: these contracts are American, so
  // no volatility explains it, even where the European formula still solves
  // (a put between the discounted bound and K - S). Reject it outright, and
  // round-trip everything else so a solver returning its lower bound instead
  // of null is never trusted.
  const reprices =
    V >= intrinsic(type, S, K) &&
    solved != null &&
    Number.isFinite(solved) &&
    solved > 0 &&
    Math.abs((type === "CALL" ? callPrice(S, K, T, r, solved) : putPrice(S, K, T, r, solved)) - V) <= Math.max(0.01, 0.01 * V);
  if (solved != null && reprices) {
    sigma = solved;
    ivSource = "own-price";
  } else if (brokerIv != null) {
    sigma = brokerIv;
    ivSource = "broker-underlying";
  } else {
    return { modelled: false, reason: "no-volatility" };
  }

  const sigmaShocked = Math.max(sigma + volChange, MIN_SHOCKED_VOL);

  const v0 = modelValue(type, S, K, T, r, sigma);
  const later = valueAtDate(type, S, K, T, r, sigma, sigmaShocked, move, daysLeft, v0);
  const v1 = later.v1;
  if (!Number.isFinite(v0) || !Number.isFinite(v1)) return { modelled: false, reason: "no-volatility" };

  const perShareChange = v1 - v0;
  const legacy: OptionRepriceResult & { modelled: true } = {
    modelled: true,
    v0,
    v1,
    perShareChange,
    // On the broker-underlying source a stale quote can sit below the model
    // value today, so the model change can exceed the quoted price. The change
    // is floored at -100% of the QUOTED value so a long option's estimated
    // value never goes negative and a short's never turns positive; the cost
    // is that such a row caps its gain or loss at the shown position value.
    changePercent: Math.max(-1, perShareChange / V),
    sigma,
    sigmaShocked,
    ivSource,
  };
  // Without the new options the result is exactly the legacy object (pinned
  // in tests/fixtures/option-reprice-legacy-pin.json).
  return timeAware ? { ...legacy, priceSource: "own-price", ...later.flags } : legacy;
}

/**
 * How many option rows a scenario left unmodelled, and their share of the
 * absolute option value. A contract with no price of its own has zero value,
 * so it adds to the count and not to the share; `unpricedCount` says how
 * many of the left-out rows are of that kind, so a 0% share is not read as
 * "immaterial" when the value is simply unknown.
 */
export function summarizeUnmodelledOptions(
  rows: Array<{ securityType: string; currentValue: number; unmodelledReason?: OptionUnmodelledReason }>,
): { count: number; valueShare: number; unpricedCount: number } {
  let count = 0;
  let unpricedCount = 0;
  let unmodelledValue = 0;
  let optionValue = 0;
  for (const row of rows) {
    if (!isOptionSecurityType(row.securityType)) continue;
    const value = Math.abs(row.currentValue);
    optionValue += value;
    if (row.unmodelledReason) {
      count += 1;
      if (row.unmodelledReason === "no-option-price") unpricedCount += 1;
      unmodelledValue += value;
    }
  }
  return { count, valueShare: optionValue > 0 ? unmodelledValue / optionValue : 0, unpricedCount };
}

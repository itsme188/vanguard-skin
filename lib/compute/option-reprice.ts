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
import { todayET } from "@/lib/calendar/date-utils";

export type OptionIvSource = "own-price" | "broker-underlying";

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
}

export type OptionRepriceResult =
  | {
      modelled: true;
      /** Model value today, per share. Equals the market price on the own-price source. */
      v0: number;
      /** Model value at the shocked underlying and shocked volatility, per share. */
      v1: number;
      perShareChange: number;
      /** perShareChange / own price, floored at -100%. Multiply by market value for dollars. */
      changePercent: number;
      sigma: number;
      sigmaShocked: number;
      ivSource: OptionIvSource;
    }
  | { modelled: false; reason: OptionUnmodelledReason };

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

export function repriceOptionUnderShock(pos: OptionElasticityInputs, shock: OptionRepriceShock): OptionRepriceResult {
  const rawType = (pos.option_type ?? "").trim().toUpperCase();
  const type = rawType.startsWith("P") ? "PUT" : rawType.startsWith("C") ? "CALL" : null;
  const K = pos.strike_price;
  const expiry = pos.expiration_date ? normalizeExpirationDate(pos.expiration_date) : null;
  if (!type || K == null || !(K > 0) || !expiry) return { modelled: false, reason: "no-option-terms" };

  const today = shock.today ?? todayET();
  const now = shock.now ?? new Date();
  if (isExpiredAsOf(expiry, today, now)) return { modelled: false, reason: "expired" };

  const V = pos.own_price;
  if (V == null || !(V > 0)) return { modelled: false, reason: "no-option-price" };
  const S = pos.underlying_price;
  if (S == null || !(S > 0)) return { modelled: false, reason: "no-underlying-price" };

  const T = yearsToExpiry(expiry, today, now);
  const r = shock.riskFreeRate;

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
  } else if (pos.underlying_iv != null && Number.isFinite(pos.underlying_iv) && pos.underlying_iv > 0) {
    sigma = pos.underlying_iv;
    ivSource = "broker-underlying";
  } else {
    return { modelled: false, reason: "no-volatility" };
  }

  const move = Math.max(Number.isFinite(shock.underlyingMove) ? shock.underlyingMove : 0, -1);
  const volChange = typeof shock.volChange === "number" && Number.isFinite(shock.volChange) ? shock.volChange : 0;
  const sigmaShocked = Math.max(sigma + volChange, MIN_SHOCKED_VOL);

  const v0 = modelValue(type, S, K, T, r, sigma);
  // No move and no volatility change is the same calculation twice; return it
  // as an exact zero rather than a floating-point near-zero.
  const v1 = move === 0 && sigmaShocked === sigma ? v0 : modelValue(type, S * (1 + move), K, T, r, sigmaShocked);
  if (!Number.isFinite(v0) || !Number.isFinite(v1)) return { modelled: false, reason: "no-volatility" };

  const perShareChange = v1 - v0;
  return {
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
}

/**
 * How many option rows a scenario left unmodelled, and their share of the
 * absolute option value. A contract with no price of its own has zero value,
 * so it adds to the count and not to the share.
 */
export function summarizeUnmodelledOptions(
  rows: Array<{ securityType: string; currentValue: number; unmodelledReason?: OptionUnmodelledReason }>,
): { count: number; valueShare: number } {
  let count = 0;
  let unmodelledValue = 0;
  let optionValue = 0;
  for (const row of rows) {
    if (!isOptionSecurityType(row.securityType)) continue;
    const value = Math.abs(row.currentValue);
    optionValue += value;
    if (row.unmodelledReason) {
      count += 1;
      unmodelledValue += value;
    }
  }
  return { count, valueShare: optionValue > 0 ? unmodelledValue / optionValue : 0 };
}

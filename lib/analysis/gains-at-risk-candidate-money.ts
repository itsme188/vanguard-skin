/**
 * Gains at risk, step 3 (D9): candidate money in exact whole units.
 *
 * One unit is 1/10,000 of a dollar (`MONEY_UNITS_PER_DOLLAR`): fine enough
 * for a cent and for half a tick x 100 (a mid of 0.015 is 150 units per
 * share, 15,000 per contract). Sizing, cost and unspent are whole-number
 * arithmetic, never a floating floor: a budget that buys exactly N contracts
 * buys N, and cost + unspent = budget exactly.
 *
 * IMPORT-FREE except the constants module: the page and the route's input
 * check read it without pulling server code into the browser build.
 */

import { CANDIDATE_BOUNDS, MONEY_UNITS_PER_DOLLAR, TRIAL_POSITION_BOUNDS } from "./gains-at-risk-constants";

/** How far a scaled figure may sit from a whole number and still be read as that number (float noise only). */
const GRID_TOLERANCE = 1e-6;

/** Exact units of 1/10,000 of a dollar, or null when not finite, negative, or off the grid (|x*10_000 - round| > 1e-6). */
export function toMoneyUnits(x: number): number | null {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0) return null;
  const scaled = x * MONEY_UNITS_PER_DOLLAR;
  const whole = Math.round(scaled);
  if (Math.abs(scaled - whole) > GRID_TOLERANCE) return null;
  return whole;
}

/** Whole cents only, above 0, at most maxBudgetUsd; else null. */
export function budgetToUnits(budgetUsd: number): number | null {
  if (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd)) return null;
  if (!(budgetUsd > 0) || budgetUsd > CANDIDATE_BOUNDS.maxBudgetUsd) return null;
  const cents = budgetUsd * 100;
  const wholeCents = Math.round(cents);
  if (Math.abs(cents - wholeCents) > GRID_TOLERANCE) return null;
  return wholeCents * (MONEY_UNITS_PER_DOLLAR / 100);
}

export interface CandidateSizing {
  /** (bidUnits + askUnits) x 50: the mid x 100 shares, in units. */
  perContractUnits: number;
  /** min(floor(budget / perContract), maxContracts), by whole-number division. */
  contracts: number;
  /** The floor exceeded maxContracts. */
  capped: boolean;
  /** contracts x perContractUnits. */
  costUnits: number;
  /** budgetUnits - costUnits. */
  unspentUnits: number;
}

function isWholeUnits(x: number): boolean {
  return Number.isSafeInteger(x) && x >= 0;
}

/**
 * D9 sizing. Every input is whole units; the per-contract price is exact
 * ((bid + ask) / 2 x 100 x 10,000 = (bid + ask) x 50 units); contracts is
 * whole-number division (BigInt, so no rounding can buy one too many or one
 * too few). Throws RangeError on an input that is not safe whole units, a
 * zero per-contract price, or a product past the safe-integer range.
 */
export function sizeCandidate(
  budgetUnits: number,
  bidUnits: number,
  askUnits: number,
  maxContracts: number = TRIAL_POSITION_BOUNDS.maxContracts,
): CandidateSizing {
  if (![budgetUnits, bidUnits, askUnits, maxContracts].every(isWholeUnits)) {
    throw new RangeError("sizeCandidate takes safe whole units");
  }
  const perContractUnits = (bidUnits + askUnits) * 50;
  if (!Number.isSafeInteger(perContractUnits) || perContractUnits <= 0) {
    throw new RangeError("the per-contract price must be a positive safe whole number of units");
  }
  const affordable = Number(BigInt(budgetUnits) / BigInt(perContractUnits));
  const capped = affordable > maxContracts;
  const contracts = capped ? maxContracts : affordable;
  const costUnits = contracts * perContractUnits;
  if (!Number.isSafeInteger(costUnits)) throw new RangeError("the cost is past the safe-integer range");
  return { perContractUnits, contracts, capped, costUnits, unspentUnits: budgetUnits - costUnits };
}

/** Display and the engine's dollars: units / 10_000. */
export function unitsToUsd(units: number): number {
  return units / MONEY_UNITS_PER_DOLLAR;
}

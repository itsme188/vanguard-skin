/**
 * Gains at risk: the request body's rules (Gains at risk, step 1, Task 5).
 *
 * A plain module (no database or query code at run time) so the page and the route
 * share one set of rules. `gainsAtRiskBodyProblem` answers null for a valid
 * body, or one plain sentence naming the field at fault.
 *
 * Per-row override checks (positive, at least intrinsic, solvable) are the
 * engine's refusals, listed on the row; this module checks only the shape.
 */

import { ANALYSIS_SCOPES, type AnalysisScope } from "@/lib/analysis/view-param";
import { VOL_MOVE_MIN, VOL_MOVE_MAX } from "@/lib/compute/option-reprice";
import type { GainsAtRiskResult } from "@/lib/compute/gains-at-risk";
import type { YearGainResult } from "@/lib/compute/year-gain";
// Type only: erased at build, so no query code reaches the client bundle.
import type { PositionsFreshness } from "@/lib/queries/positions-freshness";

export const GAINS_AT_RISK_DRIVERS = ["SPY", "QQQ", "VTI"] as const;
export type GainsAtRiskDriver = (typeof GAINS_AT_RISK_DRIVERS)[number];

export const GAINS_AT_RISK_BOUNDS = { moveAbsMax: 0.6, maxMoves: 41, maxOverrides: 200, maxYearsOut: 2 } as const;

export interface GainsAtRiskBody {
  scope: AnalysisScope;
  driverSymbol: string;
  valuationDate: string;
  moves: number[];
  volChangePoints: number;
  priceOverrides?: Record<string, number>;
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

  if (!isFiniteNumber(b.volChangePoints) || b.volChangePoints < VOL_MOVE_MIN || b.volChangePoints > VOL_MOVE_MAX) {
    return `volChangePoints must be a number between ${VOL_MOVE_MIN} and ${VOL_MOVE_MAX}.`;
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

  return null;
}

/**
 * Bounds on the custom what-if scenario inputs (owner ruling 2026-10-07/08,
 * QA option 1). One definition read by POST /api/compute/scenarios (which
 * refuses with 400) and by the custom form (which mirrors them as input
 * min/max and names a problem before sending). Nothing is clamped.
 *
 * Units: marketMove and sectorMove are decimal fractions (0.5 = 50%);
 * rateMoveBp is basis points, the unit the route receives.
 */
export const SCENARIO_INPUT_BOUNDS = {
  marketMove: 0.5,
  rateMoveBp: 1000,
  sectorMove: 0.5,
} as const;

/** Decimal fraction as a whole-number percent, e.g. 0.5 -> 50. */
export function fractionToPercent(fraction: number): number {
  return Math.round(fraction * 100);
}

/**
 * Check the rate and sector inputs of a custom scenario body. Returns a
 * plain-language problem, or null when the inputs are acceptable. The market
 * move and vol move are checked by the route itself.
 */
export function customScenarioBodyProblem(input: {
  rateMove?: unknown;
  sectorMoves?: unknown;
}): string | null {
  const { rateMove, sectorMoves } = input;
  const rateLimit = SCENARIO_INPUT_BOUNDS.rateMoveBp;
  if (rateMove != null) {
    if (typeof rateMove !== "number" || !Number.isFinite(rateMove)) {
      return "rateMove must be a finite number (basis points)";
    }
    if (Math.abs(rateMove) > rateLimit) {
      return `rateMove must be between -${rateLimit} and ${rateLimit} basis points`;
    }
  }
  if (sectorMoves != null) {
    if (typeof sectorMoves !== "object" || Array.isArray(sectorMoves)) {
      return "sectorMoves must be an object of sector name to a number (for example 0.10 for +10%)";
    }
    const limit = SCENARIO_INPUT_BOUNDS.sectorMove.toFixed(2);
    for (const [sector, move] of Object.entries(sectorMoves as Record<string, unknown>)) {
      if (typeof move !== "number" || !Number.isFinite(move)) {
        return `sectorMoves value for ${sector} must be a finite number (for example 0.10 for +10%)`;
      }
      if (Math.abs(move) > SCENARIO_INPUT_BOUNDS.sectorMove) {
        return `sectorMoves value for ${sector} must be between -${limit} and ${limit}`;
      }
    }
  }
  return null;
}

import { parseLargeUSD } from "@/lib/format";

/**
 * Parses the two "actual" text inputs on the BogeysEditModal (Actual EPS /
 * Actual revenue) and classifies the result.
 *
 * Both fields feed through parseLargeUSD, so "not a number" and "blank" both
 * come out as `null` numerically — but they are different user situations
 * and need different error copy. Collapsing them into one "provide at least
 * one actual value" message tells a user who typed `not-a-number` into EPS
 * to supply a value they can already see on screen (finding
 * today-bogeys-actuals--nonnumeric-eps-wrong-error-message, 2026-08-19).
 * This resolver checks each non-blank field for a parse failure BEFORE
 * falling back to the both-blank case.
 */
export interface ActualsInputResult {
  eps_actual: number | null;
  revenue_actual_usd: number | null;
  error: string | null;
}

export function parseActualsInput(epsRaw: string, revenueRaw: string): ActualsInputResult {
  const epsTrimmed = epsRaw.trim();
  const revenueTrimmed = revenueRaw.trim();
  const eps_actual = epsTrimmed ? parseLargeUSD(epsTrimmed) : null;
  const revenue_actual_usd = revenueTrimmed ? parseLargeUSD(revenueTrimmed) : null;

  if (epsTrimmed && eps_actual == null) {
    return { eps_actual, revenue_actual_usd, error: "EPS must be a number." };
  }
  if (revenueTrimmed && revenue_actual_usd == null) {
    return {
      eps_actual,
      revenue_actual_usd,
      error: "Revenue must be a number (e.g. 1.3B or 1300000000).",
    };
  }
  if (eps_actual == null && revenue_actual_usd == null) {
    return {
      eps_actual,
      revenue_actual_usd,
      error: "Provide at least one actual value (EPS or revenue).",
    };
  }
  return { eps_actual, revenue_actual_usd, error: null };
}

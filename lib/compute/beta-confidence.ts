/**
 * beta-confidence.ts — the publish gate for cached OLS betas.
 *
 * qa: today-significant-moves--negative-noise-betas-published-as-fact
 *
 * `scripts/refresh-vanguard-betas.ts` regresses 60 days of daily log returns
 * against SPY and caches the slope in `security_betas`. Significant Moves (and
 * the Worker mirror, which reads the same rows out of the R2 snapshot) then
 * renders that slope as FACT — a "Direction flipped" badge, a beta-implied
 * expected move.
 *
 * The problem is not the slope, it is the missing significance test. Over a
 * 60-day window a single name's idiosyncratic variance routinely swamps the
 * market factor: on the live DB (2026-08-28) the median r² across 67 computed
 * securities was 0.053, and 21 of them came out NEGATIVE — including XLE and
 * XLV, whose own daily series correlate 0.97+ with their sector siblings, i.e.
 * the data is fine and the regression simply has no explanatory power. A
 * true-β≈1 name cached at β<0 mints a false "direction flipped" badge.
 *
 * So a beta only publishes when the regression can carry the claim:
 *   - r² ≥ 0.10  — the market explains at least a tenth of the name's variance
 *   - n  ≥ 30    — enough aligned return pairs for the slope to mean anything
 *
 * Failing either gate DELETES the cached row rather than storing a marker:
 * `security_betas.beta` is NOT NULL, and every consumer (e.g. the LEFT JOIN in
 * `lib/digest/anomalies.ts`) already treats a missing row as "no beta".
 */

/** Minimum coefficient of determination for a beta to publish. */
export const MIN_BETA_R_SQUARED = 0.1;

/** Minimum aligned return pairs for a beta to publish. */
export const MIN_BETA_PAIRS = 30;

export type BetaConfidenceReason = "low_r2" | "few_pairs";

export interface BetaConfidenceInput {
  /** corr(stock, benchmark)² on the aligned log returns. */
  rSquared: number;
  /** Number of aligned return pairs the regression actually used. */
  pairs: number;
}

export interface BetaConfidenceResult {
  ok: boolean;
  reason?: BetaConfidenceReason;
}

/**
 * Decide whether a computed beta is trustworthy enough to publish.
 *
 * Both thresholds are INCLUSIVE (r² of exactly 0.10 and n of exactly 30 pass).
 * When both gates fail the reason is `few_pairs`: with too small a sample the
 * r² itself is not meaningful, so sample size is the deeper defect to report.
 * A non-finite r² (a zero-variance series) is treated as `low_r2` — fail
 * closed, never publish a slope we cannot score.
 */
export function betaConfidenceVerdict({
  rSquared,
  pairs,
}: BetaConfidenceInput): BetaConfidenceResult {
  if (!Number.isFinite(pairs) || pairs < MIN_BETA_PAIRS) {
    return { ok: false, reason: "few_pairs" };
  }
  if (!Number.isFinite(rSquared) || rSquared < MIN_BETA_R_SQUARED) {
    return { ok: false, reason: "low_r2" };
  }
  return { ok: true };
}

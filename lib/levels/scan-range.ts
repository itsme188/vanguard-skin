/**
 * The level scanner's plausibility band — the single source of truth for
 * "would the scanner even look at this level?".
 *
 * The scanner refuses to evaluate a non-option level whose effective price is
 * more than LEVEL_PLAUSIBILITY_MAX_DISTANCE away from the current price: a real
 * hit is always detected within a few percent of the level (scans run every 30
 * min), so a level half or 10x the price is a unit/scale error that would
 * otherwise sit permanently "hit" and re-fire after every dismiss.
 *
 * That guard used to live only inside checkLevelTriggerState, which let every
 * other surface disagree with it — the suggestion engine offered candidates far
 * outside the band with a one-click Accept, and the armed list then presented
 * the accepted level as live coverage even though the scanner skipped it on
 * every pass. Anything that offers, arms, or lists a level uses this predicate.
 *
 * Pure + dependency-free on purpose: server queries, the pivot engine (which
 * can run client-side) and client components all import it. The Worker keeps a
 * parity-pinned copy of the threshold in workers/cron/src/level-scan.ts.
 */

/** Max |current − level| / level the scanner will still evaluate. */
export const LEVEL_PLAUSIBILITY_MAX_DISTANCE = 0.5;

/**
 * True when the scanner will permanently skip this level.
 *
 * Distance is measured against the LEVEL price (the scanner's denominator),
 * not against spot — a level at half of spot is 100% away, not 50%.
 *
 * Options are exempt: option premiums legitimately double/halve overnight, so
 * a real hit CAN first be seen far past the level.
 *
 * Missing/unknowable inputs return false — "we can't tell" must never render
 * as "out of range", and the scanner's own behaviour on a null price is to
 * skip the row before this check is reached.
 */
export function isLevelBeyondScanRange(
  levelPrice: number | null | undefined,
  currentPrice: number | null | undefined,
  securityType?: string | null,
): boolean {
  if (securityType?.toLowerCase() === "option") return false;
  if (levelPrice == null || currentPrice == null) return false;
  return (
    Math.abs(currentPrice - levelPrice) / levelPrice >
    LEVEL_PLAUSIBILITY_MAX_DISTANCE
  );
}

/** Chip / warning copy, so every surface words the disclosure identically. */
export const BEYOND_SCAN_RANGE_LABEL = "outside scan range";

export const BEYOND_SCAN_RANGE_EXPLANATION =
  "This level is outside the scanner's range and will not alert — it sits more than " +
  `${LEVEL_PLAUSIBILITY_MAX_DISTANCE * 100}% from the current price, so every scan skips it.`;

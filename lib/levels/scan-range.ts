/**
 * The level scanner's coverage rules — the single source of truth for
 * "would the scanner even look at this level?".
 *
 * There are TWO reasons the scanner skips a level: the plausibility band
 * (below) and a stale price (bottom of this file). Both live here so no
 * surface can mirror one half and imply live coverage on the other.
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

/**
 * Signed distance from the level to the current price, in percent, using the
 * scanner's denominator (the LEVEL price). Exported so disclosure copy can
 * quote a figure without re-deriving — and re-deriving with spot as the
 * denominator is exactly how a "50%" message ends up disagreeing with the
 * band that produced it. Null when either side is missing or the level is 0.
 */
export function scanRangeDistancePct(
  levelPrice: number | null | undefined,
  currentPrice: number | null | undefined,
): number | null {
  if (levelPrice == null || currentPrice == null || levelPrice === 0) return null;
  return ((currentPrice - levelPrice) / levelPrice) * 100;
}

/** Chip / warning copy, so every surface words the disclosure identically. */
export const BEYOND_SCAN_RANGE_LABEL = "outside scan range";

export const BEYOND_SCAN_RANGE_EXPLANATION =
  "This level is outside the scanner's range and will not alert — it sits more than " +
  `${LEVEL_PLAUSIBILITY_MAX_DISTANCE * 100}% from the current price, so every scan skips it.`;

// ─── Price freshness — the scanner's OTHER skip condition ────────────
//
// findCrossedLevels refuses to scan a level whose latest price is older than
// the window below: a longer gap means the price feed has been offline and the
// price is suspect, so scanning it could produce spurious alerts from old
// crossings. The window used to be re-typed as a raw `date('now','-4 days')`
// literal at each query site, which is how getArmedLevels ended up without it
// at all — an armed level on a weeks-old price rendered as live coverage while
// every scan pass skipped it. One constant, one SQL fragment, one JS predicate.

/**
 * How old the latest price may be and still be scanned, in calendar days.
 * 4 tolerates both weekends (Fri → Mon = 3 days) and long-weekend Mondays.
 */
export const LEVEL_PRICE_MAX_AGE_DAYS = 4;

/**
 * SQLite predicate fragment: is the price behind `dateExpr` fresh enough to
 * scan? `date()` on BOTH sides per the project's datetime convention — the
 * left side is a stored YYYY-MM-DD string, the right side is SQLite's UTC now.
 *
 * Interpolates only the module's own integer constant — never caller input.
 */
export function levelPriceIsFreshSql(dateExpr: string): string {
  return `date(${dateExpr}) >= date('now', '-${LEVEL_PRICE_MAX_AGE_DAYS} days')`;
}

/**
 * True when a price EXISTS but is too old for the scanner to use — the JS twin
 * of the fragment above, for callers that already hold a price date and no
 * database (tests, and any future client-side judgement).
 *
 * A missing price is not stale — it's absent, which is a different (and
 * separately-disclosed) story; mislabelling it would repeat the mistake the
 * band predicate avoids with its own null handling.
 *
 * Server code should prefer the SQL fragment so the comparison happens in the
 * same clock as the scan (SQLite's date('now') is UTC).
 */
export function isLevelPriceStale(
  priceDate: string | null | undefined,
  today: string,
): boolean {
  if (!priceDate) return false;
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - LEVEL_PRICE_MAX_AGE_DAYS);
  return priceDate < cutoff.toISOString().slice(0, 10);
}

/** Chip copy for a level the scanner skips because its price went stale. */
export const STALE_PRICE_LABEL = "stale price · not scanned";

export const STALE_PRICE_EXPLANATION =
  "This level is armed but is NOT being monitored: the latest price for this " +
  `security is more than ${LEVEL_PRICE_MAX_AGE_DAYS} days old, so every scan ` +
  "skips it. Monitoring resumes on its own once fresh prices arrive.";

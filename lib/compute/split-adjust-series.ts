/**
 * Put a stored close series on one share basis.
 *
 * `benchmark_prices` (and the TWS price history generally) is fetched
 * incrementally from the last stored date forward, so when a fund splits
 * every row before the split stays on the old share basis for good: a 4:1
 * split read as a -75% day, and a 30-session return spanning it was an
 * artefact (QA finding, 2026-11-06, Momentum pulse). The stored rows are
 * not rewritten here (that is a rehearsed repair script's job, precedent
 * `scripts/repair-split-basis-audit.ts`); the series is normalised in
 * memory, product-preserving, the way a split-adjusted vendor feed would
 * present it. Once the rows are repaired there is no gap and this is a
 * no-op.
 *
 * A split is a day-over-day close ratio within `SPLIT_RATIO_TOLERANCE` of
 * an integer N >= 2 (forward split, prices fall to 1/N) or of 1/N (reverse
 * split, prices rise N-fold). A broad ETF does not halve or double in a
 * session, so the integer test is the whole rule; a non-integer gap, such as
 * a bad price row or a real crash, is left alone and stays visible.
 */

export interface CloseRow {
  date: string;
  close_price: number;
}

/** How far a split-day ratio may sit from the integer (the day's own move). */
export const SPLIT_RATIO_TOLERANCE = 0.015;
const MAX_SPLIT_RATIO = 50;

/**
 * The integer split ratio implied by consecutive closes, as the factor every
 * EARLIER close must be divided by: 4 for a 4:1 forward split, 1/3 for a
 * 1:3 reverse split, null when the gap is not a split.
 */
export function impliedSplitDivisor(prevClose: number, nextClose: number): number | null {
  if (!(prevClose > 0) || !(nextClose > 0)) return null;
  const forward = prevClose / nextClose;
  if (forward >= 2 - SPLIT_RATIO_TOLERANCE * 2) {
    const n = Math.round(forward);
    if (n >= 2 && n <= MAX_SPLIT_RATIO && Math.abs(forward / n - 1) <= SPLIT_RATIO_TOLERANCE) return n;
    return null;
  }
  const reverse = nextClose / prevClose;
  if (reverse >= 2 - SPLIT_RATIO_TOLERANCE * 2) {
    const n = Math.round(reverse);
    if (n >= 2 && n <= MAX_SPLIT_RATIO && Math.abs(reverse / n - 1) <= SPLIT_RATIO_TOLERANCE) return 1 / n;
  }
  return null;
}

/**
 * Return a copy of `rows` (ascending by date, as stored) with every close
 * before each detected split divided by that split's divisor. Rows are never
 * mutated; a series with no split comes back equal to its input.
 */
export function splitAdjustCloses<T extends CloseRow>(rows: readonly T[]): T[] {
  if (rows.length < 2) return rows.slice();
  // Walk from the newest row back: the factor accumulates across splits, so a
  // row before two 2:1 splits is divided by 4.
  const out: T[] = new Array(rows.length);
  let divisor = 1;
  out[rows.length - 1] = rows[rows.length - 1];
  for (let i = rows.length - 2; i >= 0; i--) {
    const step = impliedSplitDivisor(rows[i].close_price, rows[i + 1].close_price);
    if (step != null) divisor *= step;
    out[i] = divisor === 1 ? rows[i] : { ...rows[i], close_price: rows[i].close_price / divisor };
  }
  return out;
}

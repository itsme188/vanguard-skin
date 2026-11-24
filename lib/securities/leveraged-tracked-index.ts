/**
 * The index a leveraged or inverse fund tracks (Gains at risk, 2026-11-24).
 *
 * A daily-reset leveraged fund moves its signed factor (`securities.leverage_factor`,
 * `lib/securities/leverage-factor.ts`) times the move of the thing it tracks.
 * To read its beta to a driver index, the Gains at risk engine needs that
 * tracked thing as a `benchmark_prices` symbol: the tracked index's beta to
 * the driver, times the factor. The fund's own regression is never read (a
 * daily-reset fund's multi-day path is not a linear multiple of its index).
 *
 * Keyed by fund symbol (trimmed, upper-cased), valued by the benchmark symbol
 * it tracks. No row means no tracked index: the fund is not modelled, named
 * and counted, never guessed.
 */

/**
 * Hand-checked tracked indexes for flagged funds. Add an entry only with the
 * owner's word on that fund's tracked index (the same rule as
 * `LEVERAGE_FACTOR_SEEDS`). Ships empty: the owner confirms real entries later.
 */
export const LEVERAGED_TRACKED_INDEX_SEEDS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * The benchmark symbol a fund tracks, or null when the seed map names none.
 * `seeds` defaults to `LEVERAGED_TRACKED_INDEX_SEEDS`; tests pass synthetic maps.
 */
export function trackedIndexFor(
  fundSymbol: string,
  seeds: Readonly<Record<string, string>> = LEVERAGED_TRACKED_INDEX_SEEDS,
): string | null {
  const key = fundSymbol.trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(seeds, key)) return null;
  const tracked = seeds[key];
  if (typeof tracked !== "string") return null;
  const normalized = tracked.trim().toUpperCase();
  return normalized === "" ? null : normalized;
}

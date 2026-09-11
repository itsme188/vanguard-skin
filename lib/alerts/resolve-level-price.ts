import type Database from "better-sqlite3";
import { computeSMA, computeEMA } from "@/lib/chart/indicators";
import { PRICED_BAR_SQL } from "@/lib/queries/ohlcv";
import type { LevelPriceSource } from "@/lib/types";

/**
 * MA-based levels store a reference `price` (snapshot at creation time) but
 * the effective trigger price is recomputed daily from ohlcv_bars. This helper
 * does that computation — returning null if we don't have enough history.
 *
 * Two filters this read was missing until 2026-09-11 (PR #72 review):
 *
 *  - `bar_size = '1 day'`. `ohlcv_bars` is keyed by (security_id, bar_date,
 *    bar_size); with no filter an intraday series stored for the same
 *    security interleaves with the daily one, so "the newest 2×period rows
 *    by bar_date" is a mixture of timeframes and `sma_50` stops meaning the
 *    50-DAY average. Daily is the frame every other MA surface charts, and
 *    the frame a level was drawn on.
 *  - `PRICED_BAR_SQL`. A legacy zero-priced close (see that constant's doc
 *    — the write guard only began rejecting them 2026-09-06) is not a real
 *    price, and averaging one in drags the effective level down. Not
 *    cosmetic: the effective price IS the trigger threshold, so a dragged
 *    MA changes whether findCrossedLevels fires an alert.
 *
 * Both filters sit INSIDE the DESC-LIMIT window, so a corrupt or
 * wrong-timeframe row never consumes one of the `period * 2` slots — the
 * caller still gets the newest real daily bars, and the `bars.length <
 * period` guard below keeps meaning "not enough usable history".
 */
export function computeMovingAverage(
  db: Database.Database,
  securityId: number,
  source: Exclude<LevelPriceSource, "static">
): number | null {
  // Parse source into kind + period: "sma_50" → { kind: "sma", period: 50 }
  const match = /^(sma|ema)_(\d+)$/.exec(source);
  if (!match) return null;
  const kind = match[1] as "sma" | "ema";
  const period = parseInt(match[2], 10);

  // We need at least `period` bars. Pull the last 2*period for safety buffer.
  const bars = db
    .prepare(
      `SELECT bar_date AS date, close
       FROM ohlcv_bars
       WHERE security_id = ?
         AND bar_size = '1 day'
         AND ${PRICED_BAR_SQL}
       ORDER BY bar_date DESC
       LIMIT ?`
    )
    .all(securityId, period * 2) as { date: string; close: number }[];

  if (bars.length < period) return null;

  // computeSMA/computeEMA expect ascending chronological order
  const ascending = bars.reverse();
  const series = kind === "sma" ? computeSMA(ascending, period) : computeEMA(ascending, period);
  if (series.length === 0) return null;

  const latest = series[series.length - 1];
  return latest.value;
}

/**
 * Resolve a level's effective trigger price. Static levels return their stored
 * price; MA-based levels compute from ohlcv_bars and return null when bars are
 * insufficient. The stored `price` is a snapshot from creation time and drifts
 * from the real MA over days/weeks, so we never silently fall back to it —
 * callers render "insufficient history" UI and the scan skips the level.
 */
export function resolveLevelPrice(
  db: Database.Database,
  level: { security_id: number; price: number; price_source: LevelPriceSource }
): number | null {
  if (level.price_source === "static") return level.price;
  return computeMovingAverage(db, level.security_id, level.price_source);
}

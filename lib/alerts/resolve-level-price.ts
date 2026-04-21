import type Database from "better-sqlite3";
import { computeSMA, computeEMA } from "@/lib/chart/indicators";
import type { LevelPriceSource } from "@/lib/types";

/**
 * MA-based levels store a reference `price` (snapshot at creation time) but
 * the effective trigger price is recomputed daily from ohlcv_bars. This helper
 * does that computation — returning null if we don't have enough history.
 *
 * Callers are expected to fall back to the static `price` when this returns null.
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
 * price; MA-based levels compute from ohlcv_bars with a fallback to the stored
 * reference price if bars are missing.
 */
export function resolveLevelPrice(
  db: Database.Database,
  level: { security_id: number; price: number; price_source: LevelPriceSource }
): number {
  if (level.price_source === "static") return level.price;
  const computed = computeMovingAverage(db, level.security_id, level.price_source);
  return computed ?? level.price;
}

import { formatLevelPrice } from "@/lib/chart/price-formatter";

/**
 * The "Detected <date> at <price>:" lead-in for a suggested-level card's
 * narrative. The prose is written at detection time, so a distance claim in it
 * ("within 0.5% of the price") is a statement about that moment, not now; the
 * prefix says so. Price renders in the security's NATIVE currency through
 * formatLevelPrice. Returns "" when either fact is unknown: an invented date or
 * price would be worse than no prefix.
 */
export function detectionPrefix(
  detected: { day?: string | null; price?: number | null },
  currency: string | null | undefined,
): string {
  const { day, price } = detected;
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  if (typeof price !== "number" || !Number.isFinite(price)) return "";
  return `Detected ${day} at ${formatLevelPrice(currency, price)}:`;
}

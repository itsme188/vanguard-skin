/**
 * Ordinal rank of a factor level label, for sorting. Higher = more exposure.
 * An unknown or missing label returns null so it sorts last in both directions.
 */
const RANKS: Record<string, number> = {
  "very high": 4,
  high: 3,
  moderate: 2,
  medium: 2,
  low: 1,
  no: 0,
  none: 0,
};

export function factorOrdinalRank(v: string | null | undefined): number | null {
  if (typeof v !== "string") return null;
  return RANKS[v.trim().toLowerCase()] ?? null;
}

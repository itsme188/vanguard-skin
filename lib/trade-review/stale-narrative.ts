import { parseOCCSymbol } from "@/lib/import/occ-symbol";

/**
 * When `scripts/repair-option-roundtrip-dollars.ts` corrected the stored
 * trade_roundtrips + trade_reviews dollar columns (computeTaxLots had been
 * omitting the option contract multiplier — option dollars 100x understated;
 * commit 9003ec4, ran 2026-07-04 ET = 2026-07-05 04:03 UTC). Stored SQLite
 * `created_at` values are UTC "YYYY-MM-DD HH:MM:SS", so plain string
 * comparison against this constant is correct.
 */
export const OPTION_DOLLARS_REPAIRED_AT_UTC = "2026-07-05 04:03:37";

/**
 * True when a review's AI narrative predates the option-dollar repair AND its
 * trade set contains at least one option — meaning the prose was written
 * against 100x-understated option dollars while the header metrics have since
 * been corrected. Stock/ETF-only reviews had nothing understated, so they
 * never flag. Detection prefers securityType (case-insensitive per project
 * convention) and falls back to OCC-symbol shape for rows missing the type.
 *
 * Keyed on `generated_at`, NOT `created_at`: saveTradeReview's upsert
 * refreshes generated_at on regeneration (created_at stays at first insert),
 * so regenerating a flagged review clears the banner.
 */
export function isNarrativeStale(
  generatedAtUtc: string,
  trades: Array<{ symbol: string; securityType?: string | null }>
): boolean {
  if (generatedAtUtc >= OPTION_DOLLARS_REPAIRED_AT_UTC) return false;
  return trades.some(
    (t) =>
      (t.securityType ?? "").toLowerCase() === "option" ||
      parseOCCSymbol(t.symbol) !== null
  );
}

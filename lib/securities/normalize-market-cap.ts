/**
 * market_cap_category vocabulary normalization — single source of truth.
 *
 * The Claude classification fallback (classifyUnresolvedWithClaude) emits bare
 * cap-size labels per its prompt enum ("Large"/"Mid"/"Small"), while every
 * other classification source (static lookup, auto_option, manual) writes the
 * "X Cap" scheme ("Large Cap"/"Mid Cap"/"Small Cap"). Left unnormalized, one
 * cap-size exposure fragments into two parallel Allocation donut buckets
 * (Large 12% + Large Cap 34% were the same exposure). Normalize on the way in
 * at every market_cap_category write site sourced from AI output.
 *
 * Sibling of normalizeFundCategory / normalizeSector / mapSecurityType.
 */

/** lowercase-trimmed synonym → canonical market_cap_category label. */
const ALIASES: Record<string, string> = {
  large: "Large Cap",
  mid: "Mid Cap",
  medium: "Mid Cap",
  small: "Small Cap",
};

/**
 * Normalize a market_cap_category label. Maps known bare synonyms to the
 * canonical "X Cap" scheme; passes any other non-empty label through
 * unchanged; null/empty → null.
 */
export function normalizeMarketCapCategory(
  raw: string | null | undefined
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Canonical GICS-11 sector normalization — single source of truth.
 *
 * Securities arrive tagged with mixed vocabularies: TWS/Bloomberg ("Communications",
 * "Financial", "Consumer, Cyclical") and GICS ("Communication Services", "Financials").
 * Benchmarks (benchmark_compositions) are pure GICS, so comparing a Bloomberg-tagged
 * portfolio against a GICS benchmark produces garbage gaps. Normalize on the way in.
 *
 * Sibling of mapSecurityType / issuerSiblings — never inline a sector string compare.
 */

/** The 11 canonical GICS labels, matching the benchmark_compositions vocabulary. */
export const GICS_SECTORS = [
  "Energy", "Materials", "Industrials", "Consumer Discretionary",
  "Consumer Staples", "Healthcare", "Financials", "Technology",
  "Communication Services", "Utilities", "Real Estate",
] as const;

export type GicsSector = (typeof GICS_SECTORS)[number];

/** Non-GICS labels that are meaningful and must pass through untouched. */
const PASSTHROUGH = new Set(["Diversified", "Fixed Income"]);

/** lowercase-trimmed alias → canonical GICS label. */
const ALIASES: Record<string, GicsSector> = {
  "energy": "Energy",
  "materials": "Materials",
  "industrials": "Industrials",
  "consumer discretionary": "Consumer Discretionary",
  "consumer staples": "Consumer Staples",
  "healthcare": "Healthcare",
  "financials": "Financials",
  "technology": "Technology",
  "communication services": "Communication Services",
  "utilities": "Utilities",
  "real estate": "Real Estate",
  "communications": "Communication Services",
  "financial": "Financials",
  "industrial": "Industrials",
  "consumer, cyclical": "Consumer Discretionary",
  "consumer cyclical": "Consumer Discretionary",
  "consumer, non-cyclical": "Consumer Staples",
  "consumer non-cyclical": "Consumer Staples",
  "consumer non cyclical": "Consumer Staples",
  "basic materials": "Materials",
  "health care": "Healthcare",
  "information technology": "Technology",
  "info technology": "Technology",
};

export function normalizeSector(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (PASSTHROUGH.has(trimmed)) return trimmed;
  const hit = ALIASES[trimmed.toLowerCase()];
  return hit ?? null;
}

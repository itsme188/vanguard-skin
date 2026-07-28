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

/**
 * Non-GICS labels that are meaningful and must pass through untouched.
 * TWS emits these (via `detail.industry`) for broad ETFs / bond funds — they're not
 * GICS sectors but are semantically valid. Keyed lowercase for case-insensitive match
 * (parity with ALIASES); the value is the canonical casing we return.
 */
const PASSTHROUGH: Record<string, string> = {
  "diversified": "Diversified",
  "fixed income": "Fixed Income",
};

/**
 * DEMOTED Bloomberg buckets — deliberately ABSENT from ALIASES (2026-07-28).
 * Bloomberg's taxonomy predates GICS's 2016 Real Estate split and 2018
 * Communication Services reshuffle, so these buckets each span several GICS
 * sectors and CANNOT be 1:1-mapped. Live-verified damage before demotion:
 *   "Communications"           → AMZN (Cons Disc), HOOD (Financials),
 *                                UBER (Industrials), SHOP/APP (Technology);
 *                                only GOOG/META genuinely Comm Services.
 *   "Consumer, Non-cyclical"   → UNH/OSCR/VRTX/ESTA/DHR (all Healthcare);
 *                                only names like KO genuinely Staples.
 *   "Consumer, Cyclical"       → IMAX (Comm Services); NKE/HD fine.
 *   "Financial"                → LAND/KRC (REITs → Real Estate); GS/BAC fine.
 * They return null so the COALESCE write sites leave sector blank for the
 * context-aware Claude classify tail. Do NOT "restore" them as a cleanup.
 * ("Industrial" singular is KEPT: every live row checked out; Bloomberg's
 * Industrial bucket only marginally leaks toward GICS Materials.)
 */

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
  "industrial": "Industrials",
  "basic materials": "Materials",
  "health care": "Healthcare",
  "information technology": "Technology",
  "info technology": "Technology",
};

export function normalizeSector(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const lower = trimmed.toLowerCase();
  if (PASSTHROUGH[lower]) return PASSTHROUGH[lower];
  return ALIASES[lower] ?? null;
}

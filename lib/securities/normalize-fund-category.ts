/**
 * fund_category vocabulary normalization — single source of truth.
 *
 * The Claude classification fallback (classifyUnresolvedWithClaude) emitted
 * bare sector names ("Technology", "Semiconductor", "Financial Services")
 * while the static map uses the "US Sector Equity (X)" scheme. The
 * Classification allocation then split one exposure across parallel buckets
 * ("Technology" 12.1% + "US Sector Equity (Technology)" 17.0% were the same
 * thing). Normalize on the way in at every fund_category write site.
 *
 * Unlike normalizeSector (closed GICS-11 vocabulary), fund_category is an
 * OPEN vocabulary — thematic / cap-size / bond categories are all valid — so
 * unknown labels pass through unchanged. Only true synonyms merge.
 *
 * Sibling of normalizeSector / mapSecurityType / issuerSiblings.
 */

/** lowercase-trimmed synonym → canonical fund_category label. */
const ALIASES: Record<string, string> = {
  technology: "US Sector Equity (Technology)",
  semiconductor: "US Sector Equity (Semiconductors)",
  semiconductors: "US Sector Equity (Semiconductors)",
  healthcare: "US Sector Equity (Health Care)",
  "health care": "US Sector Equity (Health Care)",
  biotechnology: "US Sector Equity (Health Care/Biotech)",
  financial: "US Sector Equity (Financial)",
  financials: "US Sector Equity (Financial)",
  "financial services": "US Sector Equity (Financial)",
  industrials: "US Sector Equity (Industrials)",
  materials: "US Sector Equity (Materials)",
  "basic materials": "US Sector Equity (Materials)",
  "consumer cyclical": "US Sector Equity (Consumer Discretionary)",
  "consumer discretionary": "US Sector Equity (Consumer Discretionary)",
  "consumer defensive": "US Sector Equity (Consumer Staples)",
  "consumer staples": "US Sector Equity (Consumer Staples)",
  "communication services": "US Sector Equity (Communication Services)",
  communications: "US Sector Equity (Communication Services)",
  energy: "US Sector Equity (Energy)",
  utilities: "US Sector Equity (Utilities)",
  "real estate": "US Sector Equity (Real Estate)",
};

/**
 * Normalize a fund_category label. Maps known synonyms to the canonical
 * "US Sector Equity (X)" scheme; passes any other non-empty label through
 * unchanged; null/empty → null.
 */
export function normalizeFundCategory(
  raw: string | null | undefined
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

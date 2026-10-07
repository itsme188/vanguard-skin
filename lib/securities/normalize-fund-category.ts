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
 * Regression (2026-08-12): the AI fallback later started emitting
 * ALREADY-WRAPPED "US Sector Equity (X)" labels where X was itself a
 * Bloomberg/GICS synonym instead of the canonical sector name — e.g.
 * "US Sector Equity (Information Technology)" instead of
 * "US Sector Equity (Technology)", or "US Sector Equity (Financials)"
 * instead of "US Sector Equity (Financial)". The bare-synonym ALIASES table
 * below never matched because the input wasn't bare, so these slipped
 * through as new duplicate allocation buckets. We now also unwrap the
 * parenthetical, canonicalize the inner sector via normalizeSector (the
 * single source of truth for GICS-11 synonyms), and re-map the result
 * through this same ALIASES table so the wrapped and bare paths agree.
 *
 * Unlike normalizeSector (closed GICS-11 vocabulary), fund_category is an
 * OPEN vocabulary — thematic / cap-size / bond categories are all valid — so
 * unknown labels pass through unchanged. Only true synonyms merge.
 *
 * Sibling of normalizeSector / mapSecurityType / issuerSiblings.
 */

import { normalizeSector } from "./normalize-sector";

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

/** Matches an already-wrapped "US Sector Equity (X)" label, capturing X. */
const WRAPPED_SECTOR_RE = /^US Sector Equity\s*\((.+)\)$/i;

/**
 * Normalize a fund_category label. Maps known synonyms to the canonical
 * "US Sector Equity (X)" scheme; also canonicalizes the sector name inside an
 * already-wrapped "US Sector Equity (X)" label when X is a recognized GICS
 * synonym; passes any other non-empty label through unchanged; null/empty →
 * null.
 */
export function normalizeFundCategory(
  raw: string | null | undefined
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const bare = ALIASES[trimmed.toLowerCase()];
  if (bare) return bare;

  const wrapped = trimmed.match(WRAPPED_SECTOR_RE);
  if (wrapped) {
    const gicsSector = normalizeSector(wrapped[1]);
    if (gicsSector) {
      const canonical = ALIASES[gicsSector.toLowerCase()];
      if (canonical) return canonical;
    }
  }

  return trimmed;
}

/**
 * Normalized fund_category labels that mean "this fund holds bonds" — the ONE
 * grouping of bond-type categories (2026-10-07; none existed before). Keyed
 * lowercase. It lists the bond labels the in-repo vocabulary can produce: the
 * static lookup (lib/data/security-classifications.ts) and the examples the
 * AI classification prompt names. fund_category is an OPEN vocabulary, so a
 * bond label that is not here is simply not recognised by category; add it
 * here, never at a call site.
 *
 * Deliberately absent: "Cash Equivalent" / "Money Market" (cash identity is
 * isCashEquivalentSecurity) and every "Leveraged/Inverse" label.
 */
export const BOND_FUND_CATEGORIES: ReadonlySet<string> = new Set([
  "us aggregate bond",
  "diversified bond",
  "us treasury",
  "us long-term treasury",
  "us mortgage-backed securities",
  "us ultra-short bond",
  "emerging markets bond",
  "tips",
]);

/** True when the label, after normalizeFundCategory, is a bond-fund category. */
export function isBondFundCategory(raw: string | null | undefined): boolean {
  const normalized = normalizeFundCategory(raw);
  return normalized != null && BOND_FUND_CATEGORIES.has(normalized.toLowerCase());
}

/**
 * True for the leveraged / inverse family: "Leveraged/Inverse" and its
 * qualified forms such as "Leveraged/Inverse (Commodities)".
 */
export function isLeveragedInverseFundCategory(raw: string | null | undefined): boolean {
  const normalized = normalizeFundCategory(raw);
  return normalized != null && /^leveraged\/inverse\b/i.test(normalized);
}

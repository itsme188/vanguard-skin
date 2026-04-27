/**
 * Issuer-family normalization for dual-class equity tickers.
 *
 * A Finnhub earnings event for ticker "GOOGL" should be matched to a user
 * holding under "GOOG" — they're the same Alphabet earnings (Class A vs.
 * Class C). String-equality joins miss this; `issuerSiblings()` closes the
 * gap by mapping any sibling-class symbol back to the full family.
 *
 * Hardcoded because dual-class issuers are rare and slow-moving; a generic
 * algorithm would risk collapsing unrelated tickers. Add new families here
 * as they appear in the user's data.
 */

const FAMILIES: ReadonlyArray<readonly string[]> = [
  // Alphabet — Class A (voting) vs. Class C (no voting)
  ["GOOG", "GOOGL"],
  // Berkshire Hathaway. The user's DB has both "BRK B" (space) and "BRK/B"
  // (slash) variants depending on import source — include all common forms.
  ["BRK A", "BRK B", "BRK.A", "BRK.B", "BRK/A", "BRK/B", "BRK-A", "BRK-B"],
  // Fox Corporation
  ["FOX", "FOXA"],
  // News Corp
  ["NWS", "NWSA"],
  // Under Armour — Class A (voting) vs. Class C
  ["UA", "UAA"],
  // Liberty Broadband
  ["LBRDA", "LBRDK"],
  // Liberty Sirius XM
  ["LSXMA", "LSXMK"],
  // Heico
  ["HEI", "HEI.A", "HEI/A"],
];

const FAMILY_BY_SYMBOL = new Map<string, readonly string[]>();
for (const family of FAMILIES) {
  for (const sym of family) {
    FAMILY_BY_SYMBOL.set(sym.toUpperCase(), family);
  }
}

/**
 * Returns the issuer family for `symbol` — i.e. all share-class siblings
 * that derive from the same underlying earnings. For symbols not in any
 * known family, returns a singleton `[symbol]` so callers can use this
 * uniformly.
 */
export function issuerSiblings(symbol: string): readonly string[] {
  if (!symbol) return [];
  const family = FAMILY_BY_SYMBOL.get(symbol.toUpperCase());
  return family ?? [symbol];
}

/**
 * True when two symbols share an issuer family (same earnings).
 */
export function sameIssuer(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const fa = FAMILY_BY_SYMBOL.get(a.toUpperCase());
  if (!fa) return false;
  return fa.some((s) => s.toUpperCase() === b.toUpperCase());
}

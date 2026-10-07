/**
 * "Do we know what this position cost?" — the one answer for every surface.
 *
 * A stored cost basis of exactly 0 means "unknown", not "free". It mirrors
 * the query-side convention in lib/queries/holdings.ts
 * (`NULLIF(costBasisExpr, 0) IS NOT NULL`), which already nulls
 * unrealized_gain for a zero basis. A surface that counts a 0 as known
 * prints an exact "$0.00" Cost Basis beside an unknown Gain cell.
 *
 * A NEGATIVE basis is known: a short stores its proceeds as a negative
 * basis (see scaledCostBasisFallbackSQL in lib/valuation.ts).
 *
 * Pure; no imports, so client components can use it.
 */
export function hasKnownBasis(row: { cost_basis: number | null | undefined }): boolean {
  return row.cost_basis != null && row.cost_basis !== 0;
}

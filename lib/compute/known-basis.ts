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

/**
 * True when the basis is known but covers fewer shares than the row holds:
 * the position grew since the statement the basis came from, so the shares
 * added since carry no known cost and are left out of the gain
 * (basisCoveredQuantitySQL in lib/valuation.ts; owner decision 2026-11-01).
 * A row with no covered quantity (absent or null) counts as fully covered.
 */
export function basisCoversPartOnly(row: {
  cost_basis: number | null | undefined;
  quantity: number;
  basis_covered_quantity?: number | null;
}): boolean {
  return (
    hasKnownBasis(row) &&
    row.basis_covered_quantity != null &&
    Math.abs(row.basis_covered_quantity) < Math.abs(row.quantity)
  );
}

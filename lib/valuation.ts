/**
 * Centralized market value calculation for securities.
 *
 * Bond prices are quoted as a percentage of par ($100 face value).
 * A bond with quantity 10000 (face value) priced at 98.5 has
 * market value = 10000 * 98.5 / 100 = $9,850.
 *
 * Options have a contract multiplier (typically 100).
 * 5 contracts priced at $3.50 with multiplier 100 = $1,750.
 *
 * Equities/funds: market_value = quantity * price.
 */

export function marketValue(
  quantity: number,
  price: number,
  securityType: string | null,
  multiplier: number = 1
): number {
  if (securityType === "bond") {
    return (quantity * price) / 100;
  }
  return quantity * price * multiplier;
}

/**
 * SQL CASE expression for adjusted market value.
 * Handles bonds (par-adjusted) and options (multiplier-adjusted).
 * Use in raw SQL queries where the TypeScript function cannot be called.
 *
 * @param multiplierExpr - SQL expression for the security's multiplier column (defaults to "1")
 */
export function adjustedMarketValueSQL(
  quantityExpr: string,
  priceExpr: string,
  securityTypeExpr: string,
  multiplierExpr: string = "1"
): string {
  return `CASE WHEN ${securityTypeExpr} = 'bond'
    THEN ${quantityExpr} * ${priceExpr} / 100.0
    ELSE ${quantityExpr} * ${priceExpr} * COALESCE(${multiplierExpr}, 1)
  END`;
}

/**
 * @deprecated Use adjustedMarketValueSQL instead.
 */
export function bondAdjustedMarketValueSQL(
  quantityExpr: string,
  priceExpr: string,
  securityTypeExpr: string
): string {
  return adjustedMarketValueSQL(quantityExpr, priceExpr, securityTypeExpr);
}

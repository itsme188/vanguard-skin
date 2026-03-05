/**
 * Centralized market value calculation for securities.
 *
 * Bond prices are quoted as a percentage of par ($100 face value).
 * A bond with quantity 10000 (face value) priced at 98.5 has
 * market value = 10000 * 98.5 / 100 = $9,850.
 *
 * Equities/funds: market_value = quantity * price.
 */

export function marketValue(
  quantity: number,
  price: number,
  securityType: string | null
): number {
  if (securityType === "bond") {
    return (quantity * price) / 100;
  }
  return quantity * price;
}

/**
 * SQL CASE expression for bond-adjusted market value.
 * Use in raw SQL queries where the TypeScript function cannot be called.
 */
export function bondAdjustedMarketValueSQL(
  quantityExpr: string,
  priceExpr: string,
  securityTypeExpr: string
): string {
  return `CASE WHEN ${securityTypeExpr} = 'bond'
    THEN ${quantityExpr} * ${priceExpr} / 100.0
    ELSE ${quantityExpr} * ${priceExpr}
  END`;
}

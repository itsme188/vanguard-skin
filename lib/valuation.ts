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
  multiplier: number = 1,
  usdPerUnit: number = 1
): number {
  const native =
    securityType?.toLowerCase() === "bond"
      ? (quantity * price) / 100
      : quantity * price * multiplier;
  return native * usdPerUnit;
}

/**
 * Inverse of marketValue(): derive the quoted unit price from a known market
 * value. Used when broker statements provide holdings value but no price.
 */
export function unitPriceFromMarketValue(
  marketValue: number,
  quantity: number,
  securityType: string | null,
  multiplier: number = 1
): number | null {
  if (
    quantity <= 0 ||
    marketValue <= 0 ||
    !Number.isFinite(quantity) ||
    !Number.isFinite(marketValue)
  ) {
    return null;
  }

  if (securityType?.toLowerCase() === "bond") {
    return (marketValue * 100) / quantity;
  }

  const effectiveMultiplier =
    multiplier > 0 && Number.isFinite(multiplier) ? multiplier : 1;
  return marketValue / quantity / effectiveMultiplier;
}

/**
 * SQL CASE expression for adjusted market value.
 * Handles bonds (par-adjusted) and options (multiplier-adjusted).
 * Use in raw SQL queries where the TypeScript function cannot be called.
 *
 * @param multiplierExpr - SQL expression for the security's multiplier column (defaults to "1")
 * @param fxExpr - SQL expression for the FX conversion factor (defaults to "1")
 */
export function adjustedMarketValueSQL(
  quantityExpr: string,
  priceExpr: string,
  securityTypeExpr: string,
  multiplierExpr: string = "1",
  fxExpr: string = "1"
): string {
  return `(CASE WHEN LOWER(${securityTypeExpr}) = 'bond'
    THEN ${quantityExpr} * ${priceExpr} / 100.0
    ELSE ${quantityExpr} * ${priceExpr} * COALESCE(${multiplierExpr}, 1)
  END) * COALESCE(${fxExpr}, 1)`;
}

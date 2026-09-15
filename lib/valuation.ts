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

/**
 * Cost-basis expression with a per-share-scaled stale-row fallback.
 *
 * Plaid/TWS sync rows carry cost_basis = NULL; the rescue is the latest
 * KNOWN-basis statement row for the same (account, security). That row can
 * belong to a DIFFERENT share count (and stores short bases with varying
 * sign conventions), so serving its basis verbatim renders impossible
 * gains — a -50-share short inheriting a -80-share row's whole basis showed
 * a loss 2.4x its notional. The fallback therefore serves per-share basis
 * magnitude x current quantity, signed like the current position (long
 * basis positive, short proceeds negative). When either quantity is zero
 * the raw stale value passes through (nothing to scale by).
 *
 * "Known basis" excludes a stored 0 on BOTH sides of the COALESCE. The
 * convention lives in lib/queries/holdings.ts, whose unrealized_gain gate is
 * NULLIF(costBasisExpr, 0) IS NOT NULL: a cost_basis of exactly 0 means
 * "unknown", not "free" (QA accounts-holdings--zero-cost-basis-phantom-gain —
 * one statement row carried 0.0 and the whole market value printed as gain),
 * and AllHoldingsTable.tsx's hasKnownBasis mirrors it at the render layer.
 * Applying it here makes the three sites agree:
 *   - outer NULLIF: a stored 0 falls through to the same rescue a NULL gets,
 *     instead of blocking it;
 *   - inner NULLIF: the rescue skips zero-basis rows when it looks for the
 *     latest known basis. Without it the rescue is defeated in the common
 *     case — the zero row is usually the LATEST row for its pair, so the
 *     ORDER BY as_of_date DESC subquery would pick that very zero back up.
 * A position whose only basis anywhere is 0 therefore resolves to NULL
 * (unknown) rather than to a fabricated $0 cost.
 *
 * @param outer  alias of the holdings row being displayed (e.g. "h")
 * @param inner  alias for the fallback subquery row (e.g. "h3")
 */
export function scaledCostBasisFallbackSQL(outer: string, inner: string): string {
  const o = outer;
  const i = inner;
  return `COALESCE(
        NULLIF(${o}.cost_basis, 0),
        (SELECT CASE
            WHEN ${o}.quantity = 0 OR ${i}.quantity = 0 OR ${i}.quantity IS NULL
              THEN ${i}.cost_basis
            ELSE (CASE WHEN ${o}.quantity < 0 THEN -1 ELSE 1 END)
                 * ABS(${i}.cost_basis) * ABS(${o}.quantity) / ABS(${i}.quantity)
          END
          FROM holdings ${i}
          WHERE ${i}.account_id = ${o}.account_id
            AND ${i}.security_id = ${o}.security_id
            AND NULLIF(${i}.cost_basis, 0) IS NOT NULL
          ORDER BY ${i}.as_of_date DESC LIMIT 1)
      )`;
}

/**
 * Shared option plumbing: the option row predicate, the pricing inputs type,
 * the SQL fragments both scenario position queries select, and the exposure
 * fallback constant. Scenario pricing itself lives in option-reprice.ts.
 *
 * The SQL fragments are shared so the preset and custom engines cannot drift
 * apart on which pricing columns they select (QA finding
 * `analysis-scenarios--custom-whatif-flat-2x-option-beta-long-puts-lose-in-crash`,
 * 2026-09-11).
 *
 * `DEFAULT_OPTION_ELASTICITY` is re-exported from scenario-recipes.ts for its
 * existing consumer (lib/compute/exposure.ts) — that import path still works.
 */

/** Fallback for the delta-exposure column (lib/compute/exposure.ts) when an
 *  option's pricing inputs are missing. Scenarios do not use it. */
export const DEFAULT_OPTION_ELASTICITY = 2.5;

/**
 * The pricing inputs an option needs. Both engines' position rows satisfy
 * this structurally (see OPTION_PRICING_COLUMNS_SQL).
 */
export interface OptionElasticityInputs {
  option_type: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  /** The option's own last close (per share, pre-multiplier). */
  own_price: number | null;
  /** The underlying's last close. Null when the underlying is unpriced. */
  underlying_price: number | null;
  underlying_iv: number | null;
}

/**
 * Is this row an option? Single source for both engines. 'Option' is the
 * canonical type `upsertSecurity` writes; 'call' / 'put' are tolerated
 * because the legacy beta heuristic accepted them and a stray broker row
 * must not silently fall through to the equity path.
 */
export function isOptionSecurityType(securityType: string | null | undefined): boolean {
  const type = (securityType ?? "").trim().toLowerCase();
  return type === "option" || type === "call" || type === "put";
}

/**
 * Normalize an expiration to ISO YYYY-MM-DD. The column holds BOTH spellings
 * the DB actually carries — ISO, and the compact YYYYMMDD on a handful of
 * TWS-enriched rows — and `new Date("20270115")` is an Invalid Date whose NaN
 * time made T non-finite, silently dropping every such option onto the ±2.5
 * fallback instead of its real Δ·S/V. Same two shapes `normalizeExpiration` in
 * lib/compute/options-strategy.ts parses; that copy is module-private, so this
 * one is kept deliberately in step rather than imported (neither module then
 * owns the other's expiry-cutoff semantics).
 */
export function normalizeExpirationDate(expiry: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return expiry;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(expiry);
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : null;
}

/**
 * The option pricing columns BOTH position queries must select, so
 * the repricing function sees identical inputs on both paths.
 *
 * Required aliases in the surrounding query:
 *   s     — securities row being valued
 *   lp    — latest_prices row for `s` (own price)
 *   lp_u  — latest_prices row for the underlying (from OPTION_PRICING_JOINS_SQL)
 *   q_u   — security_quotes row for the underlying (ditto)
 */
export const OPTION_PRICING_COLUMNS_SQL = `        s.strike_price,
        s.expiration_date,
        s.option_type,
        lp.close_price AS own_price,
        lp_u.close_price AS underlying_price,
        q_u.iv_underlying AS underlying_iv`;

/**
 * The joins that resolve an option's underlying. `s_u` is also what both
 * engines COALESCE their classification columns against, so an option
 * inherits the underlying's sector / style / factors instead of scoring as a
 * classification-free row.
 *
 * Requires a `latest_prices` CTE and the `s` alias to be in scope.
 */
export const OPTION_PRICING_JOINS_SQL = `      LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
      LEFT JOIN latest_prices lp_u ON lp_u.security_id = s_u.id
      LEFT JOIN security_quotes q_u ON q_u.security_id = s_u.id`;

/**
 * SQL twin of `isOptionSecurityType` for the `s` alias. Both position queries
 * use it to keep an option row that has no price of its own, so the scenario
 * can list it as "not modelled" instead of dropping it silently.
 */
export const OPTION_ROW_SQL = `LOWER(TRIM(s.security_type)) IN ('option', 'call', 'put')`;

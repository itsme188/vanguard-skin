/**
 * Option elasticity — the ONE option treatment both scenario engines share.
 *
 * Why this module exists (QA finding `analysis-scenarios--custom-whatif-flat-
 * 2x-option-beta-long-puts-lose-in-crash`, 2026-09-11): the preset/recipe
 * engine levered an option by signed elasticity (a held put GAINS when the
 * underlying falls), while the custom what-if path in scenarios.ts gave every
 * option a flat beta of 2.0 with no put/call sign — so the SAME long put
 * rendered +14.6% on the preset card and -40% on the custom card of the same
 * page. Elasticity now lives here, imported by both engines, and the SQL
 * fragments that feed it are exported too so the two position queries cannot
 * drift apart on which pricing columns they select.
 *
 * `DEFAULT_OPTION_ELASTICITY` is re-exported from scenario-recipes.ts for its
 * existing consumer (lib/compute/exposure.ts) — that import path still works.
 */

import { delta } from "./options-greeks";

/** Fallback when elasticity inputs are missing (no underlying price / IV /
 *  option price). Sign carries the option's direction. Exported so the
 *  delta-exposure column (lib/compute/exposure.ts) shares the convention. */
export const DEFAULT_OPTION_ELASTICITY = 2.5;

/** |Ω| clamp — deep-OTM short-dated options have huge theoretical elasticity
 *  but gamma/vol effects dominate there; a linear-delta model shouldn't
 *  extrapolate past this. */
export const MAX_OPTION_ELASTICITY = 8;

/**
 * The pricing inputs elasticity needs. Both engines' position rows satisfy
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
 * Option elasticity Ω = Δ·S/V: the % move in the option per 1% move in the
 * underlying (linear-delta approximation). Signed — puts carry negative Ω so
 * a down-shock on the underlying produces a positive option move. Falls back
 * to ±2.5 when pricing inputs are unavailable.
 */
export function optionElasticity(pos: OptionElasticityInputs, riskFreeRate: number): number {
  const isPut = (pos.option_type ?? "").toUpperCase().startsWith("P");
  const fallback = (isPut ? -1 : 1) * DEFAULT_OPTION_ELASTICITY;

  const S = pos.underlying_price;
  const V = pos.own_price;
  const K = pos.strike_price;
  if (S == null || S <= 0 || V == null || V <= 0 || K == null || K <= 0 || !pos.expiration_date) {
    return fallback;
  }
  const T = (new Date(pos.expiration_date).getTime() - Date.now()) / (365 * 24 * 3600 * 1000);
  if (!Number.isFinite(T) || T <= 0) return fallback;

  const sigma = pos.underlying_iv ?? 0.30;
  const d = delta(S, K, T, riskFreeRate, sigma, isPut ? "PUT" : "CALL");
  const omega = (d * S) / V;
  if (!Number.isFinite(omega) || omega === 0) return fallback;
  return Math.max(-MAX_OPTION_ELASTICITY, Math.min(MAX_OPTION_ELASTICITY, omega));
}

/**
 * Apply the option leg: the engine-computed move describes the UNDERLYING, so
 * lever it by signed Ω and clamp at -100% (an option price cannot go below
 * zero). Both engines call this so the clamp and the sign convention can
 * never diverge.
 */
export function leverUnderlyingMoveByElasticity(underlyingMove: number, omega: number): number {
  return Math.max(-1, underlyingMove * omega);
}

/**
 * The option pricing columns BOTH position queries must select, so
 * `optionElasticity` sees identical inputs on both paths.
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

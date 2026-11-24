/**
 * The held positions a scenario engine reprices: ONE SQL builder, two readers
 * (Gains at risk, Task 4, 2026-11-24).
 *
 *   - `loadScenarioPositions`: netted by security across the scope (the
 *     custom scenario engine, `computeScenario`).
 *   - `loadScenarioPositionsByAccount`: one row per (account, security), so a
 *     long in one account and a short in another both count toward a gross
 *     book (F11). The Gains at risk engine reads it.
 *
 * Neither reader filters on price (F10): a row with no price of its own is
 * returned so the caller can list it as not modelled instead of dropping it.
 * `computeScenario` applies its own price filter after the read, unchanged
 * (`(own_price ?? 0) > 0 || isOptionSecurityType(security_type)`).
 *
 * Every column is the custom engine's own, plus the inputs a dollar figure
 * needs outside a market value: the netted quantity, the contract multiplier,
 * the FX factor and the raw rate (null = no `fx_rates` row), the underlying's
 * id, and the option's stored underlying symbol (kept when no underlying row
 * exists, F7). READ-ONLY.
 */

import type Database from "better-sqlite3";
import type { FactorColumn } from "@/lib/factors";
import { FACTOR_COLUMNS } from "@/lib/factors";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { OPTION_PRICING_COLUMNS_SQL, OPTION_PRICING_JOINS_SQL, OPTION_ROW_SQL } from "./option-elasticity";
import { UNDERLYING_IDENTITY_COLUMNS_SQL } from "./scenario-recipes";

export type ScenarioPositionRow = {
  security_id: number;
  symbol: string;
  security_name: string | null;
  security_type: string;
  sector: string | null;
  style: string | null;
  market_cap_category: string | null;
  fund_category: string | null;
  industry: string | null;
  subject_fund_category: string | null;
  geography: string | null;
  currency: string | null;
  duration_years: number | null;
  maturity_date: string | null;
  coupon_rate: number | null;
  /** Latest stored price; read by the bond rate leg only. */
  bond_price: number | null;
  credit_rating: string | null;
  /** Security type of the option's underlying; null for non-options. */
  underlying_security_type: string | null;
  /** The underlying's fund category and name (null for non-options); read by the leveraged-fund rule. */
  underlying_fund_category: string | null;
  underlying_name: string | null;
  /** Signed leverage factor of the row and of its underlying (migration 102). */
  leverage_factor: number | null;
  underlying_leverage_factor: number | null;
  /** The underlying's own identity (null for non-options); see UNDERLYING_IDENTITY_COLUMNS_SQL. */
  underlying_symbol: string | null;
  underlying_sector: string | null;
  underlying_industry: string | null;
  underlying_geography: string | null;
  underlying_currency: string | null;
  // Option pricing inputs (null for non-options) — see OPTION_PRICING_COLUMNS_SQL.
  strike_price: number | null;
  expiration_date: string | null;
  option_type: string | null;
  own_price: number | null;
  underlying_price: number | null;
  underlying_iv: number | null;
  /** USD market value at the latest price; 0 when the row has no price. */
  market_value: number;
  /** Signed quantity: netted across the scope, or this account's own. */
  total_qty: number;
  /** COALESCE(s.multiplier, 1). */
  multiplier: number;
  /** COALESCE(fx.usd_per_unit, 1): the factor market_value already carries. */
  usd_per_unit: number;
  /** The raw rate for the row's currency; null when no `fx_rates` row exists. */
  fx_usd_per_unit: number | null;
  /** securities.id of the option's underlying row (s_u.id); null when absent or not an option. */
  underlying_security_id: number | null;
  /** The option's stored securities.underlying_symbol, kept when no underlying row exists (F7). */
  stored_underlying_symbol: string | null;
} & Record<FactorColumn, string | null>;

export type ScenarioPositionAccountRow = ScenarioPositionRow & { account_id: number; account_name: string };

function positionsSql(byAccount: boolean, accountFilter: string, today: string | undefined): string {
  const holdingKey = byAccount ? "h.account_id, h.security_id" : "h.security_id";
  return `WITH latest_holdings AS (
         SELECT ${holdingKey}, SUM(h.quantity) AS total_qty
         FROM holdings h
         WHERE ${latestHoldingsPredicate({ includeShorts: true, accountFilter })}
         GROUP BY ${holdingKey}
       ),
       latest_prices AS (
         SELECT security_id, close_price
         FROM prices
         WHERE (security_id, date) IN (
           SELECT security_id, MAX(date) FROM prices GROUP BY security_id
         )
       )
       SELECT
         lh.security_id,${
           byAccount
             ? `
         lh.account_id,
         COALESCE(a.name, 'Account ' || lh.account_id) AS account_name,`
             : ""
         }
         s.symbol,
         s.name AS security_name,
         s.security_type,
         -- Options inherit the UNDERLYING's classification (same COALESCE
         -- rule the recipe engine applies) so beta comes from the underlying
         -- instead of an option row's empty sector / style / size columns.
         COALESCE(s.sector, s_u.sector) AS sector,
         COALESCE(s.style, s_u.style) AS style,
         COALESCE(s.market_cap_category, s_u.market_cap_category) AS market_cap_category,
         s.fund_category,
         -- What the rate recipe's equity path reads (customRateEquityLeg),
         -- with the recipe engine's own option-to-underlying inheritance.
         COALESCE(s.industry, s_u.industry) AS industry,
         CASE WHEN ${OPTION_ROW_SQL} THEN COALESCE(s_u.fund_category, s.fund_category)
              ELSE COALESCE(s.fund_category, s_u.fund_category) END AS subject_fund_category,
         COALESCE(s.geography, s_u.geography) AS geography,
         COALESCE(s.currency, s_u.currency) AS currency,
${FACTOR_COLUMNS.map((c) => `         COALESCE(sf.${c}, sf_u.${c}) AS ${c},`).join("\n")}
         s.duration_years,
         s.maturity_date,
         s.coupon_rate,
         lp.close_price AS bond_price,
         s.credit_rating,
         s_u.security_type AS underlying_security_type,
         s_u.fund_category AS underlying_fund_category,
         s_u.name AS underlying_name,
         s.leverage_factor,
         s_u.leverage_factor AS underlying_leverage_factor,
         -- The underlying's own identity: the rate leg reads an option
         -- through its fund (look-through, sector, domicile), as the preset does.
         ${UNDERLYING_IDENTITY_COLUMNS_SQL},
${OPTION_PRICING_COLUMNS_SQL},
         lh.total_qty,
         COALESCE(s.multiplier, 1) AS multiplier,
         COALESCE(fx.usd_per_unit, 1) AS usd_per_unit,
         fx.usd_per_unit AS fx_usd_per_unit,
         s_u.id AS underlying_security_id,
         s.underlying_symbol AS stored_underlying_symbol,
         ${adjustedMarketValueSQL("lh.total_qty", "COALESCE(lp.close_price, 0)", "s.security_type", "s.multiplier", "fx.usd_per_unit")} AS market_value
       FROM latest_holdings lh
       JOIN securities s ON s.id = lh.security_id${
         byAccount
           ? `
       LEFT JOIN accounts a ON a.id = lh.account_id`
           : ""
       }
       LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       LEFT JOIN security_factors sf ON sf.security_id = s.id
${OPTION_PRICING_JOINS_SQL}
       LEFT JOIN security_factors sf_u ON sf_u.security_id = s_u.id
       WHERE ${liveOptionExpirationSql("s", today)}
       ORDER BY market_value DESC${byAccount ? ", lh.account_id" : ""}`;
}

/**
 * Held positions netted by security across the scope, priced or not.
 * `undefined` is every account; `[]` is none. `opts.today` (default
 * `todayET()`) decides which option contracts are still live.
 */
export function loadScenarioPositions(
  db: Database.Database,
  accountIds: number[] | undefined,
  opts?: { today?: string },
): ScenarioPositionRow[] {
  const { sql: accountFilter, params } = accountScopeAndSql(accountIds);
  return db.prepare(positionsSql(false, accountFilter, opts?.today)).all(...params) as ScenarioPositionRow[];
}

/**
 * Held positions, one row per (account, security), priced or not (F11).
 * Same columns and rules as `loadScenarioPositions`; quantity and market
 * value are the account's own.
 */
export function loadScenarioPositionsByAccount(
  db: Database.Database,
  accountIds: number[] | undefined,
  opts?: { today?: string },
): ScenarioPositionAccountRow[] {
  const { sql: accountFilter, params } = accountScopeAndSql(accountIds);
  return db.prepare(positionsSql(true, accountFilter, opts?.today)).all(...params) as ScenarioPositionAccountRow[];
}

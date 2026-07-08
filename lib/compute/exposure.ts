/**
 * Delta-adjusted exposure — "what am I exposed to," vs market value's
 * "where is my capital."
 *
 * Stocks/ETFs/funds count at (signed) market value: delta = 1. Options count
 * at Δ × spot × multiplier × contracts — the underlying-equivalent dollars.
 * Signs compose naturally: a long put is NEGATIVE exposure (it hedges common
 * shares of the same bucket); a short call is negative; a deep-ITM LEAP
 * approaches its full notional.
 *
 * Deltas come from computePortfolioGreeks (Black-Scholes with the IV fallback
 * chain: option-price-implied → cached IBKR underlying IV → 30% default).
 * Options whose Greeks can't compute at all (no underlying price, expired)
 * fall back to ±DEFAULT_OPTION_ELASTICITY × market value — the same
 * convention the scenario engine uses — via optionExposureFallback.
 *
 * Limitations (documented, deliberate): delta is a local measure — OTM
 * options show large notional but premium-bounded loss; exposure does not
 * sum to 100% (leverage is the point — see getPortfolioExposureSummary).
 */

import type Database from "better-sqlite3";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";
import { DEFAULT_OPTION_ELASTICITY } from "@/lib/compute/scenario-recipes";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

/**
 * Signed delta-notional per option security_id, summed across the scoped
 * accounts. Options whose Greeks can't compute are ABSENT from the map —
 * callers fall back via optionExposureFallback.
 */
export function getOptionExposureMap(
  db: Database.Database,
  accountIds?: number[]
): Map<number, number> {
  const map = new Map<number, number>();
  const scopes: Array<number | undefined> =
    accountIds && accountIds.length > 0 ? accountIds : [undefined];

  for (const accountId of scopes) {
    const greeks = computePortfolioGreeks(db, accountId ? { accountId } : undefined);
    for (const pos of greeks.positions) {
      if (!pos.greeks || pos.underlyingPrice <= 0) continue;
      const exposure =
        pos.greeks.delta * pos.underlyingPrice * pos.multiplier * pos.quantity;
      map.set(pos.securityId, (map.get(pos.securityId) ?? 0) + exposure);
    }
  }
  return map;
}

/**
 * Fallback exposure for an option whose Greeks are unavailable:
 * ±DEFAULT_OPTION_ELASTICITY × (signed) market value, negative for puts.
 * Market value already carries the long/short sign via quantity, so the
 * directions compose (short put ⇒ positive exposure).
 */
export function optionExposureFallback(
  optionType: string | null | undefined,
  marketValue: number
): number {
  const direction = optionType?.toUpperCase() === "PUT" ? -1 : 1;
  return direction * DEFAULT_OPTION_ELASTICITY * marketValue;
}

/**
 * Resolve one holding row's exposure: non-options at market value, options
 * via the greeks map with the ±2.5×MV fallback.
 */
export function exposureForHolding(
  row: { security_id: number; security_type: string | null; option_type: string | null; mv: number },
  optionExposures: Map<number, number>
): number {
  if (row.security_type?.toLowerCase() !== "option") return row.mv;
  return optionExposures.get(row.security_id) ?? optionExposureFallback(row.option_type, row.mv);
}

export interface PortfolioExposureSummary {
  total_market_value: number;
  /** Σ signed exposure — the effective net long/short in dollars. */
  net_exposure: number;
  /** Σ |per-security exposure| — magnitude of all bets incl. hedges. */
  gross_exposure: number;
  /** net_exposure / total_market_value (1.0 = fully invested, unlevered). */
  net_ratio: number | null;
  /** gross_exposure / total_market_value. */
  gross_ratio: number | null;
}

/**
 * Portfolio-level exposure headline. Same holdings universe as the
 * allocation queries (per-account latest snapshot, maturity-filtered).
 */
export function getPortfolioExposureSummary(
  db: Database.Database,
  accountIds?: number[]
): PortfolioExposureSummary {
  const conditions = [
    "(s.maturity_date IS NULL OR s.maturity_date >= date('now'))",
  ];
  const params: (string | number)[] = [];
  if (accountIds && accountIds.length > 0) {
    conditions.push(`h.account_id IN (${accountIds.map(() => "?").join(",")})`);
    params.push(...accountIds);
  }

  const rows = db
    .prepare(
      `WITH latest_holdings AS (
        SELECT h.* FROM holdings h
        WHERE ${latestHoldingsPredicate({ keyBy: "account", includeShorts: false })}
      ),
      latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        s.id AS security_id,
        s.security_type,
        s.option_type,
        CASE
          WHEN lp.close_price IS NOT NULL
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
            THEN h.cost_basis * COALESCE(fx.usd_per_unit, 1)
          ELSE 0
        END AS mv
      FROM latest_holdings h
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      WHERE ${conditions.join(" AND ")}`
    )
    .all(...params) as Array<{
      security_id: number;
      security_type: string | null;
      option_type: string | null;
      mv: number;
    }>;

  const optionExposures = getOptionExposureMap(db, accountIds);

  let totalMv = 0;
  let net = 0;
  let gross = 0;
  // Aggregate per security so the same contract held in two scoped accounts
  // nets before |·| (gross shouldn't double-count an internally-flat book).
  const perSecurity = new Map<number, number>();
  for (const row of rows) {
    totalMv += row.mv;
    const exposure = exposureForHolding(row, optionExposures);
    net += exposure;
    perSecurity.set(row.security_id, (perSecurity.get(row.security_id) ?? 0) + exposure);
  }
  for (const exposure of perSecurity.values()) gross += Math.abs(exposure);

  return {
    total_market_value: totalMv,
    net_exposure: net,
    gross_exposure: gross,
    net_ratio: totalMv !== 0 ? net / totalMv : null,
    gross_ratio: totalMv !== 0 ? gross / totalMv : null,
  };
}

/** Cockpit per-family net exposure. Full implementation in Task 4. */
export function getNetExposureForSymbolFamilies(
  db: Database.Database,
  symbols: string[]
): Record<string, number> {
  void db;
  return Object.fromEntries(symbols.map((s) => [s, 0]));
}

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
import { accountScopeCondition } from "@/lib/queries/account-scope-sql";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * Option delta exposure for the scoped accounts.
 *
 * As a Map it is keyed by option security_id and holds the contract's signed
 * delta-notional SUMMED across the scoped accounts (the contract's whole
 * exposure). That total is NOT what one holdings row carries: the same
 * contract held in two accounts is two rows, and giving each row the total
 * counted the contract once per row (two rows of one contract read four
 * legs where two are owned). `exposureForHolding` therefore reads a row's
 * OWN share through the extra lookups below, never the total.
 *
 * Options whose Greeks can't compute are ABSENT — callers fall back via
 * optionExposureFallback.
 */
export class OptionExposureMap extends Map<number, number> {
  /** Exposure of one (account, security) holdings row; key `holdingKey`. */
  readonly byHolding = new Map<string, number>();
  /**
   * Exposure per US dollar of the row's priced value, per security: Δ × spot
   * ÷ (option close × FX). The same for every account holding the contract,
   * so a row that does not name its account still reads exactly its own
   * share as `mv × ratio`. Set only when the contract has a positive close
   * (then every row of it is valued at that close, never at cost).
   */
  readonly perValueDollar = new Map<number, number>();
  /** How many holdings rows of the security the total was summed over. */
  readonly rowCount = new Map<number, number>();
}

export function holdingKey(accountId: number, securityId: number): string {
  return `${accountId}:${securityId}`;
}

export function getOptionExposureMap(
  db: Database.Database,
  accountIds?: number[]
): OptionExposureMap {
  const map = new OptionExposureMap();
  // `undefined` is every account; a defined empty list is NO accounts: no
  // pass, an empty map. Always one pass PER ACCOUNT, so each position is
  // known by its account (a Greeks position does not carry one).
  const scopes: number[] =
    accountIds === undefined
      ? (db.prepare("SELECT id FROM accounts ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id)
      : accountIds;
  const fxFor = db.prepare(
    `SELECT COALESCE(fx.usd_per_unit, 1) AS fx
     FROM securities s LEFT JOIN fx_rates fx ON fx.currency = s.currency
     WHERE s.id = ?`
  );

  for (const accountId of scopes) {
    const greeks = computePortfolioGreeks(db, { accountIds: [accountId] });
    for (const pos of greeks.positions) {
      if (!pos.greeks || pos.underlyingPrice <= 0) continue;
      const exposure =
        pos.greeks.delta * pos.underlyingPrice * pos.multiplier * pos.quantity;
      map.set(pos.securityId, (map.get(pos.securityId) ?? 0) + exposure);
      const key = holdingKey(accountId, pos.securityId);
      map.byHolding.set(key, (map.byHolding.get(key) ?? 0) + exposure);
      map.rowCount.set(pos.securityId, (map.rowCount.get(pos.securityId) ?? 0) + 1);
      if (!map.perValueDollar.has(pos.securityId) && pos.optionPrice != null && pos.optionPrice > 0) {
        const fx = (fxFor.get(pos.securityId) as { fx: number } | undefined)?.fx ?? 1;
        if (fx > 0) {
          map.perValueDollar.set(pos.securityId, (pos.greeks.delta * pos.underlyingPrice) / (pos.optionPrice * fx));
        }
      }
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
 * Resolve ONE holdings row's exposure: non-options at market value, options
 * at that row's own delta exposure, with the ±2.5×MV fallback when the
 * contract's Greeks can't compute.
 *
 * A row is one (account, security) holding. Its own share, in order:
 *   1. the row names its account → that account's exposure, exactly;
 *   2. the contract has a close → the row's value × the per-dollar ratio
 *      (exact: every account's leg is valued at the same close);
 *   3. otherwise the scoped total split evenly over the contract's rows, so
 *      the rows still sum to the total (only a split across account buckets
 *      can be off, for an unpriced contract read without account ids).
 *      Every caller in the app selects `h.account_id`, so rule 1 applies;
 *      rule 3 is a last resort for a row that cannot name its account.
 */
export function exposureForHolding(
  row: {
    security_id: number;
    security_type: string | null;
    option_type: string | null;
    mv: number;
    account_id?: number | null;
  },
  optionExposures: OptionExposureMap
): number {
  if (row.security_type?.toLowerCase() !== "option") return row.mv;
  // A plain Map (a copy: `new Map(map)` keeps only the netted totals and
  // drops the per-row lookups) would hand every row of a contract the
  // contract's whole total. Refuse it loudly rather than read it.
  if (!(optionExposures instanceof OptionExposureMap)) {
    throw new TypeError(
      "exposureForHolding needs the OptionExposureMap from getOptionExposureMap, not a copy: a plain Map carries only netted per-contract totals"
    );
  }
  const total = optionExposures.get(row.security_id);
  if (total === undefined) return optionExposureFallback(row.option_type, row.mv);

  if (row.account_id != null) {
    const own = optionExposures.byHolding.get(holdingKey(row.account_id, row.security_id));
    if (own !== undefined) return own;
  }
  const rows = optionExposures.rowCount.get(row.security_id) ?? 1;
  // One row of the contract in scope: the total IS that row's exposure.
  if (rows <= 1) return total;
  const ratio = optionExposures.perValueDollar.get(row.security_id);
  if (ratio !== undefined) return row.mv * ratio;
  return total / rows;
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
 * allocation queries: per-(account, security) latest rows INCLUDING shorts
 * (user decision 2026-07-28 — the prior per-account/no-shorts universe made
 * net == gross == 100% on a book holding shorts, an impossible headline).
 */
export function getPortfolioExposureSummary(
  db: Database.Database,
  accountIds?: number[],
  today: string = todayET()
): PortfolioExposureSummary {
  // ET-anchored cutoffs, never SQLite's UTC date('now') (which reads as
  // tomorrow between UTC and ET midnight): a matured bond or an option past
  // its expiration day drops out; one maturing/expiring today still counts.
  const conditions = [
    "(s.maturity_date IS NULL OR s.maturity_date >= ?)",
    liveOptionExpirationSql("s", today),
  ];
  const params: (string | number)[] = [today];
  // `undefined` is every account; a defined empty list is NO accounts.
  const scope = accountScopeCondition(accountIds);
  if (scope.condition !== null) {
    conditions.push(scope.condition);
    params.push(...scope.params);
  }

  const rows = db
    .prepare(
      `WITH latest_holdings AS (
        SELECT h.* FROM holdings h
        WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
      ),
      latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        h.account_id,
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
      account_id: number;
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

/**
 * Per-reporter family net exposure for the earnings cockpit: for each input
 * symbol, Σ over ALL accounts of (signed stock/fund MV + delta-adjusted
 * option exposure) where the security's symbol OR underlying_symbol is in
 * the issuer family. Shorts stay signed (quantity != 0 predicate). FX via
 * fx_rates. Unheld names → 0.
 */
export function getNetExposureForSymbolFamilies(
  db: Database.Database,
  symbols: string[],
  today: string = todayET()
): Record<string, number> {
  const result: Record<string, number> = {};
  if (symbols.length === 0) return result;

  // familyMember (upper) → input symbol. First input wins on overlap.
  const memberToInput = new Map<string, string>();
  for (const input of symbols) {
    result[input] = 0;
    for (const member of issuerSiblings(input)) {
      const key = member.toUpperCase();
      if (!memberToInput.has(key)) memberToInput.set(key, input);
    }
  }
  const members = [...memberToInput.keys()];
  const placeholders = members.map(() => "?").join(",");

  const rows = db
    .prepare(
      `WITH latest_holdings AS (
        SELECT h.* FROM holdings h
        WHERE ${latestHoldingsPredicate()}
      ),
      latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        h.account_id,
        s.id AS security_id,
        s.security_type,
        s.option_type,
        UPPER(COALESCE(s.underlying_symbol, s.symbol)) AS family_symbol,
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
      -- ET-anchored cutoffs (never UTC date('now')): an option counts through
      -- its ET expiration day via the shared liveOptionExpirationSql; a bond
      -- counts through its maturity day on the same ET calendar.
      WHERE (s.maturity_date IS NULL OR s.maturity_date >= ?)
        AND ${liveOptionExpirationSql("s", today)}
        AND UPPER(COALESCE(s.underlying_symbol, s.symbol)) IN (${placeholders})`
    )
    .all(today, ...members) as Array<{
      account_id: number;
      security_id: number;
      security_type: string | null;
      option_type: string | null;
      family_symbol: string;
      mv: number;
    }>;

  if (rows.length === 0) return result;

  const optionExposures = getOptionExposureMap(db);
  for (const row of rows) {
    const input = memberToInput.get(row.family_symbol);
    if (!input) continue;
    result[input] += exposureForHolding(row, optionExposures);
  }
  return result;
}

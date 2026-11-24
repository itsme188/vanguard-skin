/**
 * Delta-adjusted exposure — "what am I exposed to," vs market value's
 * "where is my capital."
 *
 * Stocks/ETFs/funds count at (signed) market value: delta = 1, times the
 * signed leverage factor for a leveraged or inverse fund (resolveHoldingExposure).
 * Options count at Δ × spot × multiplier × contracts — the underlying-
 * equivalent dollars, converted to USD at the underlying's rate.
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
import { resolveLeveragedExposure } from "@/lib/compute/leveraged-fund";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
// A cycle (exposure-delta imports this file), read only inside function
// bodies, never at module load, so neither side sees an unset binding.
import { NEAR_NEUTRAL_NET_SHARE } from "@/lib/compute/exposure-delta";
import { getPortfolioCurrentValues } from "@/lib/queries/dashboard";

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
   * ÷ option close. Spot and close are both stored in native currency, so the
   * ratio carries no currency and is applied to the row's USD market value
   * (`mv × ratio` is USD exposure). Only if the underlying and the contract
   * were quoted in DIFFERENT currencies would the two rates differ, and the
   * ratio then carries underlying FX ÷ option FX (both 1 for USD). The same
   * for every account holding the contract, so a row that does not name its
   * account still reads exactly its own share as `mv × ratio`. Set only when
   * the contract has a positive close (then every row of it is valued at
   * that close, never at cost).
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
  // Prices are stored NATIVE and converted at read time (fx_rates). The
  // Greeks' spot is the UNDERLYING's native close, so the delta-notional is
  // converted at the underlying's rate; a missing rate reads as 1.
  const fxFor = db.prepare(
    `SELECT COALESCE(fx.usd_per_unit, 1) AS fx
     FROM securities s LEFT JOIN fx_rates fx ON fx.currency = s.currency
     WHERE s.id = ?`
  );
  const underlyingFxFor = db.prepare(
    `SELECT COALESCE(fx.usd_per_unit, 1) AS fx
     FROM securities su LEFT JOIN fx_rates fx ON fx.currency = su.currency
     WHERE UPPER(su.symbol) = UPPER(?)
     ORDER BY su.id LIMIT 1`
  );

  for (const accountId of scopes) {
    const greeks = computePortfolioGreeks(db, { accountIds: [accountId] });
    for (const pos of greeks.positions) {
      if (!pos.greeks || pos.underlyingPrice <= 0) continue;
      const optionFx = (fxFor.get(pos.securityId) as { fx: number } | undefined)?.fx ?? 1;
      // The security the spot was read from (an issuer sibling when the
      // underlying's own symbol had no close); no such row: the contract's
      // own currency, which is the underlying's in practice.
      const underlyingFx =
        (underlyingFxFor.get(pos.underlyingPriceSource ?? pos.underlying) as { fx: number } | undefined)?.fx ??
        optionFx;
      const exposure =
        pos.greeks.delta * pos.underlyingPrice * pos.multiplier * pos.quantity * underlyingFx;
      map.set(pos.securityId, (map.get(pos.securityId) ?? 0) + exposure);
      const key = holdingKey(accountId, pos.securityId);
      map.byHolding.set(key, (map.byHolding.get(key) ?? 0) + exposure);
      map.rowCount.set(pos.securityId, (map.rowCount.get(pos.securityId) ?? 0) + 1);
      if (!map.perValueDollar.has(pos.securityId) && pos.optionPrice != null && pos.optionPrice > 0 && optionFx > 0) {
        // Δ × S ÷ P, both native: currency-free when the two currencies
        // match (the rates cancel), applied to the row's USD value.
        map.perValueDollar.set(
          pos.securityId,
          (pos.greeks.delta * pos.underlyingPrice * underlyingFx) / (pos.optionPrice * optionFx)
        );
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
 * contract's Greeks can't compute. This reads NO leverage: a leveraged or
 * inverse fund counts here as a plain long. Readers that can select the
 * leverage identity call `resolveHoldingExposure` instead.
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

/**
 * The leverage identity of a holdings row and, for an option, of its
 * underlying (null when there is none). Select it with
 * `LEVERAGE_IDENTITY_COLUMNS_SQL` and `LEVERAGE_UNDERLYING_JOIN_SQL`.
 */
export interface LeverageIdentity {
  name: string | null;
  fund_category: string | null;
  leverage_factor: number | null;
  underlying_security_type: string | null;
  underlying_name: string | null;
  underlying_fund_category: string | null;
  underlying_leverage_factor: number | null;
}

/**
 * Columns for `LeverageIdentity`; `s` is the security, `u` (default `s_u`)
 * its underlying, joined by `leverageUnderlyingJoinSql(u)`. A query that
 * already uses `s_u` for another join passes its own alias.
 */
export function leverageIdentityColumnsSql(u = "s_u"): string {
  return `s.name,
        s.fund_category,
        s.leverage_factor,
        ${u}.security_type AS underlying_security_type,
        ${u}.name AS underlying_name,
        ${u}.fund_category AS underlying_fund_category,
        ${u}.leverage_factor AS underlying_leverage_factor`;
}

/**
 * One underlying row per security (the lowest id holding that symbol), so
 * the join can never duplicate a holdings row.
 */
export function leverageUnderlyingJoinSql(u = "s_u"): string {
  return `LEFT JOIN securities ${u}
        ON ${u}.id = (SELECT MIN(su.id) FROM securities su WHERE su.symbol = s.underlying_symbol)`;
}

export const LEVERAGE_IDENTITY_COLUMNS_SQL = leverageIdentityColumnsSql();
export const LEVERAGE_UNDERLYING_JOIN_SQL = leverageUnderlyingJoinSql();

/**
 * One row's exposure WITH its leverage (owner ruling 2026-11-07,
 * `resolveLeveragedExposure`, the reader the What-if uses):
 *   - not a leveraged or inverse fund, nor an option on one: exactly
 *     `exposureForHolding`;
 *   - a fund with a usable signed factor: its market value times the factor
 *     (a long 3x inverse fund is short three times its money);
 *   - an option on such a fund: its delta exposure times the UNDERLYING's
 *     factor (the delta is in fund-equivalent dollars; the factor turns it
 *     into index-equivalent dollars);
 *   - flagged with NO usable factor: null. Nobody can state its sign or
 *     multiple, so the caller leaves it out of every exposure figure and
 *     counts it — the What-if's stopgap rule (lib/compute/exposure-delta.ts
 *     snapshot(): such a row is out of every bucket and listed as not
 *     modelled).
 */
export function resolveHoldingExposure(
  row: Parameters<typeof exposureForHolding>[0] & LeverageIdentity,
  optionExposures: OptionExposureMap
): number | null {
  const underlying =
    row.underlying_security_type === null && row.underlying_name === null && row.underlying_fund_category === null
      ? null
      : {
          security_type: row.underlying_security_type,
          name: row.underlying_name,
          fund_category: row.underlying_fund_category,
          leverage_factor: row.underlying_leverage_factor,
        };
  const leverage = resolveLeveragedExposure(
    {
      security_type: row.security_type,
      name: row.name,
      fund_category: row.fund_category,
      leverage_factor: row.leverage_factor,
    },
    underlying
  );
  if (leverage.flagged && leverage.factor === null) return null;
  const exposure = exposureForHolding(row, optionExposures);
  return leverage.flagged ? exposure * (leverage.factor as number) : exposure;
}

/** One holdings row as the book-exposure readers select it. */
export type BookExposureRow = Parameters<typeof exposureForHolding>[0] &
  LeverageIdentity & { account_id: number; security_id: number; mv: number };

/**
 * One row's exposure for a WHOLE-BOOK figure (the Diagnostics badge, the
 * Breakdown and the chat options-book tool all read this):
 *   - a cash-equivalent fund (`isCashEquivalentSecurity`) carries ZERO
 *     exposure: its money is in the net-worth base only, like broker cash
 *     (owner ruling 2026-11-15, "cash dilutes, and is never ranked");
 *   - otherwise `resolveHoldingExposure` (leverage-aware; null for a flagged
 *     fund with no usable factor, which the caller leaves out and counts).
 */
export function resolveBookRowExposure(
  row: BookExposureRow,
  optionExposures: OptionExposureMap
): number | null {
  if (isCashEquivalentSecurity(row)) return 0;
  return resolveHoldingExposure(row, optionExposures);
}

export interface BookExposureTotals {
  net: number;
  /** Σ |per-security exposure| (a security held in two accounts nets first). */
  gross: number;
  /** Σ of the positive per-security exposures (>= 0). */
  long: number;
  /** Σ of the negative per-security exposures (<= 0). net = long + short. */
  short: number;
  unmodelledCount: number;
  unmodelledMarketValue: number;
}

/**
 * Net, gross, long and short exposure over a set of rows. Gross nets one
 * security across accounts before |x| (an internally flat contract adds
 * nothing), and does NOT net a stock against its own options (the open
 * "which gross" ruling); long and short are read at the same per-security
 * level, so gross = long - short (to rounding; gross is summed as before).
 */
export function totalBookExposure(
  rows: BookExposureRow[],
  optionExposures: OptionExposureMap
): BookExposureTotals {
  let net = 0;
  const unmodelled = new Set<number>();
  let unmodelledMarketValue = 0;
  const perSecurity = new Map<number, number>();
  for (const row of rows) {
    const exposure = resolveBookRowExposure(row, optionExposures);
    if (exposure === null) {
      unmodelled.add(row.security_id);
      unmodelledMarketValue += row.mv;
      continue;
    }
    net += exposure;
    perSecurity.set(row.security_id, (perSecurity.get(row.security_id) ?? 0) + exposure);
  }
  let gross = 0;
  let long = 0;
  let short = 0;
  for (const exposure of perSecurity.values()) {
    gross += Math.abs(exposure);
    if (exposure > 0) long += exposure;
    else if (exposure < 0) short += exposure;
  }
  return { net, gross, long, short, unmodelledCount: unmodelled.size, unmodelledMarketValue };
}

/**
 * The scope's net worth, the figure the Portfolio strip shows
 * (`getPortfolioCurrentValues(...).totalValue`: live TWS snapshot, else the
 * newest daily valuation, else the newest statement, per account). Null when
 * no account in scope has a value on file, or when an account that holds a
 * position in `rows` has none (the sum would leave that account's money out
 * while its positions are in the exposure).
 */
export function exposureNetWorth(
  db: Database.Database,
  accountIds: number[] | undefined,
  rows: Array<{ account_id: number }>
): number | null {
  const values = getPortfolioCurrentValues(db, accountIds);
  const valued = values.accounts.filter((a) => a.currentValue != null);
  if (valued.length === 0) return null;
  const valuedIds = new Set(valued.map((a) => a.accountId));
  if (rows.some((r) => !valuedIds.has(r.account_id))) return null;
  return values.totalValue;
}

/**
 * The base an exposure share divides by, or null when no share can be
 * printed: net worth missing, zero or negative, or at or under
 * NEAR_NEUTRAL_NET_SHARE of the gross exposure (the What-if's near-neutral
 * share, one constant: a base that small makes every share a multiple of a
 * near-zero number). With no exposure at all a positive base still prints 0.
 */
export function exposureShareBase(netWorth: number | null, grossExposure: number): number | null {
  if (netWorth === null || !(netWorth > 0)) return null;
  if (grossExposure > 0 && netWorth <= NEAR_NEUTRAL_NET_SHARE * grossExposure) return null;
  return netWorth;
}

/** exposure / base, or null when there is no base. The one division. */
export function exposureShare(exposure: number, base: number | null): number | null {
  return base === null ? null : exposure / base;
}

export interface PortfolioExposureSummary {
  /** Σ signed market value of the holdings (no broker cash). Not the base. */
  total_market_value: number;
  /** Σ signed exposure — the effective net long/short in dollars. */
  net_exposure: number;
  /** Σ |per-security exposure| — magnitude of all bets incl. hedges. */
  gross_exposure: number;
  /** Σ positive per-security exposure (>= 0). */
  long_exposure: number;
  /** Σ negative per-security exposure (<= 0); net = long + short, gross = long - short. */
  short_exposure: number;
  /**
   * The ratio base: the scope's net worth, the Portfolio strip's figure
   * (holdings plus broker cash). Null when it is not on file for the scope
   * (`exposureNetWorth`). May be zero or negative; the ratios are then null.
   */
  net_worth: number | null;
  /** net_exposure / net_worth (1.0 = fully invested, unlevered); null with no usable base. */
  net_ratio: number | null;
  /** gross_exposure / net_worth; null with no usable base. */
  gross_ratio: number | null;
  /**
   * Leveraged or inverse funds (and options on them) with no usable signed
   * factor: left out of net and gross (no sign or multiple to apply), still
   * in total_market_value. Distinct securities, and their summed USD value.
   */
  leveraged_unmodelled_count: number;
  leveraged_unmodelled_market_value: number;
}

/**
 * Portfolio-level exposure headline. Same holdings universe as the
 * allocation queries: per-(account, security) latest rows INCLUDING shorts
 * (user decision 2026-07-28 — the prior per-account/no-shorts universe made
 * net == gross == 100% on a book holding shorts, an impossible headline).
 *
 * The ratios divide by NET WORTH, the Portfolio strip's figure (ruling
 * 2026-11-23, reversible): the old base, the signed market value of the
 * holdings, left broker cash out, so a stock-only book read exactly 1.0 and
 * a net-short book flipped sign. Cash-equivalent funds carry no exposure
 * (resolveBookRowExposure). No second copy of the division: the Breakdown
 * and the chat tool read the same helpers.
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
        ${LEVERAGE_IDENTITY_COLUMNS_SQL},
        CASE
          WHEN lp.close_price IS NOT NULL
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
            THEN h.cost_basis * COALESCE(fx.usd_per_unit, 1)
          ELSE 0
        END AS mv
      FROM latest_holdings h
      JOIN securities s ON s.id = h.security_id
      ${LEVERAGE_UNDERLYING_JOIN_SQL}
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      WHERE ${conditions.join(" AND ")}`
    )
    .all(...params) as BookExposureRow[];

  const optionExposures = getOptionExposureMap(db, accountIds);

  // Market value is the plain dollars in the book, leverage or not.
  let totalMv = 0;
  for (const row of rows) totalMv += row.mv;
  const totals = totalBookExposure(rows, optionExposures);
  const netWorth = exposureNetWorth(db, accountIds, rows);
  const base = exposureShareBase(netWorth, totals.gross);

  return {
    total_market_value: totalMv,
    net_exposure: totals.net,
    gross_exposure: totals.gross,
    long_exposure: totals.long,
    short_exposure: totals.short,
    net_worth: netWorth,
    net_ratio: exposureShare(totals.net, base),
    gross_ratio: exposureShare(totals.gross, base),
    leveraged_unmodelled_count: totals.unmodelledCount,
    leveraged_unmodelled_market_value: totals.unmodelledMarketValue,
  };
}

/**
 * Per-reporter family net exposure for the earnings cockpit: for each input
 * symbol, Σ over ALL accounts of (signed stock/fund MV + delta-adjusted
 * option exposure) where the security's symbol OR underlying_symbol is in
 * the issuer family. Shorts stay signed (quantity != 0 predicate). FX via
 * fx_rates. Unheld names → 0. A leveraged or inverse fund counts at its
 * signed factor (resolveHoldingExposure); one with no usable factor is left
 * out of the figure (the record has no place to count it).
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
        ${LEVERAGE_IDENTITY_COLUMNS_SQL},
        CASE
          WHEN lp.close_price IS NOT NULL
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
            THEN h.cost_basis * COALESCE(fx.usd_per_unit, 1)
          ELSE 0
        END AS mv
      FROM latest_holdings h
      JOIN securities s ON s.id = h.security_id
      ${LEVERAGE_UNDERLYING_JOIN_SQL}
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
    } & LeverageIdentity>;

  if (rows.length === 0) return result;

  const optionExposures = getOptionExposureMap(db);
  for (const row of rows) {
    const input = memberToInput.get(row.family_symbol);
    if (!input) continue;
    // A leveraged or inverse fund (or an option on one) with no usable
    // factor has no sign anyone can state: it adds nothing to the family
    // figure (resolveHoldingExposure returns null).
    const exposure = resolveHoldingExposure(row, optionExposures);
    if (exposure !== null) result[input] += exposure;
  }
  return result;
}

/**
 * The position universe every concentration figure in the app is measured
 * over — ONE query, so the Analysis · Diagnostics "Concentration Metrics"
 * card (lib/queries/analysis.ts::getConcentrationMetrics) and the Risk
 * Decomposition "Position Concentration" block
 * (lib/compute/risk.ts::computeConcentration, served by GET
 * /api/compute/risk) can never disagree about the Herfindahl, the effective
 * position count or the top-5 share.
 *
 * qa: analysis-diagnostics--two-herfindahl-values-same-page-regression-3.
 * Before this helper the two cards ran independent SQL over subtly different
 * universes (the risk side dropped unpriced positions and shorts and kept
 * matured bonds), printed two different HHIs on the same page, and therefore
 * two different "Behaves like ~N equal positions" sentences. Rounding
 * discipline could not fix that — only one universe can.
 *
 * Universe rules (the Concentration Metrics card's, promoted to canonical):
 *
 *  - Latest holdings per (account, security) INCLUDING shorts — the same
 *    universe the allocation / exposure / Greeks surfaces use (user decision
 *    2026-07-28; see tests/queries/analysis-full-universe.test.ts). A short
 *    keeps its NEGATIVE market value, but its WEIGHT is gross: weights are
 *    taken over `concentrationGrossValue` (user ruling, decision
 *    2026-09-22), so a short adds size to the book rather than subtracting
 *    from it.
 *  - MATURED securities are excluded: a bond past its maturity date is not a
 *    position any more, whatever row is still sitting in `holdings`.
 *  - An UNPRICED position is carried at its cost basis rather than dropped.
 *    We still own it, and dropping it understates the book (which is what
 *    made the risk card's denominator differ from the card's). A short's
 *    basis is NEGATIVE, so the test is a basis whose sign matches the
 *    quantity's (COST_BASIS_FALLBACK_SQL, fix 12, 2026-11-24): an unpriced
 *    short keeps its sign in `marketValue`, weighs |basis| in the gross
 *    weights, and is marked `priced: false` like an unpriced long. A basis
 *    of the wrong sign is a data error and values the leg 0. As of a past
 *    date, a position with no close yet on that date and no cost basis is
 *    carried at its first later close (marked `valuedAfterAsOf`), for the
 *    same reason: the position count must stay honest.
 *  - Legs of one security held in several accounts are SUMMED into one whole
 *    position before any weight is taken (qa:
 *    analysis-diagnostics--four-different-spy-weights-one-page-regression-2).
 *  - Positions that value to zero (no price AND no cost basis, or a long and
 *    short leg that net out) are dropped: a zero-value row carries no
 *    weight, so it can only inflate a position COUNT. "Zero" is a
 *    sub-half-cent band, not a float equality — cancelling legs land on a
 *    sub-nanodollar residual, never on a bit-exact 0, so `<> 0` let a
 *    netted-out pair through as a live position.
 */

import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { todayET } from "@/lib/calendar/date-utils";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { cashEquivalentSecuritySql } from "@/lib/compute/cash-equivalents";
import { COST_BASIS_FALLBACK_SQL } from "@/lib/compute/exposure";

/**
 * Half a cent. Below this a position is worth nothing a dollar figure could
 * show, so it is a rounding residual rather than a holding.
 */
const ZERO_VALUE_EPSILON = 0.005;

export interface ConcentrationPosition {
  securityId: number;
  symbol: string;
  securityName: string | null;
  /**
   * Adjusted market value in USD — bonds ÷ 100, options × multiplier, FX
   * applied — summed across the accounts in scope. Negative for a short.
   */
  marketValue: number;
  /**
   * true when a stored close price valued every leg of the position; false
   * when the cost-basis fallback (or, as of a past date, a later close)
   * stood in for at least one leg.
   */
  priced: boolean;
  /**
   * As-of snapshots only: true when at least one leg had no close on or
   * before the as-of date and no cost basis, so it was valued at its FIRST
   * close after that date. Such a position was really held then (a position
   * first held on the as-of date, priced a day later); valuing it at 0 dropped
   * it from the snapshot and the week-over-week change read it as new. Always
   * false without an as-of date.
   */
  valuedAfterAsOf: boolean;
  /**
   * true for a cash-equivalent security (money-market sweep fund and the
   * like), decided by `cashEquivalentSecuritySql`, the SQL twin of
   * `isCashEquivalentSecurity`. Owner ruling 2026-11-15: cash STAYS in the
   * book (it is in the weight denominator, so it dilutes concentration) but
   * it is one "Cash and equivalents" line, never a ranked single-name
   * position and never a single-position warning. See
   * `splitConcentrationUniverse`.
   */
  isCashEquivalent: boolean;
}

export interface ConcentrationUniverseOptions {
  /**
   * If set (YYYY-MM-DD), resolve holdings AS OF that date instead of today —
   * used by the week-over-week risk deltas. It also moves the maturity cutoff
   * to that date, so an "as of last week" snapshot still contains a bond that
   * had not matured yet. Validated by latestHoldingsPredicate.
   */
  asOfDate?: string;
}

/**
 * Whole positions, one row per security, ranked by GROSS size — |market
 * value| descending, ties broken by symbol (user ruling, decision
 * 2026-09-22, matching the gross weights). `marketValue` keeps its sign, so
 * a dominant short leads the list AND renders as negative dollars.
 *
 * Callers take weights over `concentrationGrossValue`; nobody re-derives the
 * universe, and nobody re-sorts it — `top_positions`, the Top 10 Positions
 * chart and `top5Positions` are all this order, sliced.
 */
export function getConcentrationUniverse(
  db: Database.Database,
  accountIds?: number[],
  options?: ConcentrationUniverseOptions
): ConcentrationPosition[] {
  // `undefined` is every account; a defined empty list is NO accounts (it
  // must never widen to the whole book).
  if (accountIds && accountIds.length === 0) return [];
  const accountFilter = accountIds
    ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";

  const predicate = latestHoldingsPredicate({
    keyBy: "account_security",
    includeShorts: true,
    asOfDate: options?.asOfDate,
    accountFilter, // already carries its own "AND " prefix when set
  });

  // Params in SQL text order: the account filter lives inside the first CTE,
  // the maturity cutoff in the outer WHERE. The cutoff is resolved HERE, in
  // JS, and ET-anchored: SQLite's `date('now')` is UTC, so between 20:00 ET
  // and midnight UTC it reports tomorrow and drops a bond maturing today out
  // of the book four hours early (project rule: never resolve a user-facing
  // "today" in SQL).
  const maturityCutoff = options?.asOfDate ?? todayET();
  // An as-of snapshot values each position at its newest close ON OR BEFORE
  // that date (as computePositionRisk does): an unbounded latest close put
  // today's prices on last week's holdings (look-ahead). FX stays the
  // current rate: fx_rates keeps one rate per currency, no history.
  const priceBound = options?.asOfDate ? "WHERE date <= ?" : "";
  // The last fallback, as of a past date only: the first close AFTER the date,
  // for a leg with no close on or before it and no cost basis (marked
  // valuedAfterAsOf). Without an as-of date there is no "after": the latest
  // close is already the newest there is, so this CTE is empty.
  const laterPriceCte = options?.asOfDate
    ? `SELECT p.security_id, p.close_price
         FROM prices p
         INNER JOIN (
           SELECT security_id, MIN(date) AS min_date FROM prices WHERE date > ? GROUP BY security_id
         ) fp ON p.security_id = fp.security_id AND p.date = fp.min_date`
    : `SELECT NULL AS security_id, NULL AS close_price WHERE 0`;
  const params: (string | number | null)[] = [
    ...(accountIds ?? []),
    ...(options?.asOfDate ? [options.asOfDate, options.asOfDate] : []),
    maturityCutoff,
  ];

  const rows = db
    .prepare(
      `WITH latest_holdings AS (
         SELECT h.*
         FROM holdings h
         WHERE ${predicate}
       ),
       latest_prices AS (
         SELECT p.security_id, p.close_price
         FROM prices p
         INNER JOIN (
           SELECT security_id, MAX(date) AS max_date FROM prices ${priceBound} GROUP BY security_id
         ) lp ON p.security_id = lp.security_id AND p.date = lp.max_date
       ),
       later_prices AS (
         ${laterPriceCte}
       ),
       per_account_positions AS (
         SELECT
           s.id AS security_id,
           s.symbol,
           s.name AS security_name,
           CASE WHEN ${cashEquivalentSecuritySql("s")} THEN 1 ELSE 0 END AS is_cash,
           CASE
             WHEN lp.close_price IS NOT NULL
               THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
             WHEN ${COST_BASIS_FALLBACK_SQL}
               THEN h.cost_basis * COALESCE(fx.usd_per_unit, 1)
             WHEN fp.close_price IS NOT NULL
               THEN ${adjustedMarketValueSQL("h.quantity", "fp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
             ELSE 0
           END AS market_value,
           CASE WHEN lp.close_price IS NOT NULL THEN 1 ELSE 0 END AS priced,
           CASE
             WHEN lp.close_price IS NULL
              AND NOT ${COST_BASIS_FALLBACK_SQL}
              AND fp.close_price IS NOT NULL
             THEN 1 ELSE 0
           END AS valued_after_as_of
         FROM latest_holdings h
         JOIN securities s ON s.id = h.security_id
         LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
         LEFT JOIN later_prices fp ON fp.security_id = h.security_id
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
         WHERE (s.maturity_date IS NULL OR s.maturity_date >= ?)
           AND ${liveOptionExpirationSql("s", maturityCutoff)}
       )
       SELECT
         security_id,
         symbol,
         security_name,
         SUM(market_value) AS market_value,
         MIN(priced) AS priced,
         MAX(valued_after_as_of) AS valued_after_as_of,
         MAX(is_cash) AS is_cash
       FROM per_account_positions
       GROUP BY security_id, symbol, security_name
       HAVING ABS(SUM(market_value)) > ${ZERO_VALUE_EPSILON}
       -- GROSS rank, to match the gross weights (user ruling, decision
       -- 2026-09-22). Ordering by SIGNED value sank a dominant short to the
       -- bottom of a list headed "Top 10 Positions" while it carried the
       -- single largest weight in the book: top5Concentration then summed
       -- five small longs, and the Risk Decomposition chart's "rest" slice
       -- (1 - top5Concentration) swept the portfolio's biggest position into
       -- the remainder. Symbol breaks ties so the order is deterministic
       -- when a long and a short are the same size.
       --
       -- ABS(SUM(...)), never ABS(market_value): inside an ORDER BY
       -- EXPRESSION, SQLite resolves a bare name against the FROM clause
       -- before the output aliases, so ABS(market_value) would bind to
       -- per_account_positions.market_value — one arbitrary LEG of a
       -- cross-account position, unaggregated under GROUP BY. The signed
       -- ORDER BY market_value DESC this replaced carried the same latent
       -- defect: a security split across two accounts ranked on whichever
       -- leg SQLite happened to pick, not on the whole position.
       ORDER BY ABS(SUM(market_value)) DESC, symbol ASC`
    )
    .all(...params) as Array<{
      security_id: number;
      symbol: string;
      security_name: string | null;
      market_value: number;
      priced: number;
      valued_after_as_of: number;
      is_cash: number;
    }>;

  return rows.map((r) => ({
    securityId: r.security_id,
    symbol: r.symbol,
    securityName: r.security_name,
    marketValue: r.market_value,
    priced: r.priced === 1,
    valuedAfterAsOf: r.valued_after_as_of === 1,
    isCashEquivalent: r.is_cash === 1,
  }));
}

/**
 * GROSS value of the universe — Σ |market value| — and the denominator every
 * concentration weight is taken against. Exported so both call sites divide
 * by the identical figure.
 *
 * User ruling, decision 2026-09-22: the Herfindahl is measured over gross
 * weights, w_i = |mv_i| / Σ |mv_j|.
 *
 * This used to be a SIGNED sum (`concentrationTotalValue`), which is not a
 * usable weight denominator for a book that can hold both directions. A short
 * is negative on both sides of `mv_i / Σ mv_j`: it contributes w² to the index
 * AND shrinks the denominator every other weight is measured against, so the
 * index is unbounded above 1. A long 100 / short −60 pair produced weights of
 * 2.5 and −1.5, a Herfindahl of 8.5, a "behaves like ~0 equal positions"
 * sentence and a ">5% of portfolio" warning reading 250%. Under gross weights
 * the same pair reads (100² + 60²) / 160² = 0.53125, and the index is bounded
 * in (0, 1] for any book.
 *
 * Only the WEIGHT is gross: `ConcentrationPosition.marketValue` keeps its sign,
 * so a short still renders as negative dollars wherever the value itself is
 * shown. No signed-total helper is exported any more — nothing needed one, and
 * a signed "total" sitting next to a gross one is the footgun this ruling
 * closes.
 *
 * Zero only when the universe is empty: every surviving position clears
 * ZERO_VALUE_EPSILON in absolute value. So `<= 0` here is exactly the "no
 * positions to measure" guard both cards draw.
 */
export function concentrationGrossValue(positions: ConcentrationPosition[]): number {
  return positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
}

/**
 * The universe split the way every concentration figure reads it (owner
 * ruling 2026-11-15: cash is protection and flexibility, not a position to
 * leave out or to rank).
 *
 *  - `grossValue` is the WHOLE book, cash included, so every weight is a
 *    share of the whole portfolio and cash dilutes concentration.
 *  - `risky` is every non-cash position, in the universe's own gross order;
 *    only these are ranked, summed into a top-N share or warned about.
 *  - `cash` is ONE bucket: every cash-equivalent holding in scope with a
 *    POSITIVE value, together.
 *  - A cash-equivalent position whose value is NEGATIVE is borrowing (a
 *    debit balance carried as a cash fund), i.e. leverage: it must never
 *    dilute concentration. It is left out of `cash` AND out of `grossValue`
 *    and reported in `negativeCash`, so a card can say borrowed cash is not
 *    counted (review 2026-11-15, R4).
 *  - `herfindahl` is Σ (|mv_i| / grossValue)² over the RISKY positions only
 *    (cash is a riskless bucket and adds nothing to single-name risk), so
 *    more cash lowers the index. It is the single-name risk of an equal,
 *    fully invested book of 1/HHI names. null when there is no risky
 *    position to measure (an empty book, or one that is all cash).
 *  - `investedHerfindahl` is the same sum over the RISKY positions with the
 *    risky positions' own Σ |mv| as the denominator: cash and cash
 *    equivalents left out entirely (owner ruling 28 = B, 2026-11-16). Since
 *    cash dilutes the whole-book index, 1 / herfindahl is no longer a count
 *    of names; 1 / investedHerfindahl is. With no cash the two are equal;
 *    with cash, herfindahl = (risky share)² x investedHerfindahl, so the
 *    whole-portfolio effective count is the larger one. null exactly when
 *    `herfindahl` is null.
 *
 * Both concentration surfaces call this, so they cannot disagree.
 */
export interface ConcentrationSplit {
  grossValue: number;
  risky: ConcentrationPosition[];
  cash: { marketValue: number; weight: number; holdingCount: number };
  /** Cash-equivalent positions valued below zero (borrowing): their summed
   *  (negative) value and count. Not in `cash`, not in `grossValue`. */
  negativeCash: { marketValue: number; holdingCount: number };
  herfindahl: number | null;
  /** Σ (|mv_i| / Σ|risky|)² over the risky positions: the invested-only
   *  index, cash left out of the denominator too. null when `herfindahl` is. */
  investedHerfindahl: number | null;
}

export function splitConcentrationUniverse(positions: ConcentrationPosition[]): ConcentrationSplit {
  const risky = positions.filter((p) => !p.isCashEquivalent);
  const cashRows = positions.filter((p) => p.isCashEquivalent && p.marketValue > 0);
  const borrowedRows = positions.filter((p) => p.isCashEquivalent && p.marketValue < 0);
  const cashMarketValue = cashRows.reduce((s, p) => s + p.marketValue, 0);
  // The whole book less any borrowed cash: Σ |risky| + Σ positive cash,
  // summed in the universe's own order (a book with no borrowed cash keeps
  // the exact figure it had).
  const grossValue = concentrationGrossValue(
    positions.filter((p) => !(p.isCashEquivalent && p.marketValue < 0))
  );
  const herfindahl =
    grossValue > 0 && risky.length > 0
      ? risky.reduce((s, p) => s + (Math.abs(p.marketValue) / grossValue) ** 2, 0)
      : null;
  const investedGross = concentrationGrossValue(risky);
  const investedHerfindahl =
    herfindahl != null && investedGross > 0
      ? risky.reduce((s, p) => s + (Math.abs(p.marketValue) / investedGross) ** 2, 0)
      : null;
  return {
    grossValue,
    risky,
    cash: {
      marketValue: cashMarketValue,
      weight: grossValue > 0 ? cashMarketValue / grossValue : 0,
      holdingCount: cashRows.length,
    },
    negativeCash: {
      marketValue: borrowedRows.reduce((s, p) => s + p.marketValue, 0),
      holdingCount: borrowedRows.length,
    },
    herfindahl,
    investedHerfindahl,
  };
}

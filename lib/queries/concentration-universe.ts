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
 *    made the risk card's denominator differ from the card's).
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
   * when the cost-basis fallback stood in for at least one leg.
   */
  priced: boolean;
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
  const accountFilter =
    accountIds && accountIds.length > 0
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
  const params: (string | number | null)[] = [
    ...(accountIds ?? []),
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
           SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id
         ) lp ON p.security_id = lp.security_id AND p.date = lp.max_date
       ),
       per_account_positions AS (
         SELECT
           s.id AS security_id,
           s.symbol,
           s.name AS security_name,
           CASE
             WHEN lp.close_price IS NOT NULL
               THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
             WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
               THEN h.cost_basis * COALESCE(fx.usd_per_unit, 1)
             ELSE 0
           END AS market_value,
           CASE WHEN lp.close_price IS NOT NULL THEN 1 ELSE 0 END AS priced
         FROM latest_holdings h
         JOIN securities s ON s.id = h.security_id
         LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
         WHERE (s.maturity_date IS NULL OR s.maturity_date >= ?)
       )
       SELECT
         security_id,
         symbol,
         security_name,
         SUM(market_value) AS market_value,
         MIN(priced) AS priced
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
    }>;

  return rows.map((r) => ({
    securityId: r.security_id,
    symbol: r.symbol,
    securityName: r.security_name,
    marketValue: r.market_value,
    priced: r.priced === 1,
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

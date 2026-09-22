/**
 * Drill-down query helper for the P3 Slice C "what's inside this bucket?"
 * surfaces. Returns the holdings that match a discriminated-union filter
 * (classification slice, factor bucket, sector tilt slice, or top-N risk
 * contributors). C2 (DrillDownPanel UI) and C3 (4 trigger surfaces) sit on
 * top of this single query.
 *
 * Per-(account, security) latest-holdings predicate via the shared helper so
 * IBKR intra-day TWS rows don't mask Vanguard statement holdings.
 *
 * Weights are computed against the SCOPE total (not the filtered subset) so a
 * single 8%-of-portfolio Tech position renders as 8% inside the Technology
 * drill-down, not as 100% of "Technology among Tech".
 *
 * `kind: "risk"` is the exception to all of the above: it is a projection of
 * `computePositionRisk` — the same computation behind the Position-Level Risk
 * card and GET /api/compute/position-risk. That call owns the universe (top N
 * by market value, one row per security), the weight, and the ranking
 * metric. That universe is NOT the Concentration chart's — it counts long
 * positions only and requires a stored price (risk contribution needs a
 * return series); matured securities are excluded on BOTH sides since the
 * 2026-09-22 decision — so the two lists legitimately differ and neither
 * surface may claim to be the other. This module only hydrates the display columns and drops
 * cash-equivalent sweeps. See `rankByRiskContribution` below.
 */

import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";
import { BETA_LOOKBACK_DAYS } from "@/lib/queries/security-betas";
import { computePositionRisk, type PositionRisk } from "@/lib/compute/risk";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import {
  classificationGroupSql,
  dimensionInheritsFromUnderlying,
  underlyingInheritJoinSql,
} from "@/lib/queries/analysis";
import {
  isDrillableDimension,
  type DrillableClassificationDimension,
} from "@/lib/analysis/drillable-dimensions";

// Re-exported for back-compat — every existing consumer (AnalysisView.tsx,
// the drill-down API route, DrillDownPanel.tsx) imports this name from here.
// The allowlist itself now lives in lib/analysis/drillable-dimensions.ts (a
// pure module) so the client side can read it without importing this
// DB-touching module.
export type ClassificationDimension = DrillableClassificationDimension;

export type DrillDownFilter =
  | { kind: "classification"; dimension: ClassificationDimension; bucket: string }
  | { kind: "factor"; factor: FactorColumn; bucket: string }
  | { kind: "sector"; sector: string }
  | { kind: "risk"; topN?: number };

export interface DrillDownRow {
  symbol: string;
  securityName: string | null;
  securityId: number;
  marketValue: number;
  /** Fraction of the SCOPE total (not the filtered subset). */
  weight: number;
  /** From `security_betas` at `BETA_LOOKBACK_DAYS`; null if not cached. */
  beta: number | null;
  /** Up to 9 factor columns; missing keys mean no `security_factors` row OR null cell. */
  factors: Partial<Record<FactorColumn, string>>;
  sector: string | null;
  /**
   * Share of portfolio volatility this position accounts for
   * (weight x vol x correlation / portfolio vol), straight from
   * `computePositionRisk`. Populated for `kind: "risk"` only — the other
   * three kinds answer "what is inside this bucket", not "what drives the
   * risk", and leave it undefined. `null` means the position has price
   * history but not enough of it to publish a figure.
   */
  riskContribution?: number | null;
}

// Tag prefix so SQLite column-aliases never collide with reserved tokens.
type FactorAliasKey = `f_${FactorColumn}`;

type Row = {
  security_id: number;
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  fund_category: string | null;
  sector: string | null;
  market_value: number;
  beta: number | null;
} & { [K in FactorAliasKey]: string | null };

/**
 * Get all holdings in a bucket.
 *
 * `scope` is accepted for API-route logging parity but is unused in the SQL;
 * the caller resolves the scope → `accountIds` via `resolveScope` upstream.
 *
 * @param db          better-sqlite3 instance.
 * @param scope       caller-supplied scope label, unused in SQL. Kept for log/log-context parity.
 * @param filter      Which bucket to query (classification | factor | sector | risk).
 * @param accountIds  Resolved account-id whitelist. `undefined` = all accounts.
 */
export function getHoldingsInBucket(
  db: Database.Database,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  scope: string,
  filter: DrillDownFilter,
  accountIds?: number[]
): DrillDownRow[] {
  const accountFilter = accountIds?.length
    ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";
  const accountParams: number[] = accountIds?.length ? [...accountIds] : [];

  let extraWhere = "";
  let underlyingJoin = "";
  const orderBy = "market_value DESC";
  const filterParams: (string | number)[] = [];
  // kind:"risk" only — the ranked positions this call is a projection of.
  // Left null by every other kind.
  let rankedPositions: PositionRisk[] | null = null;

  if (filter.kind === "classification") {
    if (!isDrillableDimension(filter.dimension)) {
      throw new Error(`unknown classification dimension: ${filter.dimension}`);
    }
    // Same GROUP expression the breakdown (getAllocationByDimension) used to
    // produce this label — bucket column AND the option→underlying
    // inheritance CASE — so:
    //   • a NULL/'null' row that rolled up into 'Unclassified'/'Unknown'
    //     filters back in here too, and
    //   • an OPTION the breakdown counted under its UNDERLYING's bucket
    //     (geography 'US' for an INTC LEAP) drills back out of that bucket
    //     instead of hiding under 'Unknown'.
    // The inheritance CASE reads `s_u`, so the matching join is added below
    // for exactly the dimensions that need it.
    // "sector" falls through to the plain `s.sector` column (see
    // classificationBucketSql — the ETF look-through bucketing is a separate
    // path this query doesn't replicate).
    extraWhere = `AND ${classificationGroupSql(filter.dimension)} = ?`;
    underlyingJoin = dimensionInheritsFromUnderlying(filter.dimension)
      ? underlyingInheritJoinSql()
      : "";
    filterParams.push(filter.bucket);
  } else if (filter.kind === "sector") {
    extraWhere = `AND s.sector = ?`;
    filterParams.push(filter.sector);
  } else if (filter.kind === "factor") {
    if (!FACTOR_COLUMNS.includes(filter.factor)) {
      throw new Error(`unknown factor: ${filter.factor}`);
    }
    extraWhere = `AND sf.${filter.factor} = ?`;
    filterParams.push(filter.bucket);
  } else if (filter.kind === "risk") {
    // The universe is decided by computePositionRisk — the SAME call the
    // Position-Level Risk card makes — not by SQL here, so the card, its
    // drawer and the Concentration "Top 10 Positions" chart on the same page
    // can never list different names
    // [qa:analysis-diagnostics--four-different-spy-weights-one-page-regression-4].
    //
    // This replaced an `ORDER BY market_value * COALESCE(beta, 1)` proxy that
    // was neither ranking: an uncached beta silently counted as 1.0, so on the
    // live book two small high-beta names displaced the 7th and 8th largest
    // positions. topN is still clamped to [1, 100] so a caller can't pull the
    // whole table.
    //
    // NOTE on topN semantics (inherited from computePositionRisk, which the
    // card shares): it takes the top N positions BY MARKET VALUE and then
    // ranks those by risk contribution. "Top 10 by risk" is therefore "the 10
    // largest positions, ordered by how much of portfolio volatility each
    // one accounts for" — which is exactly the parity the finding asks for,
    // since the chart's top 10 is value-ranked too. It is NOT "the 10 names
    // with the highest risk contribution portfolio-wide"; a small, wildly
    // volatile position outside the top 10 by value never enters either list.
    const topN = Math.max(1, Math.min(filter.topN ?? 10, 100));
    rankedPositions = computePositionRisk(db, { accountIds, topN }).positions;
    if (rankedPositions.length === 0) return [];
    // Hydrate exactly those securities with the panel's display columns
    // (sector, factors, cached beta). Ordering and the row set come from
    // `rankedPositions` below, not from this SQL.
    extraWhere = `AND s.id IN (${rankedPositions.map(() => "?").join(",")})`;
    filterParams.push(...rankedPositions.map((p) => p.securityId));
  }

  const factorSelect = FACTOR_COLUMNS.map((f) => `sf.${f} AS f_${f}`).join(",\n           ");

  const sql = `
    WITH holdings_cte AS (
      SELECT
        s.id AS security_id,
        s.symbol,
        s.name AS security_name,
        s.security_type,
        s.fund_category,
        s.sector,
        SUM(${adjustedMarketValueSQL("h.quantity", "COALESCE(lp.close_price, 0)", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}) AS market_value,
        sb.beta AS beta,
        ${factorSelect}
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      -- s_u (an option's underlying) only when the bucket expression above
      -- references it. securities.symbol is UNIQUE, so the join is 1:1 and
      -- cannot fan a holding row out into a double-counted market_value.
      ${underlyingJoin}
      LEFT JOIN security_factors sf ON sf.security_id = s.id
      LEFT JOIN security_betas sb ON sb.security_id = s.id AND sb.lookback_days = ${BETA_LOOKBACK_DAYS}
      LEFT JOIN (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (
          SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id
        ) lp ON p.security_id = lp.security_id AND p.date = lp.max_date
      ) lp ON lp.security_id = s.id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      WHERE ${latestHoldingsPredicate({ accountFilter })}
        ${extraWhere}
      -- Aggregate per SECURITY, not per (account, security) row: a name held
      -- in several accounts must appear once with its value summed, or it
      -- both duplicates in the list AND eats two slots in the kind:"risk"
      -- top N (pushing a real single-account contributor out of it).
      -- symbol/name/type/category/sector/beta/factor columns are functionally
      -- dependent on s.id (constant across the grouped rows), so bare-column
      -- selection is safe here.
      --
      -- No close_price > 0 filter: the breakdown row this panel is opened
      -- from (getAllocationByDimension / getSectorAllocationWithLookThrough
      -- in lib/queries/analysis.ts) counts every latest-holdings row
      -- regardless of price presence or sign, falling back to $0 when
      -- unpriced. Filtering here made the panel show FEWER holdings than
      -- the row's own "N positions" count. COALESCE(lp.close_price, 0)
      -- above keeps an unpriced security's market_value at 0 instead of
      -- NULL (rather than replicating analysis.ts's cost_basis fallback,
      -- which this query has never carried).
      GROUP BY s.id
    )
    SELECT * FROM holdings_cte
    ORDER BY ${orderBy}
  `;

  const rows = db.prepare(sql).all(...accountParams, ...filterParams) as Row[];

  // Compute the SCOPE total separately so weights add to 1 across the
  // visible scope, not just the filtered subset.
  const totalRow = db
    .prepare(
      `SELECT SUM(${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}) AS total
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN (
         SELECT p.security_id, p.close_price
         FROM prices p
         INNER JOIN (
           SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id
         ) lp ON p.security_id = lp.security_id AND p.date = lp.max_date
       ) lp ON lp.security_id = s.id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE ${latestHoldingsPredicate({ accountFilter })}
         AND COALESCE(lp.close_price, 0) > 0`
    )
    .get(...accountParams) as { total: number | null };

  const total = totalRow.total ?? 0;

  const mapped = rows.map((r) => ({
    symbol: r.symbol,
    securityName: r.security_name,
    securityId: r.security_id,
    marketValue: r.market_value,
    weight: total > 0 ? r.market_value / total : 0,
    beta: r.beta,
    factors: factorsOf(r),
    sector: r.sector,
  }));

  if (!rankedPositions) return mapped;
  return rankByRiskContribution(mapped, rows, rankedPositions);
}

function factorsOf(r: Row): Partial<Record<FactorColumn, string>> {
  const factors: Partial<Record<FactorColumn, string>> = {};
  for (const f of FACTOR_COLUMNS) {
    const v = r[`f_${f}` as FactorAliasKey];
    if (typeof v === "string" && v) factors[f] = v;
  }
  return factors;
}

/**
 * Turn the hydrated display rows into the "top N by risk" list.
 *
 * Membership and order are owned by `positions` (computePositionRisk's own
 * output), so the drawer is a strict projection of the Position-Level Risk
 * card — never a second, slightly different book:
 *
 *   • `marketValue` and `weight` are taken from the position, not from this
 *     module's SQL. The two universes differ by short legs (the risk engine
 *     counts long positions only), which is enough to render the same ticker
 *     at two different weights on one page
 *     [qa:analysis-diagnostics--four-different-spy-weights-one-page-regression-4].
 *   • Cash-equivalent sweeps drop out entirely — a money-market balance is
 *     not a risk contributor, and ranking by size put it first in a list
 *     titled "by risk"
 *     [qa:analysis-risk-drawer--top10-by-risk-ranked-by-value-vmfxx-first].
 *     The test is IDENTITY (the shared `isCashEquivalentSecurity`), never a
 *     volatility threshold. An earlier version also dropped any position
 *     whose published annualized volatility fell under 0.5%, which silently
 *     deleted a Treasury bill priced near par — a position the
 *     cash-equivalent module explicitly says is NOT cash — while the
 *     caption disclosed only sweeps. A tiny contribution is a fact about
 *     the position, so it renders; only the pinned-price sweep is withheld.
 *   • A position whose volatility is unpublishable for an ordinary reason
 *     (short price history) is likewise KEPT, sorts last on a null
 *     contribution, and renders an em dash. Hiding a real position because
 *     we lack data would be the same silent-omission bug in a new place.
 */
function rankByRiskContribution(
  mapped: DrillDownRow[],
  rows: Row[],
  positions: PositionRisk[]
): DrillDownRow[] {
  const displayById = new Map(mapped.map((m) => [m.securityId, m]));
  const identityById = new Map(rows.map((r) => [r.security_id, r]));

  const ranked: DrillDownRow[] = [];
  for (const position of positions) {
    const identity = identityById.get(position.securityId);
    const isPinnedCash = identity
      ? isCashEquivalentSecurity({
          security_type: identity.security_type,
          fund_category: identity.fund_category,
        })
      : false;
    if (isPinnedCash) continue;

    const display = displayById.get(position.securityId);
    ranked.push({
      symbol: position.symbol,
      securityName: position.securityName,
      securityId: position.securityId,
      marketValue: position.marketValue,
      weight: position.weight,
      beta: display?.beta ?? null,
      factors: display?.factors ?? {},
      sector: display?.sector ?? null,
      riskContribution: position.riskContribution,
    });
  }

  // Highest share of portfolio volatility first; an unpublishable
  // contribution sorts last. `positions` already arrives in market-value
  // order, and Array.prototype.sort is stable, so ties (and the all-null
  // case of a book with no price history) keep that order as the tiebreak.
  return ranked.sort((a, b) => {
    const av = a.riskContribution;
    const bv = b.riskContribution;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });
}

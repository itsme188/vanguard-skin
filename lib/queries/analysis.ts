/**
 * Analysis queries for factor analysis, allocation breakdown, and concentration metrics.
 * Supports classification columns (migration 008) and thematic factors (migration 010).
 */

import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import {
  concentrationGrossValue,
  getConcentrationUniverse,
} from "@/lib/queries/concentration-universe";
import { explodeHoldingBySector } from "@/lib/compute/explode-sector";
import { getEtfSectorWeights } from "@/lib/queries/etf-weights";
import { getOptionExposureMap, exposureForHolding } from "@/lib/compute/exposure";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { marketCapCategoryBucketSql } from "@/lib/securities/normalize-market-cap";
import { normalizeSector } from "@/lib/securities/normalize-sector";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";

// ─── Types ───────────────────────────────────────────────────────

export type AllocationDimension =
  | "fund_category"
  | "geography"
  | "market_cap_category"
  | "style"
  | "sector"
  | "asset_class"
  | "security_type"
  | "credit_rating"
  | "account"
  | "symbol"
  | FactorColumn;

export interface AllocationEntry {
  group_name: string;
  total_market_value: number;
  percentage: number;
  /** Signed delta-adjusted exposure: stocks at MV, options at Δ-notional
   *  (puts negative). See lib/compute/exposure.ts. */
  net_exposure: number;
  /** net_exposure as % of total portfolio MV — same denominator as
   *  `percentage` so the two columns are directly comparable. */
  exposure_pct: number;
  position_count: number;
}

export interface ConcentrationMetrics {
  /**
   * Herfindahl over GROSS weights (decision 2026-09-22): each position's
   * |market value| over the book's Σ |market value|, so the index stays in
   * (0, 1] even when the book carries shorts.
   */
  hhi: number;
  effective_positions: number;
  top_positions: Array<{
    symbol: string;
    security_name: string | null;
    /** SIGNED — a short is worth negative dollars and renders that way. */
    market_value: number;
    /** GROSS share of the book, always >= 0 (decision 2026-09-22). */
    weight_pct: number;
  }>;
  warnings: string[];
}

export interface ClassificationCoverage {
  total: number;
  classified: number;
  unclassified: number;
  coverage_pct: number;
  by_source: Array<{ source: string; count: number }>;
  unclassified_securities: Array<{
    id: number;
    symbol: string;
    name: string | null;
    security_type: string | null;
  }>;
}

export interface AnalysisDataCoverage {
  holdingsTotal: number;
  snapshotTotal: number;
  coveragePct: number;
  missingAccounts: string[];
  holdingsDate: string | null;
  /**
   * True when at least one account in scope is measured OUTSIDE cash: its
   * latest snapshot states a cash balance, so that balance is taken off the
   * snapshot side and cash-equivalent holdings (money-market / sweep funds)
   * are left off the holdings side. Both totals above are then "invested
   * value", not whole-account value.
   */
  cashExcluded: boolean;
  /**
   * `accounts.name` of every account in scope whose latest snapshot does NOT
   * state a cash balance (statement snapshots store NULL). Those accounts are
   * measured on whole value, so a gap there may be cash rather than missing
   * holdings — the banner must say so and never guess.
   */
  unknownCashAccounts: string[];
}

// ─── Latest holdings CTE (reused across queries) ────────────────
// Per-(account, security) incl. shorts — the SAME universe the exposure /
// Greeks surfaces use (user decision 2026-07-28, overruling the earlier
// keyBy:"account" staleness-washing choice). keyBy:"account" dropped any
// security whose newest row predates the account's newest row (live: 4 open
// option positions vanished from allocation while listed two cards below)
// and includeShorts:false dropped real short exposure, producing a false
// "N of N (100%)" coverage badge. Closed positions are excluded by the
// reconcilers' quantity-0 tombstone rows (quantity != 0 in the predicate),
// so per-(account, security) no longer needs the account-date wash.

const LATEST_HOLDINGS_CTE = `
  latest_holdings AS (
    SELECT h.*
    FROM holdings h
    WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
  ),
  latest_prices AS (
    SELECT p.security_id, p.close_price
    FROM prices p
    INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
    ON p.security_id = lp.security_id AND p.date = lp.max_date
  )
`;

/**
 * One holdings row's value in USD — the ONE expression the allocation
 * breakdown, the data-coverage figure and the drill-down panel
 * (lib/queries/drill-down.ts) all read, so a row and the panel it opens can
 * never value a holding two ways. Priced: adjusted market value. Unpriced
 * with a positive cost basis: the cost basis. Otherwise 0.
 * Needs aliases `h` (holdings), `s` (securities), `lp` (latest price) and
 * `fx` (fx_rates) in scope.
 */
export const HOLDING_VALUE_USD_SQL = `CASE
          WHEN lp.close_price IS NOT NULL
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
            THEN h.cost_basis * COALESCE(fx.usd_per_unit, 1)
          ELSE 0
        END`;

/**
 * A bond past its maturity date is no longer a position. Shared with the
 * drill-down so a matured bond leaves the row and its panel together.
 * Needs alias `s` (securities) in scope.
 */
export const UNMATURED_SECURITY_SQL =
  "(s.maturity_date IS NULL OR s.maturity_date >= date('now'))";

/**
 * Split one holding across sectors (explodeHoldingBySector) and MERGE the
 * parts by normalised sector. A fund whose weight rows carry two vendor names
 * for one sector ("Information Technology" and "Technology") is one part of
 * that sector, not two — the row counts it once and the panel lists it once.
 * A stored raw vendor alias on a plain holding lands in the normalised bucket
 * the same way (project rule: never bucket a raw vendor string).
 */
export function explodeHoldingByNormalizedSector(
  symbol: string,
  securityType: string | null,
  marketValue: number,
  weights: Parameters<typeof explodeHoldingBySector>[3],
  ownSector?: string | null
): Array<{ sector: string; value: number }> {
  const merged = new Map<string, number>();
  for (const part of explodeHoldingBySector(symbol, securityType, marketValue, weights, ownSector)) {
    const sector = normalizeSector(part.sector) ?? part.sector;
    merged.set(sector, (merged.get(sector) ?? 0) + part.value);
  }
  return [...merged.entries()].map(([sector, value]) => ({ sector, value }));
}

// ─── Query functions ─────────────────────────────────────────────

/**
 * Get portfolio allocation breakdown by any dimension.
 * Supports new classification columns (fund_category, geography, etc.)
 * plus existing dimensions (sector, asset_class, account, symbol).
 */
/** Check if a dimension is a factor column (needs security_factors JOIN) */
function isFactorDimension(dim: AllocationDimension): dim is FactorColumn {
  return (FACTOR_COLUMNS as readonly string[]).includes(dim);
}

// Single source for the breakdown's per-dimension bucket SQL expression.
// getHoldingsInBucket (lib/queries/drill-down.ts) filters classification
// drill-downs through this SAME expression so a bucket label the breakdown
// produced (e.g. the 'Unclassified' / 'Unknown' NULL-coalesce buckets, or the
// literal-string-"null" guard) always matches back to the rows that made it
// up — a plain `s.<dimension> = ?` filter can never match a NULL or
// literal-'null' row, which opened the drill-down panel empty
// [qa:analysis-drilldown--unclassified-category-row-opens-empty-panel-count-mismatch].
//
// NOTE on "sector": the breakdown's sector bucket (getSectorAllocationWithLookThrough)
// ALSO does ETF look-through — a fund with cached weights splits across real
// GICS sectors it has no OWN sector/fund_category value for at all. This map
// does not attempt to replicate that split (a fund row will not surface under
// one of its look-through sectors here) — see SECTOR_OWN_BUCKET_SQL below for
// the part this map DOES cover: a non-fund holding's (or an unweighted fund's)
// own bucket, including the sector→fund_category fallback.
export const SECTOR_OWN_BUCKET_SQL = `CASE
    WHEN TRIM(COALESCE(s.sector, s.fund_category, '')) != ''
      THEN COALESCE(s.sector, s.fund_category)
    WHEN LOWER(COALESCE(s.security_type, '')) = 'bond' THEN 'Fixed Income'
    ELSE 'Unknown'
  END`;
const CLASSIFICATION_BUCKET_COLUMNS: Partial<Record<AllocationDimension, string>> = {
  fund_category: "COALESCE(s.fund_category, 'Unclassified')",
  // SQL twin of explodeHoldingBySector's non-look-through branch
  // (lib/compute/explode-sector.ts), specifically the `ownSector` decision
  // getSectorAllocationWithLookThrough feeds it via `r.sector ?? r.fund_category`:
  //   JS:  candidate = sector ?? fundCategory   (nullish coalesce — only NULL/
  //                                               undefined fall through; an
  //                                               empty-string sector does NOT
  //                                               fall through to fund_category)
  //        bucket = candidate && candidate.trim() !== "" ? candidate
  //                 : (type === "bond" ? "Fixed Income" : "Unknown")
  //   SQL: COALESCE(sector, fund_category)      (SQLite COALESCE is likewise
  //                                               NULL-only, matching `??`)
  //        TRIM(...) != '' ? that value : bond ? 'Fixed Income' : 'Unknown'
  // No 'null'-literal guard on either side — explode-sector.ts has none, so a
  // security whose sector/fund_category literally reads the string "null"
  // renders (and must drill) as bucket "null", not silently normalized away.
  //
  // Before this, a Treasury (sector NULL, fund_category 'US Treasury') bucketed
  // in the breakdown as "US Treasury" via the fund_category fallback, but
  // getHoldingsInBucket filtered with plain `s.sector = ?` — which a NULL
  // sector can never match — so the drill-down panel opened with 0 holdings
  // for a row the breakdown itself said held several positions
  // [qa:analysis-sector-drilldown--us-treasury-row-8-positions-opens-empty-panel].
  sector: SECTOR_OWN_BUCKET_SQL,
  // NULLIF(...,'null') guards rows where an AI classify pass stored the
  // literal string "null" (prompt enums include a `null` token) — without
  // it the breakdown renders a category row literally labeled "null".
  geography: "COALESCE(NULLIF(s.geography, 'null'), 'Unknown')",
  // The legacy Claude classification fallback wrote bare cap-size labels
  // ("Large"/"Mid"/"Small") while every other source writes the "X Cap"
  // scheme — normalizeMarketCapCategory (lib/securities/normalize-market-cap.ts)
  // fixed the WRITE side, but rows classified before that fix keep their bare
  // label forever (Auto-Classify does not touch already-classified rows).
  // marketCapCategoryBucketSql is the SQL twin of that same normalizer
  // (single-sourced from its ALIASES table) so a legacy "Large" row collapses
  // into the same "Large Cap" bucket a freshly classified row lands in,
  // instead of fragmenting the Allocation donut and the drill-down into two
  // rows for one exposure [qa:analysis-market-cap--duplicate-size-buckets-and-tilts].
  market_cap_category: `COALESCE(NULLIF(${marketCapCategoryBucketSql("s.market_cap_category")}, 'null'), 'Unknown')`,
  style: "COALESCE(NULLIF(s.style, 'null'), 'Unknown')",
  // security_type FIRST: it is the canonical vocabulary (Stock/ETF/Bond/
  // Option/Mutual Fund). The raw-vendor asset_class column carries junk
  // synonyms ('equity', 'STK', 'OPT') that split one asset class across
  // parallel buckets — and 'equity'/'STK' even sit on ETF rows, so they
  // cannot be alias-mapped. asset_class survives only as a fallback for
  // rows with no security_type at all.
  asset_class: "COALESCE(NULLIF(s.security_type, ''), s.asset_class, 'Unknown')",
  security_type: "COALESCE(s.security_type, 'Unknown')",
  credit_rating: "COALESCE(s.credit_rating, 'Unrated')",
  account: "a.name",
  symbol: "s.symbol",
};

/**
 * Return the SQL expression the allocation breakdown uses to bucket a
 * classification dimension, aliased to `alias` (default `s`, the securities
 * table alias both the breakdown and drill-down queries use). Falls back to
 * `<alias>.<dimension>` for "sector" and any dimension with no explicit
 * COALESCE rule (factor columns, which drill-down resolves separately via
 * `security_factors`).
 */
export function classificationBucketSql(
  dimension: AllocationDimension,
  alias = "s"
): string {
  const expr = CLASSIFICATION_BUCKET_COLUMNS[dimension];
  if (!expr) return `${alias}.${dimension}`;
  // The map above is written against alias "s" (the breakdown's own alias).
  // Re-alias only when the caller asked for something else.
  //
  // CAUTION: this blanket `s.` → `<alias>.` rewrite is safe only because the
  // expressions the DRILL-DOWN can reach read the securities row alone. The map
  // also holds dimensions OUTSIDE lib/analysis/drillable-dimensions.ts's
  // DRILLABLE_CLASSIFICATION_DIMENSIONS (the single source drill-down.ts's
  // getHoldingsInBucket AND AnalysisView.tsx's row affordance both read) —
  // `account` (reads `a.name`, needing the accounts join), `credit_rating`
  // and `symbol`. Before widening that allow list, or adding a dimension
  // here whose expression touches another table, give getHoldingsInBucket
  // the matching join first: it composes this expression into its own WHERE
  // clause, where a missing join is a SQL error at best and a
  // silently-wrong bucket at worst.
  return alias === "s" ? expr : expr.replace(/\bs\./g, `${alias}.`);
}

/**
 * Classification dimensions where an OPTION's exposure belongs to its
 * UNDERLYING (an INTC LEAP is semiconductor / US / large-cap exposure, not
 * "Options") — the same inheritance the factor dimensions apply. The option's
 * own value stays the fallback when the underlying is missing or unclassified,
 * so unresolvable options still bucket as 'Options'. asset_class /
 * security_type intentionally keep the Options grouping.
 */
export const UNDERLYING_INHERIT_DIMENSIONS: ReadonlyArray<AllocationDimension> = [
  "fund_category",
  "geography",
  "market_cap_category",
  "style",
];

/** Does this dimension's group expression need the `s_u` (underlying) join? */
export function dimensionInheritsFromUnderlying(dimension: AllocationDimension): boolean {
  return UNDERLYING_INHERIT_DIMENSIONS.includes(dimension);
}

/**
 * The underlying's raw value as read by the inheritance CASE, vocabulary-
 * normalized where a dimension has a SQL twin normalizer. Only
 * market_cap_category has synonym fragmentation today ("Large" vs "Large
 * Cap") — without this, an option inheriting a bare label straight off the
 * underlying's raw column would land in a bucket the breakdown's OWN column
 * (which does normalize) never produces, splitting the option back out into
 * a "Large" row while the stock it tracks sits in "Large Cap".
 */
function normalizedUnderlyingValueSql(
  dimension: AllocationDimension,
  underlyingAlias: string
): string {
  const raw = `${underlyingAlias}.${dimension}`;
  return dimension === "market_cap_category" ? marketCapCategoryBucketSql(raw) : raw;
}

/**
 * The FULL bucket expression the allocation breakdown GROUPs by: the plain
 * `classificationBucketSql` column PLUS the option→underlying inheritance CASE
 * for the dimensions in `UNDERLYING_INHERIT_DIMENSIONS`.
 *
 * Exported — together with `underlyingInheritJoinSql`, which supplies the
 * `s_u` alias it references — because the drill-down filters classification
 * buckets through this SAME expression. Sharing only the bucket half left the
 * two queries disagreeing on OPTIONS: the breakdown counted an INTC LEAP under
 * geography "US" (inherited from INTC) while the drill-down, having no `s_u`
 * join, bucketed it "Unknown" — so drilling "US" came back short by exactly
 * the option rows and "Unknown" listed options the breakdown never put there.
 *
 * NULLIF on the underlying's value mirrors the standardColumns guard: an AI
 * classify pass can store the literal string "null" on the UNDERLYING (e.g.
 * IBIT style), and without it a held option inherits that string as a
 * user-facing bucket label. `normalizedUnderlyingValueSql` additionally
 * vocabulary-normalizes market_cap_category so a bare "Large" underlying
 * still lands in the same "Large Cap" bucket the breakdown's own column
 * produces.
 */
export function classificationGroupSql(
  dimension: AllocationDimension,
  alias = "s",
  underlyingAlias = "s_u"
): string {
  const own = classificationBucketSql(dimension, alias);
  if (!dimensionInheritsFromUnderlying(dimension)) return own;
  return `CASE WHEN LOWER(${alias}.security_type) = 'option'
           THEN COALESCE(NULLIF(${normalizedUnderlyingValueSql(dimension, underlyingAlias)}, 'null'), ${own})
           ELSE ${own} END`;
}

/** The join `classificationGroupSql`'s inheritance CASE needs in scope. */
export function underlyingInheritJoinSql(alias = "s", underlyingAlias = "s_u"): string {
  return `LEFT JOIN securities ${underlyingAlias} ON ${underlyingAlias}.symbol = ${alias}.underlying_symbol`;
}

export function getAllocationByDimension(
  db: Database.Database,
  dimension: AllocationDimension,
  accountIds?: number[]
): AllocationEntry[] {
  // Sector gets ETF look-through (explodeHoldingBySector single source, same
  // as cash-deploy) so all sector surfaces agree — an ETF with cached
  // etf_sector_weights distributes across sectors instead of falling into a
  // single fund_category/Unknown bucket.
  if (dimension === "sector") {
    return getSectorAllocationWithLookThrough(db, accountIds);
  }
  // Option→underlying classification inheritance (and the `s_u` join it
  // needs) lives in classificationGroupSql / underlyingInheritJoinSql above,
  // so the drill-down can compose the IDENTICAL expression.
  const inheritsFromUnderlying = dimensionInheritsFromUnderlying(dimension);

  // For factor dimensions, use COALESCE(direct factor, underlying's factor, 'Unknown')
  const needsFactorJoin = isFactorDimension(dimension);
  const groupExpr = needsFactorJoin
    ? `COALESCE(sf.${dimension}, sf_u.${dimension}, 'Unknown')`
    : classificationGroupSql(dimension);

  const underlyingJoin =
    needsFactorJoin || inheritsFromUnderlying ? underlyingInheritJoinSql() : "";
  const factorJoins = `${underlyingJoin}
    ${
      needsFactorJoin
        ? `LEFT JOIN security_factors sf ON sf.security_id = s.id
           LEFT JOIN security_factors sf_u ON sf_u.security_id = s_u.id`
        : ""
    }`;

  const conditions = [
    UNMATURED_SECURITY_SQL,
    // An option past its ET expiration day is no longer a position.
    liveOptionExpirationSql("s"),
  ];
  const params: (string | number)[] = [];

  if (accountIds && accountIds.length > 0) {
    conditions.push(`h.account_id IN (${accountIds.map(() => "?").join(",")})`);
    params.push(...accountIds);
  }

  // Per-holding rows (not SQL GROUP BY) so each row's delta-adjusted
  // exposure can be resolved in JS — options need Black-Scholes deltas from
  // computePortfolioGreeks, which SQL can't express.
  const rows = db
    .prepare(
      `WITH ${LATEST_HOLDINGS_CTE}
      SELECT
        ${groupExpr} AS group_name,
        s.id AS security_id,
        s.security_type,
        s.option_type,
        ${HOLDING_VALUE_USD_SQL} AS mv
      FROM latest_holdings h
      JOIN accounts a ON a.id = h.account_id
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      ${factorJoins}
      WHERE ${conditions.join(" AND ")}`
    )
    .all(...params) as Array<{
      group_name: string;
      security_id: number;
      security_type: string | null;
      option_type: string | null;
      mv: number;
    }>;

  const optionExposures = getOptionExposureMap(db, accountIds);
  // position_count is DISTINCT securities per bucket: a name held in two
  // accounts is one position, exactly as the drill-down panel lists it.
  const byGroup = new Map<string, { mv: number; exposure: number; securities: Set<number> }>();
  let total = 0;
  for (const row of rows) {
    total += row.mv;
    const exposure = exposureForHolding(row, optionExposures);
    const entry =
      byGroup.get(row.group_name) ?? { mv: 0, exposure: 0, securities: new Set<number>() };
    entry.mv += row.mv;
    entry.exposure += exposure;
    entry.securities.add(row.security_id);
    byGroup.set(row.group_name, entry);
  }

  return [...byGroup.entries()]
    .map(([group_name, { mv, exposure, securities }]) => ({
      group_name,
      total_market_value: mv,
      percentage: total !== 0 ? (mv * 100) / total : 0,
      net_exposure: exposure,
      exposure_pct: total !== 0 ? (exposure * 100) / total : 0,
      position_count: securities.size,
    }))
    .sort((a, b) => b.total_market_value - a.total_market_value);
}

/**
 * Sector allocation with ETF look-through. Pulls per-security rows, then
 * splits each fund's market value across sectors via explodeHoldingBySector
 * (single source — also used by cash-deploy). Funds without cached weights
 * fall back to `sector ?? fund_category` (the pre-look-through COALESCE
 * semantics); sectorless bonds bucket as Fixed Income.
 *
 * position_count is the count of DISTINCT securities with a part in that
 * sector bucket: a name held in two accounts counts once, and a fund's parts
 * are merged by normalised sector first (explodeHoldingByNormalizedSector).
 * A look-through fund still counts once in each sector it contributes to,
 * matching the sector drill-down row list.
 */
function getSectorAllocationWithLookThrough(
  db: Database.Database,
  accountIds?: number[]
): AllocationEntry[] {
  const conditions = [
    UNMATURED_SECURITY_SQL,
    // An option past its ET expiration day is no longer a position.
    liveOptionExpirationSql("s"),
  ];
  const params: (string | number)[] = [];
  if (accountIds && accountIds.length > 0) {
    conditions.push(`h.account_id IN (${accountIds.map(() => "?").join(",")})`);
    params.push(...accountIds);
  }

  const rows = db
    .prepare(
      `WITH ${LATEST_HOLDINGS_CTE}
      SELECT
        s.id AS security_id,
        s.symbol,
        s.security_type,
        s.option_type,
        s.sector,
        s.fund_category,
        ${HOLDING_VALUE_USD_SQL} AS mv
      FROM latest_holdings h
      JOIN accounts a ON a.id = h.account_id
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      WHERE ${conditions.join(" AND ")}`
    )
    .all(...params) as Array<{
      security_id: number;
      symbol: string;
      security_type: string | null;
      option_type: string | null;
      sector: string | null;
      fund_category: string | null;
      mv: number;
    }>;

  const weights = getEtfSectorWeights(db);
  const optionExposures = getOptionExposureMap(db, accountIds);
  const bySector = new Map<
    string,
    { value: number; exposure: number; securities: Set<number> }
  >();
  let total = 0;

  for (const r of rows) {
    total += r.mv;
    const rowExposure = exposureForHolding(r, optionExposures);
    const parts = explodeHoldingByNormalizedSector(
      r.symbol,
      r.security_type,
      r.mv,
      weights,
      r.sector ?? r.fund_category
    );
    for (const part of parts) {
      const entry =
        bySector.get(part.sector) ?? { value: 0, exposure: 0, securities: new Set<number>() };
      entry.value += part.value;
      entry.exposure += r.mv !== 0 ? rowExposure * (part.value / r.mv) : 0;
      entry.securities.add(r.security_id);
      bySector.set(part.sector, entry);
    }
  }

  return [...bySector.entries()]
    .map(([group_name, { value, exposure, securities }]) => ({
      group_name,
      total_market_value: value,
      percentage: total !== 0 ? (value * 100) / total : 0,
      net_exposure: exposure,
      exposure_pct: total !== 0 ? (exposure * 100) / total : 0,
      position_count: securities.size,
    }))
    .sort((a, b) => b.total_market_value - a.total_market_value) as AllocationEntry[];
}

/**
 * Compute portfolio concentration metrics:
 * - HHI (Herfindahl-Hirschman Index): sum of squared position weights
 * - Effective positions: 1/HHI (how many equal-sized positions the portfolio behaves like)
 * - Top 10 positions by market value
 * - Concentration warnings
 */
export function getConcentrationMetrics(
  db: Database.Database,
  accountIds?: number[]
): ConcentrationMetrics {
  // ONE position universe, shared with the Risk Decomposition card
  // (lib/compute/risk.ts::computeConcentration). Both surfaces print a
  // Herfindahl and a "Behaves like ~N equal positions" sentence on the SAME
  // page, so they cannot be allowed to measure over two universes (qa:
  // analysis-diagnostics--two-herfindahl-values-same-page-regression-3).
  // Cross-account legs of one security are already summed into one whole
  // position in there (qa:
  // analysis-diagnostics--four-different-spy-weights-one-page-regression-2).
  const positions = getConcentrationUniverse(db, accountIds);

  // GROSS denominator — Σ |market value| — per user ruling, decision
  // 2026-09-22. A signed denominator let a short shrink the book it was
  // measured against while also adding its own w², which pushed the index
  // above 1 (long 100 / short −60 read 8.5, i.e. "~0 equal positions", and a
  // ">5% of portfolio" warning printed 250%). Gross weights keep the index in
  // (0, 1]. See concentrationGrossValue for the full derivation.
  const grossValue = concentrationGrossValue(positions);

  // <= 0, not === 0: the gross book is zero only when there is nothing to
  // measure, and then there is no weight denominator at all.
  // computeConcentration draws the same line (it returns herfindahl: null
  // there) so neither card ever prints an effective-position count the other
  // one doesn't.
  if (grossValue <= 0) {
    return {
      hhi: 0,
      effective_positions: 0,
      top_positions: [],
      warnings: ["No positions with market value found."],
    };
  }

  // Compute HHI
  let hhi = 0;
  const warnings: string[] = [];

  for (const pos of positions) {
    // |mv| / gross: a short's weight is its SIZE in the book, not a negative
    // share of it (decision 2026-09-22). The warning therefore compares and
    // prints the same gross figure — a 20%-of-book short is a 20% warning,
    // where the signed form skipped it entirely (−0.33 is not > 0.05).
    const weight = Math.abs(pos.marketValue) / grossValue;
    hhi += weight * weight;

    // Single position > 5% warning
    if (weight > 0.05) {
      warnings.push(
        `${pos.symbol} is ${(weight * 100).toFixed(1)}% of portfolio`
      );
    }
  }

  const effective_positions = hhi > 0 ? 1 / hhi : 0;

  // HHI-based warnings
  if (hhi > 0.25) {
    warnings.unshift("Portfolio is highly concentrated (HHI > 0.25)");
  } else if (hhi > 0.15) {
    warnings.unshift("Portfolio is moderately concentrated (HHI > 0.15)");
  }

  // Top 10 positions. The market value keeps its SIGN (a short is worth
  // negative dollars and the chart says so); only the weight is gross
  // (decision 2026-09-22).
  const top_positions = positions.slice(0, 10).map((p) => ({
    symbol: p.symbol,
    security_name: p.securityName,
    market_value: p.marketValue,
    weight_pct: (Math.abs(p.marketValue) / grossValue) * 100,
  }));

  return {
    // Published UNROUNDED. The card renders it with .toFixed(4) and the
    // effective-position sentence divides into it; the Risk Decomposition
    // card renders the same figure with .toFixed(3). Storing a 4-decimal
    // rounding here would make the two cards' 1/HHI disagree at a rounding
    // boundary on a diversified book (an HHI below 0.1 carries only three
    // significant digits at 4dp).
    hhi,
    effective_positions: Math.round(effective_positions * 10) / 10,
    top_positions,
    warnings,
  };
}

/**
 * Get classification coverage statistics.
 * Shows how many securities are classified vs unclassified,
 * broken down by classification source.
 */
export function getClassificationCoverage(
  db: Database.Database,
  accountIds?: number[]
): ClassificationCoverage {
  // Scope to securities with current holdings in the selected accounts
  const holdingsFilter = accountIds && accountIds.length > 0
    ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";
  const holdingsParams = accountIds ?? [];

  const activeSecuritiesCTE = `
    active_securities AS (
      SELECT DISTINCT h.security_id
      FROM holdings h
      WHERE ${latestHoldingsPredicate({ accountFilter: "", includeShorts: true })} ${holdingsFilter}
    )
  `;

  const total = (
    db.prepare(`WITH ${activeSecuritiesCTE}
      SELECT COUNT(*) AS cnt FROM securities s
      WHERE s.id IN (SELECT security_id FROM active_securities)`)
      .get(...holdingsParams) as { cnt: number }
  ).cnt;

  const classified = (
    db.prepare(`WITH ${activeSecuritiesCTE}
      SELECT COUNT(*) AS cnt FROM securities s
      WHERE s.id IN (SELECT security_id FROM active_securities)
        AND s.classification_source IS NOT NULL`)
      .get(...holdingsParams) as { cnt: number }
  ).cnt;

  const bySource = db
    .prepare(
      `WITH ${activeSecuritiesCTE}
       SELECT COALESCE(s.classification_source, 'unclassified') AS source, COUNT(*) AS count
       FROM securities s
       WHERE s.id IN (SELECT security_id FROM active_securities)
       GROUP BY s.classification_source
       ORDER BY count DESC`
    )
    .all(...holdingsParams) as Array<{ source: string; count: number }>;

  const unclassifiedSecurities = db
    .prepare(
      `WITH ${activeSecuritiesCTE}
       SELECT s.id, s.symbol, s.name, s.security_type
       FROM securities s
       WHERE s.id IN (SELECT security_id FROM active_securities)
         AND s.classification_source IS NULL
       ORDER BY s.symbol`
    )
    .all(...holdingsParams) as ClassificationCoverage["unclassified_securities"];

  return {
    total,
    classified,
    unclassified: total - classified,
    coverage_pct: total > 0 ? Math.round((classified / total) * 1000) / 10 : 0,
    by_source: bySource,
    unclassified_securities: unclassifiedSecurities,
  };
}

/**
 * Compare holdings-derived market value against snapshot totals
 * to show how complete the analysis data is.
 */
export function getAnalysisDataCoverage(
  db: Database.Database,
  accountIds?: number[]
): AnalysisDataCoverage {
  const accountFilter =
    accountIds && accountIds.length > 0
      ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
      : "";
  const accountFilterSnap =
    accountIds && accountIds.length > 0
      ? `AND ms.account_id IN (${accountIds.map(() => "?").join(",")})`
      : "";
  const accountParams = accountIds ?? [];

  // ONE basis per account (the two sides must agree on what "cash" is):
  //   • latest snapshot STATES a cash balance (Plaid / TWS) → invested value
  //     on both sides: snapshot total minus cash, and holdings minus
  //     cash-equivalent funds. A Plaid snapshot folds the sweep fund into its
  //     cash balance while the statement's sweep row stays a live holding —
  //     taking cash off the snapshot only let that sweep row stand in for a
  //     genuinely missing position of the same size.
  //   • latest snapshot has NO cash balance (statements store NULL) → we do
  //     not guess: whole value on both sides, every holding counted, and the
  //     account is named in `unknownCashAccounts` so the banner can say the
  //     gap may be cash.
  // Cash-equivalent identity is isCashEquivalentSecurity — never a symbol list.
  // Grouped by (account, identity) so the cash-equivalent test runs in JS on
  // the shared predicate while the sums and the freshness date stay in SQL.
  const holdingRows = db
    .prepare(
      `WITH ${LATEST_HOLDINGS_CTE}
      SELECT
        h.account_id,
        s.security_type,
        s.fund_category,
        COALESCE(SUM(${HOLDING_VALUE_USD_SQL}), 0) AS mv,
        MAX(h.as_of_date) AS latest_date
      FROM latest_holdings h
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      WHERE ${UNMATURED_SECURITY_SQL}
        AND ${liveOptionExpirationSql("s")}
        ${accountFilter}
      GROUP BY h.account_id, s.security_type, s.fund_category`
    )
    .all(...accountParams) as Array<{
      account_id: number;
      security_type: string | null;
      fund_category: string | null;
      mv: number;
      latest_date: string | null;
    }>;

  // Latest snapshot rows per account.
  const snapshotRows = db
    .prepare(
      `SELECT ms.account_id, a.name AS account_name, ms.total_value, ms.cash_value
       FROM monthly_snapshots ms
       JOIN accounts a ON a.id = ms.account_id
       WHERE ms.month_end_date = (
         SELECT MAX(ms2.month_end_date) FROM monthly_snapshots ms2
         WHERE ms2.account_id = ms.account_id
       )
       ${accountFilterSnap}
       ORDER BY a.name`
    )
    .all(...accountParams) as Array<{
      account_id: number;
      account_name: string;
      total_value: number | null;
      cash_value: number | null;
    }>;

  // An account is on the ex-cash basis only when EVERY latest snapshot row it
  // has states a cash balance.
  const cashStated = new Map<number, boolean>();
  const unknownCashAccounts: string[] = [];
  for (const row of snapshotRows) {
    const stated = row.cash_value != null;
    cashStated.set(row.account_id, (cashStated.get(row.account_id) ?? true) && stated);
    if (!stated && !unknownCashAccounts.includes(row.account_name)) {
      unknownCashAccounts.push(row.account_name);
    }
  }
  const exCash = (accountId: number): boolean => cashStated.get(accountId) === true;

  let snapshotTotal = 0;
  for (const row of snapshotRows) {
    const totalValue = row.total_value ?? 0;
    snapshotTotal += exCash(row.account_id) ? totalValue - (row.cash_value ?? 0) : totalValue;
  }

  let holdingsTotal = 0;
  // Freshness of every in-scope holding, cash-equivalent funds included.
  let holdingsDate: string | null = null;
  for (const row of holdingRows) {
    if (row.latest_date != null && (holdingsDate == null || row.latest_date > holdingsDate)) {
      holdingsDate = row.latest_date;
    }
    if (exCash(row.account_id) && isCashEquivalentSecurity(row)) continue;
    holdingsTotal += row.mv;
  }

  // Accounts with snapshots but no holdings
  const missingAccounts = db
    .prepare(
      `SELECT a.name FROM accounts a
       WHERE EXISTS (SELECT 1 FROM monthly_snapshots ms WHERE ms.account_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.account_id = a.id AND h.quantity > 0)
         ${accountIds && accountIds.length > 0 ? `AND a.id IN (${accountIds.map(() => "?").join(",")})` : ""}`
    )
    .all(...accountParams) as Array<{ name: string }>;

  return {
    holdingsTotal,
    snapshotTotal,
    coveragePct:
      snapshotTotal > 0
        ? Math.round((holdingsTotal / snapshotTotal) * 1000) / 10
        : 100,
    missingAccounts: missingAccounts.map((a) => a.name),
    holdingsDate,
    cashExcluded: [...cashStated.values()].some((stated) => stated),
    unknownCashAccounts,
  };
}

// ─── Factor heatmap + coverage ──────────────────────────────────

export interface FactorHeatmapRow {
  symbol: string;
  name: string | null;
  security_type: string | null;
  market_value: number;
  weight_pct: number;
  is_option: boolean;
  interest_rate_sensitive: string | null;
  growth_vs_value: string | null;
  cyclical: string | null;
  international_exposure: string | null;
  geopolitical_onshoring: string | null;
  tariff_exposure: string | null;
  ai_exposure: string | null;
  crypto_adjacent: string | null;
  regulatory_risk: string | null;
  factor_source: string | null;
  /**
   * Classification style (Growth / Value / Blend), the same field the
   * classification Breakdown buckets on; options inherit their underlying's.
   * DISPLAY ONLY: the heatmap shows a third "Blend" bucket from it. It never
   * feeds weights or tilts, which keep reading growth_vs_value.
   */
  style: string | null;
}

export interface FactorCoverage {
  totalHoldings: number;
  withFactors: number;
  coveragePct: number;
  bySource: Array<{ source: string; count: number }>;
}

/**
 * Get all positions with their factor values for the heatmap grid.
 * Options inherit factors from their underlying security.
 */
export function getFactorHeatmap(
  db: Database.Database,
  accountIds?: number[]
): FactorHeatmapRow[] {
  const conditions = [
    "(s.maturity_date IS NULL OR s.maturity_date >= date('now'))",
    liveOptionExpirationSql("s"),
  ];
  const params: (string | number)[] = [];

  if (accountIds && accountIds.length > 0) {
    conditions.push(`h.account_id IN (${accountIds.map(() => "?").join(",")})`);
    params.push(...accountIds);
  }

  // Aggregate by symbol — same security across accounts has identical factors,
  // so we SUM market values and deduplicate to avoid duplicate React keys.
  const rows = db
    .prepare(
      `WITH ${LATEST_HOLDINGS_CTE}
      SELECT
        s.symbol,
        s.name,
        s.security_type,
        s.underlying_symbol,
        SUM(CASE
          WHEN lp.close_price IS NOT NULL
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
            THEN h.cost_basis * COALESCE(fx.usd_per_unit, 1)
          ELSE 0
        END) AS market_value,
        COALESCE(sf.interest_rate_sensitive, sf_u.interest_rate_sensitive) AS interest_rate_sensitive,
        COALESCE(sf.growth_vs_value, sf_u.growth_vs_value) AS growth_vs_value,
        COALESCE(sf.cyclical, sf_u.cyclical) AS cyclical,
        COALESCE(sf.international_exposure, sf_u.international_exposure) AS international_exposure,
        COALESCE(sf.geopolitical_onshoring, sf_u.geopolitical_onshoring) AS geopolitical_onshoring,
        COALESCE(sf.tariff_exposure, sf_u.tariff_exposure) AS tariff_exposure,
        COALESCE(sf.ai_exposure, sf_u.ai_exposure) AS ai_exposure,
        COALESCE(sf.crypto_adjacent, sf_u.crypto_adjacent) AS crypto_adjacent,
        COALESCE(sf.regulatory_risk, sf_u.regulatory_risk) AS regulatory_risk,
        COALESCE(sf.factor_source, sf_u.factor_source) AS factor_source,
        COALESCE(NULLIF(s.style, 'null'), NULLIF(s_u.style, 'null')) AS style
      FROM latest_holdings h
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      LEFT JOIN security_factors sf ON sf.security_id = s.id
      LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
      LEFT JOIN security_factors sf_u ON sf_u.security_id = s_u.id
      WHERE ${conditions.join(" AND ")}
      GROUP BY s.symbol
      ORDER BY market_value DESC`
    )
    .all(...params) as Array<{
      symbol: string;
      name: string | null;
      security_type: string | null;
      underlying_symbol: string | null;
      market_value: number;
      interest_rate_sensitive: string | null;
      growth_vs_value: string | null;
      cyclical: string | null;
      international_exposure: string | null;
      geopolitical_onshoring: string | null;
      tariff_exposure: string | null;
      ai_exposure: string | null;
      crypto_adjacent: string | null;
      regulatory_risk: string | null;
      factor_source: string | null;
      style: string | null;
    }>;

  const totalValue = rows.reduce((sum, r) => sum + r.market_value, 0);

  return rows.map((r) => ({
    symbol: r.symbol,
    name: r.name,
    security_type: r.security_type,
    market_value: r.market_value,
    weight_pct: totalValue > 0 ? (r.market_value / totalValue) * 100 : 0,
    is_option: r.underlying_symbol !== null,
    interest_rate_sensitive: r.interest_rate_sensitive,
    growth_vs_value: r.growth_vs_value,
    cyclical: r.cyclical,
    international_exposure: r.international_exposure,
    geopolitical_onshoring: r.geopolitical_onshoring,
    tariff_exposure: r.tariff_exposure,
    ai_exposure: r.ai_exposure,
    crypto_adjacent: r.crypto_adjacent,
    regulatory_risk: r.regulatory_risk,
    factor_source: r.factor_source,
    style: r.style,
  }));
}

/**
 * Factor coverage: how many current holdings have factor data.
 */
export function getFactorCoverage(
  db: Database.Database,
  accountIds?: number[]
): FactorCoverage {
  const conditions = [
    "(s.maturity_date IS NULL OR s.maturity_date >= date('now'))",
    liveOptionExpirationSql("s"),
  ];
  const params: (string | number)[] = [];

  if (accountIds && accountIds.length > 0) {
    conditions.push(`h.account_id IN (${accountIds.map(() => "?").join(",")})`);
    params.push(...accountIds);
  }

  const row = db
    .prepare(
      `WITH ${LATEST_HOLDINGS_CTE}
      SELECT
        COUNT(DISTINCT s.id) AS total,
        COUNT(DISTINCT CASE WHEN sf.security_id IS NOT NULL OR sf_u.security_id IS NOT NULL THEN s.id END) AS with_factors
      FROM latest_holdings h
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN security_factors sf ON sf.security_id = s.id
      LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
      LEFT JOIN security_factors sf_u ON sf_u.security_id = s_u.id
      WHERE ${conditions.join(" AND ")}`
    )
    .get(...params) as { total: number; with_factors: number };

  // bySource must mirror the header grain: one counted source per HELD
  // security, with options inheriting their underlying's factor source when
  // they have no direct factor row.
  const bySource = db
    .prepare(
      `WITH ${LATEST_HOLDINGS_CTE},
         scoped_security_sources AS (
           SELECT DISTINCT
             s.id AS security_id,
             COALESCE(sf.factor_source, sf_u.factor_source, 'none') AS source,
             CASE WHEN sf.security_id IS NOT NULL OR sf_u.security_id IS NOT NULL THEN 1 ELSE 0 END AS has_factors
           FROM latest_holdings h
           JOIN securities s ON s.id = h.security_id
           LEFT JOIN security_factors sf ON sf.security_id = s.id
           LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
           LEFT JOIN security_factors sf_u ON sf_u.security_id = s_u.id
           WHERE ${conditions.join(" AND ")}
         )
       SELECT source, COUNT(*) AS count
       FROM scoped_security_sources
       WHERE has_factors = 1
       GROUP BY source
       ORDER BY count DESC`
    )
    .all(...params) as Array<{ source: string; count: number }>;

  return {
    totalHoldings: row.total,
    withFactors: row.with_factors,
    coveragePct:
      row.total > 0 ? Math.round((row.with_factors / row.total) * 1000) / 10 : 0,
    bySource,
  };
}

/**
 * Analysis queries for factor analysis, allocation breakdown, and concentration metrics.
 * Supports classification columns (migration 008) and thematic factors (migration 010).
 */

import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";

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
  position_count: number;
}

export interface ConcentrationMetrics {
  hhi: number;
  effective_positions: number;
  top_positions: Array<{
    symbol: string;
    security_name: string | null;
    market_value: number;
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
}

// ─── Latest holdings CTE (reused across queries) ────────────────

const LATEST_HOLDINGS_CTE = `
  latest_holdings AS (
    SELECT h.*
    FROM holdings h
    WHERE h.as_of_date = (
      SELECT MAX(h2.as_of_date) FROM holdings h2
      WHERE h2.account_id = h.account_id
    )
    AND h.quantity > 0
  ),
  latest_prices AS (
    SELECT p.security_id, p.close_price
    FROM prices p
    INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
    ON p.security_id = lp.security_id AND p.date = lp.max_date
  )
`;

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

export function getAllocationByDimension(
  db: Database.Database,
  dimension: AllocationDimension,
  accountIds?: number[]
): AllocationEntry[] {
  // Standard classification columns on the securities table
  const standardColumns: Partial<Record<AllocationDimension, string>> = {
    fund_category: "COALESCE(s.fund_category, 'Unclassified')",
    geography: "COALESCE(s.geography, 'Unknown')",
    market_cap_category: "COALESCE(s.market_cap_category, 'Unknown')",
    style: "COALESCE(s.style, 'Unknown')",
    sector: "COALESCE(s.sector, s.fund_category, 'Unknown')",
    asset_class: "COALESCE(s.asset_class, s.security_type, 'Unknown')",
    security_type: "COALESCE(s.security_type, 'Unknown')",
    credit_rating: "COALESCE(s.credit_rating, 'Unrated')",
    account: "a.name",
    symbol: "s.symbol",
  };

  // For factor dimensions, use COALESCE(direct factor, underlying's factor, 'Unknown')
  const needsFactorJoin = isFactorDimension(dimension);
  const groupExpr = needsFactorJoin
    ? `COALESCE(sf.${dimension}, sf_u.${dimension}, 'Unknown')`
    : standardColumns[dimension]!;

  const factorJoins = needsFactorJoin
    ? `LEFT JOIN security_factors sf ON sf.security_id = s.id
       LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
       LEFT JOIN security_factors sf_u ON sf_u.security_id = s_u.id`
    : "";

  const conditions = [
    "(s.maturity_date IS NULL OR s.maturity_date >= date('now'))",
  ];
  const params: (string | number)[] = [];

  if (accountIds && accountIds.length > 0) {
    conditions.push(`h.account_id IN (${accountIds.map(() => "?").join(",")})`);
    params.push(...accountIds);
  }

  return db
    .prepare(
      `WITH ${LATEST_HOLDINGS_CTE},
      allocation AS (
        SELECT
          ${groupExpr} AS group_name,
          CASE
            WHEN lp.close_price IS NOT NULL
              THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier")}
            WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
              THEN h.cost_basis
            ELSE 0
          END AS mv,
          1 AS cnt
        FROM latest_holdings h
        JOIN accounts a ON a.id = h.account_id
        JOIN securities s ON s.id = h.security_id
        LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
        ${factorJoins}
        WHERE ${conditions.join(" AND ")}
      )
      SELECT
        group_name,
        SUM(mv) AS total_market_value,
        SUM(mv) * 100.0 / NULLIF(SUM(SUM(mv)) OVER (), 0) AS percentage,
        SUM(cnt) AS position_count
      FROM allocation
      GROUP BY group_name
      ORDER BY total_market_value DESC`
    )
    .all(...params) as AllocationEntry[];
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
  const conditions = [
    "(s.maturity_date IS NULL OR s.maturity_date >= date('now'))",
  ];
  const params: (string | number)[] = [];

  if (accountIds && accountIds.length > 0) {
    conditions.push(`h.account_id IN (${accountIds.map(() => "?").join(",")})`);
    params.push(...accountIds);
  }

  // Get all positions with market value
  const positions = db
    .prepare(
      `WITH ${LATEST_HOLDINGS_CTE}
      SELECT
        s.symbol,
        s.name AS security_name,
        s.fund_category,
        CASE
          WHEN lp.close_price IS NOT NULL
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier")}
          WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
            THEN h.cost_basis
          ELSE 0
        END AS market_value
      FROM latest_holdings h
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY market_value DESC`
    )
    .all(...params) as Array<{
      symbol: string;
      security_name: string | null;
      fund_category: string | null;
      market_value: number;
    }>;

  const totalValue = positions.reduce((sum, p) => sum + p.market_value, 0);

  if (totalValue === 0) {
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
    const weight = pos.market_value / totalValue;
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

  // Top 10 positions
  const top_positions = positions.slice(0, 10).map((p) => ({
    symbol: p.symbol,
    security_name: p.security_name,
    market_value: p.market_value,
    weight_pct: (p.market_value / totalValue) * 100,
  }));

  return {
    hhi: Math.round(hhi * 10000) / 10000, // 4 decimal places
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
      WHERE h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id)
        AND h.quantity > 0
        ${holdingsFilter}
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

  // Holdings-derived total
  const holdingsRow = db
    .prepare(
      `WITH ${LATEST_HOLDINGS_CTE}
      SELECT
        COALESCE(SUM(
          CASE
            WHEN lp.close_price IS NOT NULL
              THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier")}
            WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
              THEN h.cost_basis
            ELSE 0
          END
        ), 0) AS total,
        MAX(h.as_of_date) AS latest_date
      FROM latest_holdings h
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      WHERE (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
        ${accountFilter}`
    )
    .get(...accountParams) as { total: number; latest_date: string | null };

  // Snapshot-derived total (latest per account)
  const snapshotRow = db
    .prepare(
      `SELECT COALESCE(SUM(ms.total_value), 0) AS total
       FROM monthly_snapshots ms
       WHERE ms.month_end_date = (
         SELECT MAX(ms2.month_end_date) FROM monthly_snapshots ms2
         WHERE ms2.account_id = ms.account_id
       )
       ${accountFilterSnap}`
    )
    .get(...accountParams) as { total: number };

  // Accounts with snapshots but no holdings
  const missingAccounts = db
    .prepare(
      `SELECT a.name FROM accounts a
       WHERE EXISTS (SELECT 1 FROM monthly_snapshots ms WHERE ms.account_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.account_id = a.id AND h.quantity > 0)
         ${accountIds && accountIds.length > 0 ? `AND a.id IN (${accountIds.map(() => "?").join(",")})` : ""}`
    )
    .all(...accountParams) as Array<{ name: string }>;

  const holdingsTotal = holdingsRow.total;
  const snapshotTotal = snapshotRow.total;

  return {
    holdingsTotal,
    snapshotTotal,
    coveragePct:
      snapshotTotal > 0
        ? Math.round((holdingsTotal / snapshotTotal) * 1000) / 10
        : 100,
    missingAccounts: missingAccounts.map((a) => a.name),
    holdingsDate: holdingsRow.latest_date,
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
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier")}
          WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
            THEN h.cost_basis
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
        COALESCE(sf.factor_source, sf_u.factor_source) AS factor_source
      FROM latest_holdings h
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
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

  const bySource = db
    .prepare(
      `SELECT COALESCE(factor_source, 'none') AS source, COUNT(*) AS count
       FROM security_factors
       GROUP BY factor_source
       ORDER BY count DESC`
    )
    .all() as Array<{ source: string; count: number }>;

  return {
    totalHoldings: row.total,
    withFactors: row.with_factors,
    coveragePct:
      row.total > 0 ? Math.round((row.with_factors / row.total) * 1000) / 10 : 0,
    bySource,
  };
}

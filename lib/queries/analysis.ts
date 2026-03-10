/**
 * Analysis queries for factor analysis, allocation breakdown, and concentration metrics.
 * Supports the new classification columns from migration 008.
 */

import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "@/lib/valuation";

// ─── Types ───────────────────────────────────────────────────────

export type AllocationDimension =
  | "fund_category"
  | "geography"
  | "market_cap_category"
  | "style"
  | "sector"
  | "asset_class"
  | "security_type"
  | "account"
  | "symbol";

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
export function getAllocationByDimension(
  db: Database.Database,
  dimension: AllocationDimension,
  accountId?: number
): AllocationEntry[] {
  const groupColumn: Record<AllocationDimension, string> = {
    fund_category: "COALESCE(s.fund_category, 'Unclassified')",
    geography: "COALESCE(s.geography, 'Unknown')",
    market_cap_category: "COALESCE(s.market_cap_category, 'Unknown')",
    style: "COALESCE(s.style, 'Unknown')",
    sector: "COALESCE(s.sector, s.fund_category, 'Unknown')",
    asset_class: "COALESCE(s.asset_class, s.security_type, 'Unknown')",
    security_type: "COALESCE(s.security_type, 'Unknown')",
    account: "a.name",
    symbol: "s.symbol",
  };

  const groupExpr = groupColumn[dimension];

  const conditions = [
    "(s.maturity_date IS NULL OR s.maturity_date >= date('now'))",
  ];
  const params: (string | number)[] = [];

  if (accountId) {
    conditions.push("h.account_id = ?");
    params.push(accountId);
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
  accountId?: number
): ConcentrationMetrics {
  const conditions = [
    "(s.maturity_date IS NULL OR s.maturity_date >= date('now'))",
  ];
  const params: (string | number)[] = [];

  if (accountId) {
    conditions.push("h.account_id = ?");
    params.push(accountId);
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
  db: Database.Database
): ClassificationCoverage {
  const total = (
    db.prepare("SELECT COUNT(*) AS cnt FROM securities").get() as { cnt: number }
  ).cnt;

  const classified = (
    db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM securities WHERE classification_source IS NOT NULL"
      )
      .get() as { cnt: number }
  ).cnt;

  const bySource = db
    .prepare(
      `SELECT COALESCE(classification_source, 'unclassified') AS source, COUNT(*) AS count
       FROM securities
       GROUP BY classification_source
       ORDER BY count DESC`
    )
    .all() as Array<{ source: string; count: number }>;

  const unclassifiedSecurities = db
    .prepare(
      `SELECT id, symbol, name, security_type
       FROM securities
       WHERE classification_source IS NULL
       ORDER BY symbol`
    )
    .all() as ClassificationCoverage["unclassified_securities"];

  return {
    total,
    classified,
    unclassified: total - classified,
    coverage_pct: total > 0 ? Math.round((classified / total) * 1000) / 10 : 0,
    by_source: bySource,
    unclassified_securities: unclassifiedSecurities,
  };
}

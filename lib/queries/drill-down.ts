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
 */

import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";
import { BETA_LOOKBACK_DAYS } from "@/lib/queries/security-betas";

export type ClassificationDimension =
  | "sector"
  | "fund_category"
  | "geography"
  | "market_cap_category"
  | "style"
  | "asset_class"
  | "security_type";

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
}

const ALLOWED_CLASSIFICATION_DIMENSIONS: ReadonlyArray<ClassificationDimension> = [
  "sector",
  "fund_category",
  "geography",
  "market_cap_category",
  "style",
  "asset_class",
  "security_type",
];

// Tag prefix so SQLite column-aliases never collide with reserved tokens.
type FactorAliasKey = `f_${FactorColumn}`;

type Row = {
  security_id: number;
  symbol: string;
  security_name: string | null;
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
  let orderBy = "market_value DESC";
  const filterParams: (string | number)[] = [];

  if (filter.kind === "classification") {
    if (!ALLOWED_CLASSIFICATION_DIMENSIONS.includes(filter.dimension)) {
      throw new Error(`unknown classification dimension: ${filter.dimension}`);
    }
    // Whitelisted column name → safe to interpolate.
    extraWhere = `AND s.${filter.dimension} = ?`;
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
    // No filter; sort by approximate risk contribution. Caller-tunable topN
    // is clamped to [1, 100] so a malicious caller can't pull the whole table.
    orderBy = "(market_value * COALESCE(beta, 1)) DESC";
  }

  const limitClause =
    filter.kind === "risk"
      ? `LIMIT ${Math.max(1, Math.min(filter.topN ?? 10, 100))}`
      : "";

  const factorSelect = FACTOR_COLUMNS.map((f) => `sf.${f} AS f_${f}`).join(",\n           ");

  const sql = `
    WITH holdings_cte AS (
      SELECT
        s.id AS security_id,
        s.symbol,
        s.name AS security_name,
        s.sector,
        SUM(${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}) AS market_value,
        sb.beta AS beta,
        ${factorSelect}
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
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
        AND COALESCE(lp.close_price, 0) > 0
        ${extraWhere}
      -- Aggregate per SECURITY, not per (account, security) row: a name held
      -- in several accounts must appear once with its value summed, or it
      -- both duplicates in the list AND eats two ranking slots in the
      -- kind:"risk" LIMIT (pushing a real single-account contributor out of
      -- the top N). symbol/name/sector/beta/factor columns are functionally
      -- dependent on s.id (constant across the grouped rows), so bare-column
      -- selection is safe here.
      GROUP BY s.id
    )
    SELECT * FROM holdings_cte
    WHERE market_value > 0
    ORDER BY ${orderBy}
    ${limitClause}
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

  return rows.map((r) => {
    const factors: Partial<Record<FactorColumn, string>> = {};
    for (const f of FACTOR_COLUMNS) {
      const v = r[`f_${f}` as FactorAliasKey];
      if (typeof v === "string" && v) factors[f] = v;
    }
    return {
      symbol: r.symbol,
      securityName: r.security_name,
      securityId: r.security_id,
      marketValue: r.market_value,
      weight: total > 0 ? r.market_value / total : 0,
      beta: r.beta,
      factors,
      sector: r.sector,
    };
  });
}

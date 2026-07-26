import type Database from "better-sqlite3";
import { getDailyValuationsCombined, getDailyValuationsForAccounts } from "@/lib/queries/daily-valuations";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";
import { getFactorHeatmap, type FactorHeatmapRow } from "@/lib/queries/analysis";
import { buildFlowAdjustedIndex, fetchNetFlowsByDate } from "@/lib/compute/flow-adjusted";

// ─── Types ─────────────��────────────────────────────────────────

export interface MarketRegression {
  beta: number;
  alpha: number; // annualized
  rSquared: number;
  trackingError: number; // annualized
  correlation: number;
  dataPoints: number;
}

export interface FactorTilt {
  dimension: string;
  buckets: { label: string; weight: number }[];
}

/**
 * Per-factor macro tilt, used by macro-themes + briefing email to surface
 * "how exposed is the portfolio to factor X". Each factor column in
 * `security_factors` (9 columns: rates / growth_vs_value / cyclical / ...)
 * aggregates per-position weighted exposure into one row of this shape.
 *
 *   exposurePct      0-100. SUM(weight_pct * exposureMultiplier(value)).
 *                    bucketed downstream into low/moderate/high/very-high
 *                    via the macro-themes thresholds.
 *   topContributors  highest weighted-exposure holdings, capped at 5 here
 *                    (consumers typically slice 3). Weight is in pp (0-100).
 */
export interface FactorMacroTilt {
  factor: FactorColumn;
  exposurePct: number;
  topContributors: Array<{ symbol: string; weight: number }>;
}

export interface FactorAnalysisResult {
  marketRegression: MarketRegression | null;
  sizeTilt: FactorTilt | null;
  styleTilt: FactorTilt | null;
  sectorTilt: FactorTilt | null;
  geographyTilt: FactorTilt | null;
  tilts: FactorMacroTilt[];
}

export interface FactorOptions {
  accountId?: number;
  /**
   * Multi-account scope. When set, every sub-computation filters to this set
   * of accounts (regression series summed across them, tilts/heatmap `IN (...)`).
   * Takes precedence over `accountId`. Undefined/empty → whole portfolio.
   */
  accountIds?: number[];
  benchmarkSymbol?: string; // default "SPY"
  /**
   * If set (YYYY-MM-DD), compute tilts against holdings as of that date
   * instead of today. The market regression is unaffected (it operates on
   * daily valuations time-series). See latestHoldingsPredicate for details.
   */
  asOfDate?: string;
}

// ─── Constants ──────────────────��───────────────────────────────

const TRADING_DAYS_PER_YEAR = 252;

/**
 * Normalize the two scope inputs into one optional account-id array.
 * `accountIds` wins; a lone `accountId` becomes a single-element set; neither
 * → undefined (= whole portfolio). Shared by factors + risk.
 */
export function normalizeAccountIds(opts?: {
  accountId?: number;
  accountIds?: number[];
}): number[] | undefined {
  if (opts?.accountIds && opts.accountIds.length > 0) return opts.accountIds;
  if (opts?.accountId !== undefined) return [opts.accountId];
  return undefined;
}

// ─── Market Beta Regression ──────────────────────────���───────────

/**
 * Regress portfolio daily returns against benchmark (SPY) returns.
 * Returns beta, alpha, R², tracking error, and correlation.
 */
function computeMarketRegression(
  db: Database.Database,
  options?: FactorOptions
): MarketRegression | null {
  const benchmarkSymbol = options?.benchmarkSymbol ?? "SPY";

  // 1. Get portfolio daily valuations (summed across the scoped accounts).
  // fullCoverageOnly: account coverage windows differ — without it, an
  // appearing account's whole value reads as a fake return and poisons
  // beta/alpha (the +89% phantom-alpha class; see fullCoverageHaving).
  const accountIds = normalizeAccountIds(options);
  const valuations =
    accountIds && accountIds.length > 0
      ? getDailyValuationsForAccounts(db, accountIds, { fullCoverageOnly: true })
      : getDailyValuationsCombined(db, { fullCoverageOnly: true });

  if (valuations.length < 30) return null;

  // Build date → total_value map
  const portfolioByDate = new Map<string, number>();
  for (const v of valuations) {
    portfolioByDate.set(v.valuation_date, v.total_value);
  }

  // 2. Get benchmark prices
  const benchmarkRows = db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = ?
       ORDER BY date ASC`
    )
    .all(benchmarkSymbol) as { date: string; close_price: number }[];

  if (benchmarkRows.length < 30) return null;

  const benchmarkByDate = new Map<string, number>();
  for (const b of benchmarkRows) {
    benchmarkByDate.set(b.date, b.close_price);
  }

  // 3. Compute aligned daily returns — FLOW-ADJUSTED on the portfolio side.
  // Raw total_value log returns read every deposit/withdrawal as a market
  // move: the live repro showed a -$100k IBKR withdrawal landing as a -20.9%
  // "day", attenuating beta to 0.05 with a fake +63% alpha (2026-07-26 QA
  // finding). Same r_t = (V_t − F_t)/V_{t−1} convention as computeRiskMetrics;
  // flows between aligned dates accumulate into the (prev, curr] window.
  const allDates = [...portfolioByDate.keys()]
    .filter((d) => benchmarkByDate.has(d))
    .sort();

  const alignedSeries = allDates.map((d) => ({
    date: d,
    value: portfolioByDate.get(d)!,
  }));
  const flows =
    alignedSeries.length >= 2
      ? fetchNetFlowsByDate(
          db,
          accountIds,
          alignedSeries[0].date,
          alignedSeries[alignedSeries.length - 1].date
        )
      : [];
  const { returns: adjustedReturns } = buildFlowAdjustedIndex(alignedSeries, flows);

  const dateIndex = new Map(allDates.map((d, i) => [d, i]));
  const portfolioReturns: number[] = [];
  const benchmarkReturns: number[] = [];

  for (const r of adjustedReturns) {
    const i = dateIndex.get(r.date)!;
    const bPrev = benchmarkByDate.get(allDates[i - 1])!;
    const bCurr = benchmarkByDate.get(allDates[i])!;
    if (bPrev > 0 && bCurr > 0) {
      portfolioReturns.push(r.logReturn);
      benchmarkReturns.push(Math.log(bCurr / bPrev));
    }
  }

  if (portfolioReturns.length < 20) return null;

  // 4. Linear regression: Rp = alpha + beta * Rm
  const n = portfolioReturns.length;
  const meanP = portfolioReturns.reduce((s, v) => s + v, 0) / n;
  const meanB = benchmarkReturns.reduce((s, v) => s + v, 0) / n;

  let covPB = 0;
  let varB = 0;
  let varP = 0;

  for (let i = 0; i < n; i++) {
    const dP = portfolioReturns[i] - meanP;
    const dB = benchmarkReturns[i] - meanB;
    covPB += dP * dB;
    varB += dB * dB;
    varP += dP * dP;
  }

  if (varB === 0) return null;

  const beta = covPB / varB;
  const dailyAlpha = meanP - beta * meanB;
  const alpha = dailyAlpha * TRADING_DAYS_PER_YEAR; // annualize

  // R² = correlation²
  const denom = Math.sqrt(varP * varB);
  const correlation = denom > 0 ? covPB / denom : 0;
  const rSquared = correlation * correlation;

  // Tracking error = std dev of (Rp - beta * Rm)
  const residuals = portfolioReturns.map(
    (rp, i) => rp - dailyAlpha - beta * benchmarkReturns[i]
  );
  const residualVar =
    residuals.reduce((s, r) => s + r * r, 0) / (n - 2); // degrees of freedom = n-2
  const trackingError = Math.sqrt(residualVar) * Math.sqrt(TRADING_DAYS_PER_YEAR);

  return {
    beta,
    alpha,
    rSquared,
    trackingError,
    correlation,
    dataPoints: n,
  };
}

// ─── Portfolio Tilts ─────────────────────────────────────────────

function computeTilts(
  db: Database.Database,
  accountIds?: number[],
  asOfDate?: string
): { sizeTilt: FactorTilt | null; styleTilt: FactorTilt | null; sectorTilt: FactorTilt | null; geographyTilt: FactorTilt | null } {
  const accountFilter =
    accountIds && accountIds.length > 0
      ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
      : "";
  const accountParams: number[] = accountIds ?? [];

  const predicate = latestHoldingsPredicate({
    keyBy: "account_security",
    includeShorts: false,
    asOfDate,
    accountFilter, // accountFilter already includes "AND " prefix if set
  });

  const rows = db
    .prepare(
      `WITH latest_holdings AS (
         SELECT h.security_id, SUM(h.quantity) AS total_qty
         FROM holdings h
         WHERE ${predicate}
         GROUP BY h.security_id
       ),
       latest_prices AS (
         SELECT security_id, close_price
         FROM prices
         WHERE (security_id, date) IN (
           SELECT security_id, MAX(date) FROM prices GROUP BY security_id
         )
       )
       SELECT
         s.market_cap_category,
         s.style,
         s.sector,
         s.geography,
         ${adjustedMarketValueSQL("lh.total_qty", "COALESCE(lp.close_price, 0)", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} AS market_value
       FROM latest_holdings lh
       JOIN securities s ON s.id = lh.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE COALESCE(lp.close_price, 0) > 0`
    )
    .all(...accountParams) as {
    market_cap_category: string | null;
    style: string | null;
    sector: string | null;
    geography: string | null;
    market_value: number;
  }[];

  if (rows.length === 0) {
    return { sizeTilt: null, styleTilt: null, sectorTilt: null, geographyTilt: null };
  }

  const totalValue = rows.reduce((s, r) => s + r.market_value, 0);
  if (totalValue <= 0) {
    return { sizeTilt: null, styleTilt: null, sectorTilt: null, geographyTilt: null };
  }

  function buildTilt(
    dimension: string,
    getter: (row: (typeof rows)[0]) => string | null
  ): FactorTilt | null {
    const bucketMap = new Map<string, number>();
    let classified = 0;

    for (const row of rows) {
      const raw = getter(row);
      const label = raw && raw.trim() !== "" ? raw : "Unclassified";
      bucketMap.set(label, (bucketMap.get(label) ?? 0) + row.market_value);
      if (raw && raw.trim() !== "") classified += row.market_value;
    }

    // Don't return tilt if <30% of portfolio is classified
    if (classified / totalValue < 0.3) return null;

    const buckets = [...bucketMap.entries()]
      .map(([label, value]) => ({ label, weight: value / totalValue }))
      .sort((a, b) => b.weight - a.weight);

    return { dimension, buckets };
  }

  return {
    sizeTilt: buildTilt("Size", (r) => r.market_cap_category),
    styleTilt: buildTilt("Style", (r) => r.style),
    sectorTilt: buildTilt("Sector", (r) => r.sector),
    geographyTilt: buildTilt("Geography", (r) => r.geography),
  };
}

// ─── Macro factor tilts (per-factor weighted exposure) ──────────────

/**
 * Map a factor cell value to a 0..1 exposure magnitude.
 *
 * Standard scale (rates/cyclical/tariff/ai/regulatory_risk/etc.):
 *   No=0, Low=0.25, Moderate=0.5, High=0.75, Very High=1.0
 *
 * Non-standard scales (data sampled from live DB 2026-05-11):
 *   growth_vs_value: only "Growth" / "Value" — both classified, direction is
 *                    carried by `theme.direction` in macro-themes consumer.
 *                    Both map to 1.0 ("classified into the growth/value axis").
 *   crypto_adjacent: "Yes" → 1.0; "No" → 0; otherwise standard scale.
 *   international_exposure: "International" → 1.0; otherwise standard scale.
 *
 * Unknown values + null → 0. Anything not explicitly mapped → 0 (silent zero
 * is safer than throwing; classify-factors output is bounded but new values
 * can appear if the AI taxonomy expands).
 */
function exposureMultiplier(value: string | null): number {
  if (!value) return 0;
  switch (value) {
    case "No":
    case "Unknown":
      return 0;
    case "Low":
      return 0.25;
    case "Moderate":
      return 0.5;
    case "High":
      return 0.75;
    case "Very High":
      return 1.0;
    // Non-standard categorical values
    case "Growth":
    case "Value":
    case "Yes":
    case "International":
      return 1.0;
    default:
      return 0;
  }
}

/**
 * Total portfolio weighted exposure to one factor: Σ weight_pct × multiplier
 * over every heatmap row. Single source of truth for "the bucket total" — used
 * by both `computeMacroFactorTilts` (the per-factor tilt total) and
 * `computeSecurityFactorShare` (the denominator of one security's share) so the
 * two paths can't drift.
 */
function factorExposureTotal(
  heatmap: FactorHeatmapRow[],
  factor: FactorColumn
): number {
  return heatmap.reduce((sum, row) => {
    const mult = exposureMultiplier(row[factor] as string | null);
    return sum + (mult > 0 ? row.weight_pct * mult : 0);
  }, 0);
}

/**
 * Per-factor weighted exposure across the portfolio, plus top-5 contributors.
 *
 * Reuses `getFactorHeatmap` (which already computes per-symbol weight_pct +
 * applies options→underlying inheritance) so this stays cheap.
 */
export function computeMacroFactorTilts(
  db: Database.Database,
  options?: FactorOptions
): FactorMacroTilt[] {
  const accountIds = normalizeAccountIds(options);
  const heatmap = getFactorHeatmap(db, accountIds);

  return FACTOR_COLUMNS.map((factor) => {
    const contributors = heatmap
      .map((row) => {
        const mult = exposureMultiplier(row[factor] as string | null);
        return mult > 0
          ? { symbol: row.symbol, weight: row.weight_pct * mult }
          : null;
      })
      .filter((x): x is { symbol: string; weight: number } => x !== null)
      .sort((a, b) => b.weight - a.weight);

    return {
      factor,
      exposurePct: factorExposureTotal(heatmap, factor),
      topContributors: contributors.slice(0, 5),
    };
  });
}

// ─── Per-security factor share (Security Detail · Block 3) ───────────

/**
 * How much of the WHOLE portfolio's exposure to a factor one security accounts
 * for. Powers Block 3 of the Security Detail Factor Profile.
 *
 *   securityContribution  this security's weighted exposure (weight_pct × mult), in pp.
 *   bucketTotalExposure   the portfolio-wide total for that factor (== the
 *                         `exposurePct` from computeMacroFactorTilts, by shared helper).
 *   sharePct              securityContribution / bucketTotalExposure × 100 (0..100).
 *   deltaPp               first-order pp the bucket total drops if this position is
 *                         fully sold (== securityContribution; matches how exposurePct
 *                         is defined — ignores re-weighting of the remaining names).
 */
export interface FactorShareEntry {
  factor: FactorColumn;
  value: string;
  securityContribution: number;
  bucketTotalExposure: number;
  sharePct: number;
  deltaPp: number;
}

/**
 * For each factor where `securityId` has an active (multiplier > 0)
 * classification, compute its share of the portfolio's exposure to that factor.
 *
 * Built on `getFactorHeatmap` — no new latest-holdings SQL, so it inherits the
 * canonical per-(account, security) CTE + options→underlying inheritance and
 * ties out with the Analysis Factor Exposure view by construction.
 *
 * `accountIds` defaults to undefined (= whole portfolio); the Security Detail
 * page has no scope selector and the question is inherently portfolio-wide.
 * Returns [] when the security is unknown or not held in scope.
 */
export function computeSecurityFactorShare(
  db: Database.Database,
  securityId: number,
  accountIds?: number[]
): FactorShareEntry[] {
  const sec = db
    .prepare(`SELECT symbol, underlying_symbol FROM securities WHERE id = ?`)
    .get(securityId) as
    | { symbol: string; underlying_symbol: string | null }
    | undefined;
  if (!sec) return [];

  const heatmap = getFactorHeatmap(db, accountIds);
  if (heatmap.length === 0) return [];

  // The heatmap is keyed by the security's OWN symbol (options included, with
  // factors inherited from the underlying). Match own symbol first; fall back
  // to the underlying symbol for the rare case an option isn't its own row.
  const norm = (s: string) => s.trim().toUpperCase();
  let row = heatmap.find((r) => norm(r.symbol) === norm(sec.symbol));
  if (!row && sec.underlying_symbol) {
    const underlying = sec.underlying_symbol;
    row = heatmap.find((r) => norm(r.symbol) === norm(underlying));
  }
  if (!row) return [];

  const entries: FactorShareEntry[] = [];
  for (const factor of FACTOR_COLUMNS) {
    const value = row[factor] as string | null;
    const mult = exposureMultiplier(value);
    if (mult <= 0) continue; // skips null / "Unknown" / "No"

    const securityContribution = row.weight_pct * mult;
    const bucketTotalExposure = factorExposureTotal(heatmap, factor);
    const sharePct =
      bucketTotalExposure > 0
        ? (securityContribution / bucketTotalExposure) * 100
        : 0;

    entries.push({
      factor,
      value: value as string,
      securityContribution,
      bucketTotalExposure,
      sharePct,
      deltaPp: securityContribution,
    });
  }

  return entries.sort((a, b) => b.sharePct - a.sharePct);
}

// ─── Main entry point ───────────────────��────────────────────────

export function computeFactorAnalysis(
  db: Database.Database,
  options?: FactorOptions
): FactorAnalysisResult {
  const accountIds = normalizeAccountIds(options);
  const marketRegression = computeMarketRegression(db, options);
  const { sizeTilt, styleTilt, sectorTilt, geographyTilt } = computeTilts(
    db,
    accountIds,
    options?.asOfDate
  );
  const tilts = computeMacroFactorTilts(db, options);

  return { marketRegression, sizeTilt, styleTilt, sectorTilt, geographyTilt, tilts };
}

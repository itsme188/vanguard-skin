import type Database from "better-sqlite3";
import {
  commonCoverageStart,
  getDailyValuationsCombined,
  getDailyValuationsForAccounts,
} from "@/lib/queries/daily-valuations";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { normalizeAccountIds } from "@/lib/compute/factors";
import { buildFlowAdjustedIndex, fetchNetFlowsByDate, fetchAnchorSourceSeamDates } from "@/lib/compute/flow-adjusted";
import { calendarDaysBetween } from "@/lib/calendar/date-utils";

// Drop per-position return pairs whose dates straddle a multi-week hole. The
// prices table mixes sparse month-end statement anchors with dense daily TWS
// rows, so an adjacent pair can span a months-long gap and inject a spurious
// single-period return that inflates volatility/correlation (the same root
// cause as the beta gap bug). 7 days tolerates weekends + holidays + a missed
// day or two; larger is a discontinuity, not a real return.
const MAX_RETURN_GAP_DAYS = 7;

// Sibling of the gap guard: drop per-position return pairs that carry an
// unadjusted stock-split signature. Vendor daily rows are not back-adjusted
// when a split lands (VGT's 8:1 printed an exact -87.5% "daily return" and a
// 407% volatility), so a pair qualifies only when it is SPLIT-SHAPED — the
// price ratio sits within tolerance of an integer multiple >= 2 in either
// direction. Magnitude alone never qualifies: a genuine -30% crash day stays.
const SPLIT_MIN_MULTIPLE = 2;
const SPLIT_MAX_MULTIPLE = 100;
const SPLIT_RATIO_TOLERANCE = 0.02;

export function isSplitSignatureReturnPair(prev: number, curr: number): boolean {
  if (!(prev > 0) || !(curr > 0)) return false;
  const ratio = prev > curr ? prev / curr : curr / prev;
  const nearest = Math.round(ratio);
  if (nearest < SPLIT_MIN_MULTIPLE || nearest > SPLIT_MAX_MULTIPLE) return false;
  return Math.abs(ratio - nearest) <= nearest * SPLIT_RATIO_TOLERANCE;
}

// ─── Types ──────────────────────────────────────────────────────

export interface DrawdownInfo {
  percent: number;
  peakDate: string;
  troughDate: string;
  peakValue: number;
  troughValue: number;
  // Net external flows (deposits positive, withdrawals negative) that landed
  // in (peakDate, troughDate] — see the comment above the raw-dollar overlay
  // in computeRiskMetrics for why this bridging term exists.
  netFlowsInWindow: number;
}

export interface CurrentDrawdownInfo {
  percent: number;
  peakDate: string;
  peakValue: number;
  currentValue: number;
  // Net external flows (deposits positive, withdrawals negative) that landed
  // in (peakDate, seriesEnd] — see the comment above the raw-dollar overlay
  // in computeRiskMetrics for why this bridging term exists.
  netFlowsInWindow: number;
}

// Internal shapes returned by the flow-adjusted-index-only drawdown finders,
// before the raw-dollar overlay (peakValue/troughValue/netFlowsInWindow) is
// attached in computeRiskMetrics.
type DrawdownCore = Omit<DrawdownInfo, "netFlowsInWindow">;
type CurrentDrawdownCore = Omit<CurrentDrawdownInfo, "netFlowsInWindow">;

export interface PositionWeight {
  symbol: string;
  securityName: string | null;
  marketValue: number;
  weight: number; // 0-1
}

export interface PortfolioRiskMetrics {
  maxDrawdown: DrawdownInfo | null;
  currentDrawdown: CurrentDrawdownInfo | null;
  volatility: number | null; // annualized
  sharpeRatio: number | null; // null if < 30 days of data
  riskFreeRate: number; // annualized decimal (e.g. 0.0368 = 3.68%)
  herfindahl: number | null; // 0-1 (1 = single position)
  top5Concentration: number; // 0-1
  top5Positions: PositionWeight[];
  positionCount: number;
  dataPoints: number; // number of daily valuations used
  /** Anchor-source seam days bridged out of the return stream (see
   *  fetchAnchorSourceSeamDates) — 0 on seam-free series. Quantifies
   *  observations discarded as zero-information source-transition days. */
  seamDaysBridged: number;
  // Actual window of the valuation series the metrics were computed from.
  // daily_valuations history starts 2026-03 (full-coverage floor ~2026-04-06),
  // so a requested 3Y/All period computes over a much shorter window — the UI
  // uses these to caption the metrics honestly instead of implying the label's
  // period. Null when no valuations matched.
  seriesStart: string | null;
  seriesEnd: string | null;
}

export interface RiskOptions {
  startDate?: string;
  endDate?: string;
  accountId?: number;
  /**
   * Multi-account scope. When set, valuations are summed across this account
   * set and concentration filters to it. Takes precedence over `accountId`.
   * Undefined/empty → whole portfolio.
   */
  accountIds?: number[];
  riskFreeRate?: number; // annualized; if omitted, reads FRED DGS3MO from settings cache
  /**
   * If set (YYYY-MM-DD), compute concentration metrics against holdings as
   * of that date instead of today. The drawdown, volatility, and Sharpe ratio
   * are unaffected (they operate on daily valuations time-series, not
   * point-in-time holdings). This param affects only the Herfindahl and
   * top-5 concentration computed by computeConcentration().
   */
  asOfDate?: string;
}

export interface PositionRisk {
  securityId: number;
  symbol: string;
  securityName: string | null;
  weight: number;
  annualizedVol: number | null;
  riskContribution: number | null; // marginal contribution to portfolio vol
  correlationWithPortfolio: number | null;
  dataPoints: number;
}

export interface CorrelationEntry {
  symbolA: string;
  symbolB: string;
  correlation: number;
}

export interface PositionRiskResult {
  positions: PositionRisk[];
  correlations: CorrelationEntry[];
  portfolioVol: number | null;
}

// ─── Constants ──────────────────────────────────────────────────

const TRADING_DAYS_PER_YEAR = 252;

// Minimum daily-return observations before a position's vol/correlation/risk-
// contribution is trusted. Below this floor, computePositionRisk nulls out
// the position's own row (see step 5) AND excludes it from the basket
// aggregate + its renormalization weight (see step 4) — a thinly-traded
// position (e.g. an option with 17 daily closes) must not feed the headline
// "Portfolio Vol" while its own table row renders "—".
const MIN_POSITION_OBSERVATIONS = 20;

// ─── Core computation ───────────────────────────────────────────

export function computeRiskMetrics(
  db: Database.Database,
  options?: RiskOptions
): PortfolioRiskMetrics {
  // Risk-free rate flows from FRED's DGS3MO via the settings cache; falls
  // back to 0.045 if never fetched. See lib/queries/risk-free-rate.ts.
  const riskFreeRate = options?.riskFreeRate ?? getRiskFreeRate(db);
  const accountIds = normalizeAccountIds(options);

  // 1. Get daily valuations (summed across the scoped accounts).
  // fullCoverageOnly: an account whose coverage starts mid-window would sum
  // in as a fake +100% "day" — a coverage artifact, not a market move, and
  // not an external flow either, so the flow-adjustment below can't
  // neutralize it (see fullCoverageHaving in lib/queries/daily-valuations).
  //
  // SCOPE-INVARIANT WINDOW: fullCoverageOnly calibrates against the REQUESTED
  // account set, so each scope would otherwise start at its own coverage
  // onset (live DB: ibkr 2024-12-31, vanguard 2026-03-27, all 2026-04-06) —
  // and the All-Accounts vol card compared against per-account vols measured
  // over different periods (it read LOWER than every constituent, which looks
  // impossible). Flooring at commonCoverageStart makes every scope measure the
  // same period. The floor only ever moves the start LATER: an explicitly
  // requested startDate inside the common window still wins.
  const startDate = laterDate(options?.startDate, commonCoverageStart(db));
  const valuations =
    accountIds && accountIds.length > 0
      ? getDailyValuationsForAccounts(db, accountIds, {
          startDate,
          endDate: options?.endDate,
          fullCoverageOnly: true,
        })
      : getDailyValuationsCombined(db, {
          startDate,
          endDate: options?.endDate,
          fullCoverageOnly: true,
        });

  // 2. Compute drawdown and return metrics from a FLOW-ADJUSTED return index,
  // never the raw value series. A withdrawal/deposit changes account value
  // without being a market move — computing drawdown/Sharpe on raw values
  // turns a $100k withdrawal into a fake -19% "day" (the 2026-06-10 IBKR
  // 23%-drawdown bug). Same flow rows (is_external_flow=1) the TWR engine uses.
  const points = valuations.map(v => ({ date: v.valuation_date, value: v.total_value }));
  const flows =
    points.length >= 2
      ? fetchNetFlowsByDate(db, accountIds, points[0].date, points[points.length - 1].date)
      : [];
  const seamDates =
    points.length >= 2
      ? fetchAnchorSourceSeamDates(db, accountIds, points[0].date, points[points.length - 1].date)
      : [];
  const { index, returns, bridgedDays } = buildFlowAdjustedIndex(points, flows, seamDates);
  const logReturns = returns.map((r) => r.logReturn);

  const rawValueByDate = new Map(points.map(p => [p.date, p.value]));
  const maxDrawdownIdx = computeMaxDrawdown(index);
  // Percent + dates come from the flow-adjusted index; the dollar fields keep
  // reporting the actual account value on those dates (what the user can see
  // on a statement), so they intentionally don't ratio back to `percent`.
  // `netFlowsInWindow` is the bridging term: it's the net external flow
  // (deposits positive, withdrawals negative) that landed between peak and
  // trough, which is exactly what makes peakValue/troughValue look
  // inconsistent with `percent` when nonzero (e.g. a deposit mid-drawdown can
  // push troughValue above peakValue even though the market itself fell) —
  // surfacing it lets the UI overlay stay self-consistent instead of silently
  // contradicting itself.
  const maxDrawdown = maxDrawdownIdx
    ? {
        ...maxDrawdownIdx,
        peakValue: rawValueByDate.get(maxDrawdownIdx.peakDate) ?? maxDrawdownIdx.peakValue,
        troughValue: rawValueByDate.get(maxDrawdownIdx.troughDate) ?? maxDrawdownIdx.troughValue,
        netFlowsInWindow: sumFlowsInWindow(flows, maxDrawdownIdx.peakDate, maxDrawdownIdx.troughDate),
      }
    : null;
  const currentDrawdownIdx = computeCurrentDrawdown(index);
  // A non-null currentDrawdownIdx implies index.length >= 2 (computeCurrentDrawdown's
  // own guard), and index.length === points.length, so points[points.length - 1]
  // is safe here even though `points` can be empty in the null branch.
  const currentDrawdown = currentDrawdownIdx
    ? {
        ...currentDrawdownIdx,
        peakValue: rawValueByDate.get(currentDrawdownIdx.peakDate) ?? currentDrawdownIdx.peakValue,
        currentValue: points[points.length - 1].value,
        netFlowsInWindow: sumFlowsInWindow(flows, currentDrawdownIdx.peakDate, points[points.length - 1].date),
      }
    : null;
  const { volatility, sharpeRatio } = computeVolatility(logReturns, points.length, riskFreeRate);

  // 3. Compute concentration from current holdings
  const { herfindahl, top5Concentration, top5Positions, positionCount } =
    computeConcentration(db, accountIds, options?.asOfDate);

  return {
    maxDrawdown,
    currentDrawdown,
    volatility,
    sharpeRatio,
    riskFreeRate,
    herfindahl,
    top5Concentration,
    top5Positions,
    positionCount,
    dataPoints: valuations.length,
    seriesStart: points.length > 0 ? points[0].date : null,
    seriesEnd: points.length > 0 ? points[points.length - 1].date : null,
    seamDaysBridged: bridgedDays,
  };
}

/**
 * Later of two optional YYYY-MM-DD dates (lexicographic compare is
 * chronological for this format). Undefined/null operands drop out, so
 * `laterDate(undefined, floor)` is the floor and `laterDate(x, null)` is x.
 */
function laterDate(
  a: string | null | undefined,
  b: string | null | undefined
): string | undefined {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return a > b ? a : b;
}

// External cash-flow adjustment (fetchNetFlowsByDate + buildFlowAdjustedIndex)
// moved to lib/compute/flow-adjusted.ts — shared with computeMarketRegression.

/**
 * Sum net external flows (fetchNetFlowsByDate rows) that landed strictly
 * after `startExclusive` and on/before `endInclusive` — same end-of-day
 * convention as fetchNetFlowsByDate/buildFlowAdjustedIndex (a flow dated on a
 * boundary date is attributed to that date's value).
 */
function sumFlowsInWindow(
  flows: { date: string; net: number }[],
  startExclusive: string,
  endInclusive: string
): number {
  return flows.reduce(
    (sum, f) => (f.date > startExclusive && f.date <= endInclusive ? sum + f.net : sum),
    0
  );
}

// ─── Max Drawdown ───────────────────────────────────────────────

function computeMaxDrawdown(
  series: { date: string; value: number }[]
): DrawdownCore | null {
  if (series.length < 2) return null;

  let peak = series[0].value;
  let peakDate = series[0].date;
  let maxDd = 0;
  let maxDdPeakDate = series[0].date;
  let maxDdPeakValue = series[0].value;
  let maxDdTroughDate = series[0].date;
  let maxDdTroughValue = series[0].value;

  for (const point of series) {
    if (point.value > peak) {
      peak = point.value;
      peakDate = point.date;
    }
    const dd = peak > 0 ? (peak - point.value) / peak : 0;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPeakDate = peakDate;
      maxDdPeakValue = peak;
      maxDdTroughDate = point.date;
      maxDdTroughValue = point.value;
    }
  }

  if (maxDd === 0) return null;

  return {
    percent: maxDd,
    peakDate: maxDdPeakDate,
    troughDate: maxDdTroughDate,
    peakValue: maxDdPeakValue,
    troughValue: maxDdTroughValue,
  };
}

// ─── Current Drawdown ───────────────────────────────────────────

function computeCurrentDrawdown(
  series: { date: string; value: number }[]
): CurrentDrawdownCore | null {
  if (series.length < 2) return null;

  let peak = 0;
  let peakDate = series[0].date;

  for (const point of series) {
    if (point.value > peak) {
      peak = point.value;
      peakDate = point.date;
    }
  }

  const current = series[series.length - 1].value;
  const dd = peak > 0 ? (peak - current) / peak : 0;

  if (dd === 0) return null;

  return {
    percent: dd,
    peakDate,
    peakValue: peak,
    currentValue: current,
  };
}

// ─── Volatility & Sharpe ────────────────────────────────────────

function computeVolatility(
  returns: number[],
  seriesLength: number,
  riskFreeRate: number
): { volatility: number | null; sharpeRatio: number | null } {
  // `returns` are flow-adjusted daily log returns (see buildFlowAdjustedIndex).
  if (seriesLength < 30) return { volatility: null, sharpeRatio: null };

  if (returns.length < 20) return { volatility: null, sharpeRatio: null };

  // Mean daily return
  const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;

  // Standard deviation of daily returns
  const variance =
    returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1);
  const dailyStdDev = Math.sqrt(variance);

  // Annualize
  const volatility = dailyStdDev * Math.sqrt(TRADING_DAYS_PER_YEAR);
  const annualizedReturn = meanReturn * TRADING_DAYS_PER_YEAR;

  // Sharpe ratio
  const sharpeRatio =
    volatility > 0 ? (annualizedReturn - riskFreeRate) / volatility : null;

  return { volatility, sharpeRatio };
}

// ─── Concentration (Herfindahl & Top-5) ─────────────────────────

function computeConcentration(
  db: Database.Database,
  accountIds?: number[],
  asOfDate?: string
): {
  herfindahl: number | null;
  top5Concentration: number;
  top5Positions: PositionWeight[];
  positionCount: number;
} {
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

  // Get latest holdings with current prices, compute market value
  const rows = db
    .prepare(
      `WITH latest_holdings AS (
         SELECT h.security_id, h.account_id, h.quantity, s.symbol, s.name, s.security_type,
                COALESCE(s.multiplier, 1) AS multiplier, s.currency
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         WHERE ${predicate}
       ),
       latest_prices AS (
         SELECT security_id, close_price
         FROM prices p
         WHERE (security_id, date) IN (
           SELECT security_id, MAX(date) FROM prices GROUP BY security_id
         )
       )
       SELECT
         lh.symbol,
         lh.name AS security_name,
         ${adjustedMarketValueSQL("lh.quantity", "COALESCE(lp.close_price, 0)", "lh.security_type", "lh.multiplier", "COALESCE(fx.usd_per_unit, 1)")} AS market_value
       FROM latest_holdings lh
       LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
       LEFT JOIN fx_rates fx ON fx.currency = lh.currency
       WHERE COALESCE(lp.close_price, 0) > 0
       ORDER BY market_value DESC`
    )
    .all(...accountParams) as { symbol: string; security_name: string | null; market_value: number }[];

  if (rows.length === 0) {
    return { herfindahl: null, top5Concentration: 0, top5Positions: [], positionCount: 0 };
  }

  const totalValue = rows.reduce((s, r) => s + r.market_value, 0);
  if (totalValue <= 0) {
    return { herfindahl: null, top5Concentration: 0, top5Positions: [], positionCount: 0 };
  }

  const positions: PositionWeight[] = rows.map(r => ({
    symbol: r.symbol,
    securityName: r.security_name,
    marketValue: r.market_value,
    weight: r.market_value / totalValue,
  }));

  // Herfindahl index: sum of squared weights
  const herfindahl = positions.reduce((s, p) => s + p.weight ** 2, 0);

  // Top-5 concentration
  const top5 = positions.slice(0, 5);
  const top5Concentration = top5.reduce((s, p) => s + p.weight, 0);

  return {
    herfindahl,
    top5Concentration,
    top5Positions: top5,
    positionCount: positions.length,
  };
}

// ─── Position-Level Risk ─────────────────────────────────────────

/**
 * Compute per-position volatility, risk contribution, and pairwise
 * correlations for the top N positions. Uses daily close prices
 * from the prices table.
 *
 * Note: asOfDate is supported but only affects the current-position snapshot
 * (e.g., top-N rank). The volatility, correlation, and risk contribution
 * metrics are computed from price time-series (last 1 year), not point-in-time.
 */
export function computePositionRisk(
  db: Database.Database,
  options?: { accountId?: number; accountIds?: number[]; topN?: number; asOfDate?: string }
): PositionRiskResult {
  const topN = options?.topN ?? 10;
  const accountIds = normalizeAccountIds(options);
  const accountFilter =
    accountIds && accountIds.length > 0
      ? `AND h.account_id IN (${accountIds.map(() => "?").join(",")})`
      : "";
  const accountParams: number[] = accountIds ?? [];

  const predicate = latestHoldingsPredicate({
    keyBy: "account_security",
    includeShorts: false,
    asOfDate: options?.asOfDate,
    accountFilter, // accountFilter already includes "AND " prefix if set
  });

  // 1. Get current positions with weights
  const positions = db
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
         lh.security_id,
         s.symbol,
         s.name AS security_name,
         s.security_type,
         ${adjustedMarketValueSQL("lh.total_qty", "COALESCE(lp.close_price, 0)", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} AS market_value
       FROM latest_holdings lh
       JOIN securities s ON s.id = lh.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE COALESCE(lp.close_price, 0) > 0
       ORDER BY market_value DESC
       LIMIT ?`
    )
    .all(...accountParams, topN) as {
    security_id: number;
    symbol: string;
    security_name: string | null;
    security_type: string | null;
    market_value: number;
  }[];

  if (positions.length === 0) {
    return { positions: [], correlations: [], portfolioVol: null };
  }

  // Weight denominator = the WHOLE portfolio's value under the same
  // predicate, NOT the top-N subset — subset-normalized weights sum to
  // 100% and presented a 4% position as 16% (the card contradicted its
  // own drawer). The internal portfolio-return proxy divides by
  // coverageWeight, so it is invariant to this denominator change.
  const totalRow = db
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
       SELECT SUM(${adjustedMarketValueSQL("lh.total_qty", "COALESCE(lp.close_price, 0)", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}) AS total
       FROM latest_holdings lh
       JOIN securities s ON s.id = lh.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE COALESCE(lp.close_price, 0) > 0`
    )
    .get(...accountParams) as { total: number | null };
  const subsetValue = positions.reduce((s, p) => s + p.market_value, 0);
  const totalValue = totalRow?.total && totalRow.total > 0 ? totalRow.total : subsetValue;
  const securityIds = positions.map((p) => p.security_id);

  // 2. Fetch daily prices for all top positions (last 1 year)
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);

  const priceRows = db
    .prepare(
      `SELECT security_id, date, close_price
       FROM prices
       WHERE security_id IN (${securityIds.map(() => "?").join(",")})
         AND date >= ?
       ORDER BY date ASC`
    )
    .all(...securityIds, oneYearAgo) as {
    security_id: number;
    date: string;
    close_price: number;
  }[];

  // 3. Build per-security price series and compute daily returns
  const priceMap = new Map<number, Map<string, number>>(); // security_id -> date -> price
  const allDates = new Set<string>();

  for (const row of priceRows) {
    if (!priceMap.has(row.security_id)) {
      priceMap.set(row.security_id, new Map());
    }
    priceMap.get(row.security_id)!.set(row.date, row.close_price);
    allDates.add(row.date);
  }

  const sortedDates = [...allDates].sort();

  // Compute daily log returns per security
  const returnsBySecId = new Map<number, { dates: string[]; returns: number[] }>();

  // Options are EXEMPT from the split guard: premiums legitimately double or
  // halve day-over-day (live data has 10+ real pairs inside the guard's 2x
  // band), and options don't split in-series — same reasoning as the levels
  // plausibility guard's documented option exemption.
  const optionSecIds = new Set(
    positions
      .filter((p) => p.security_type?.toLowerCase() === "option")
      .map((p) => p.security_id)
  );

  for (const secId of securityIds) {
    const prices = priceMap.get(secId);
    if (!prices) continue;

    const dates: string[] = [];
    const returns: number[] = [];
    const splitGuardApplies = !optionSecIds.has(secId);

    for (let i = 1; i < sortedDates.length; i++) {
      // Skip pairs spanning a price gap (statement-anchor / sync discontinuity).
      if (calendarDaysBetween(sortedDates[i - 1], sortedDates[i]) > MAX_RETURN_GAP_DAYS) continue;
      const prev = prices.get(sortedDates[i - 1]);
      const curr = prices.get(sortedDates[i]);
      if (prev && curr && prev > 0 && curr > 0) {
        // Unadjusted-split guard: an integer-multiple discontinuity is a
        // series artifact, not a return (see isSplitSignatureReturnPair).
        if (splitGuardApplies && isSplitSignatureReturnPair(prev, curr)) continue;
        dates.push(sortedDates[i]);
        returns.push(Math.log(curr / prev));
      }
    }

    returnsBySecId.set(secId, { dates, returns });
  }

  // 4. Compute portfolio daily returns (weighted sum). Positions below
  // MIN_POSITION_OBSERVATIONS are excluded from the basket entirely — same
  // floor the per-position rows null out below (step 5) — so a thinly-traded
  // position can't feed the aggregate while its own row renders "—".
  const aggregateEligibleSecIds = securityIds.filter(
    (id) => (returnsBySecId.get(id)?.returns.length ?? 0) >= MIN_POSITION_OBSERVATIONS
  );
  const weights = new Map<number, number>();
  for (const p of positions) {
    weights.set(p.security_id, totalValue > 0 ? p.market_value / totalValue : 0);
  }

  // Portfolio return for each date = sum(weight_i * return_i)
  //
  // The coverage gate is RELATIVE to the top-N subset's total weight: weights
  // are whole-portfolio-denominated, so a diversified scope's top-10 can sum
  // to well under 0.5 and an absolute threshold would discard every date
  // (all/vanguard scopes computed null portfolioVol while the concentrated
  // ibkr/roth books passed). The mean already divides by coverageWeight, so
  // requiring "most of the subset priced that day" keeps the proxy honest
  // regardless of how concentrated the portfolio is. Both the numerator and
  // the weight denominator are restricted to aggregateEligibleSecIds, so a
  // sub-floor position's weight drops out of the renormalization too — it
  // never dilutes or inflates the basket vol.
  const subsetWeight = aggregateEligibleSecIds.reduce((sum, id) => sum + (weights.get(id) ?? 0), 0);
  const portfolioReturns = new Map<string, number>();
  for (const date of sortedDates.slice(1)) {
    let portfolioReturn = 0;
    let coverageWeight = 0;
    for (const secId of aggregateEligibleSecIds) {
      const secReturns = returnsBySecId.get(secId);
      if (!secReturns) continue;
      const idx = secReturns.dates.indexOf(date);
      if (idx >= 0) {
        const w = weights.get(secId) ?? 0;
        portfolioReturn += w * secReturns.returns[idx];
        coverageWeight += w;
      }
    }
    // Only include dates where most of the subset has a return that day
    if (subsetWeight > 0 && coverageWeight > 0.5 * subsetWeight) {
      portfolioReturns.set(date, portfolioReturn / coverageWeight);
    }
  }

  const portfolioReturnArray = [...portfolioReturns.values()];
  const portfolioVol =
    portfolioReturnArray.length >= MIN_POSITION_OBSERVATIONS
      ? stdDev(portfolioReturnArray) * Math.sqrt(TRADING_DAYS_PER_YEAR)
      : null;

  // 5. Compute per-position metrics
  const positionRisks: PositionRisk[] = positions.map((p) => {
    const secReturns = returnsBySecId.get(p.security_id);
    const weight = totalValue > 0 ? p.market_value / totalValue : 0;

    if (!secReturns || secReturns.returns.length < MIN_POSITION_OBSERVATIONS) {
      return {
        securityId: p.security_id,
        symbol: p.symbol,
        securityName: p.security_name,
        weight,
        annualizedVol: null,
        riskContribution: null,
        correlationWithPortfolio: null,
        dataPoints: secReturns?.returns.length ?? 0,
      };
    }

    const vol = stdDev(secReturns.returns) * Math.sqrt(TRADING_DAYS_PER_YEAR);

    // Compute correlation with portfolio
    const alignedSec: number[] = [];
    const alignedPort: number[] = [];
    for (let i = 0; i < secReturns.dates.length; i++) {
      const portRet = portfolioReturns.get(secReturns.dates[i]);
      if (portRet !== undefined) {
        alignedSec.push(secReturns.returns[i]);
        alignedPort.push(portRet);
      }
    }

    const corr = alignedSec.length >= 20 ? correlation(alignedSec, alignedPort) : null;

    // Risk contribution: weight × vol × correlation
    const riskContribution =
      corr != null && portfolioVol != null && portfolioVol > 0
        ? (weight * vol * corr) / portfolioVol
        : null;

    return {
      securityId: p.security_id,
      symbol: p.symbol,
      securityName: p.security_name,
      weight,
      annualizedVol: vol,
      riskContribution,
      correlationWithPortfolio: corr,
      dataPoints: secReturns.returns.length,
    };
  });

  // 6. Compute pairwise correlations for top positions
  const correlations: CorrelationEntry[] = [];
  const topForCorr = positions.slice(0, 8); // limit matrix size

  for (let i = 0; i < topForCorr.length; i++) {
    for (let j = i + 1; j < topForCorr.length; j++) {
      const a = returnsBySecId.get(topForCorr[i].security_id);
      const b = returnsBySecId.get(topForCorr[j].security_id);
      if (!a || !b) continue;

      // Align on common dates
      const aDates = new Set(a.dates);
      const alignedA: number[] = [];
      const alignedB: number[] = [];
      for (let k = 0; k < b.dates.length; k++) {
        if (aDates.has(b.dates[k])) {
          const aIdx = a.dates.indexOf(b.dates[k]);
          if (aIdx >= 0) {
            alignedA.push(a.returns[aIdx]);
            alignedB.push(b.returns[k]);
          }
        }
      }

      if (alignedA.length >= 20) {
        correlations.push({
          symbolA: topForCorr[i].symbol,
          symbolB: topForCorr[j].symbol,
          correlation: correlation(alignedA, alignedB),
        });
      }
    }
  }

  return { positions: positionRisks, correlations, portfolioVol };
}

// ─── Math helpers ────────────────────────────────────────────────

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n;

  let cov = 0;
  let varA = 0;
  let varB = 0;

  for (let i = 0; i < n; i++) {
    const dA = a[i] - meanA;
    const dB = b[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }

  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : 0;
}

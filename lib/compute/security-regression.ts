import type Database from "better-sqlite3";
import { addDays, calendarDaysBetween, todayET } from "@/lib/calendar/date-utils";
import {
  betaConfidenceVerdict,
  type BetaConfidenceResult,
} from "@/lib/compute/beta-confidence";
import { isSplitSignatureReturnPair } from "@/lib/compute/risk";
import {
  importSplitsFor,
  splitAdjustedClose,
  splitsNotYetAbsorbed,
} from "@/lib/compute/import-splits";
import { getOhlcvBars } from "@/lib/queries/ohlcv";

const TRADING_DAYS_PER_YEAR = 252;
const MIN_DATA_POINTS = 10;

// Drop a return pair whose dates straddle a multi-week hole: the prices table
// mixes sparse month-end statement anchors with dense daily TWS rows, so an
// adjacent pair can span months and is not a daily return. Mirrors
// MAX_RETURN_GAP_DAYS in lib/compute/risk.ts (not exported there); keep the two
// equal. Exported (2026-11-24) for the daily-bar regression's boundary test;
// the value is unchanged.
export const MAX_RETURN_GAP_DAYS = 7;

export interface SecurityRegression {
  beta: number;
  vol: number; // annualized stddev of security daily returns
  correlation: number;
  rSquared: number;
  dataPoints: number;
}

/** Options for `computeSecurityRegression`. Absent = every stored row is read. */
export interface SecurityRegressionOptions {
  /**
   * `prices.source` values left out of the SECURITY series (the benchmark
   * series is never filtered). A row with a NULL source is kept. Absent or
   * empty reads every row, exactly as before this option existed.
   */
  excludePriceSources?: readonly string[];
}

/**
 * Regress one security's daily log returns against a benchmark's daily log returns
 * using OLS. Mirrors the shape of `computeMarketRegression` in lib/compute/factors.ts
 * but operates on a single security instead of the whole portfolio.
 *
 * Pulls security prices from `prices` (security_id keyed) and benchmark prices from
 * `benchmark_prices` (symbol keyed — same convention as the portfolio-level regressor).
 *
 * Returns null when fewer than MIN_DATA_POINTS overlapping returns exist —
 * no pretending to regress sparse data.
 *
 * @param days  Lookback window in calendar days. Default 252 (~1 trading year).
 * @param opts  Optional source filter (Gains at risk, 2026-11-24): a measured
 *              beta reads only correctly dated rows. Absent = unchanged.
 */
export function computeSecurityRegression(
  db: Database.Database,
  securityId: number,
  benchmarkSymbol: string,
  days = 252,
  opts?: SecurityRegressionOptions
): SecurityRegression | null {
  // 1. Pull security prices for the lookback window.
  //    The window counts back from the Eastern day: a UTC slice of the wall
  //    clock is already tomorrow after 20:00 Eastern.
  const cutoff = addDays(todayET(), -days);

  const excluded = opts?.excludePriceSources ?? [];
  const sourceFilter =
    excluded.length > 0
      ? ` AND (source IS NULL OR source NOT IN (${excluded.map(() => "?").join(", ")}))`
      : "";
  const securityRows = db
    .prepare(
      `SELECT date, close_price FROM prices
       WHERE security_id = ? AND date >= ?${sourceFilter}
       ORDER BY date ASC`
    )
    .all(securityId, cutoff, ...excluded) as { date: string; close_price: number }[];

  if (securityRows.length < MIN_DATA_POINTS + 1) return null; // need >=11 prices for >=10 returns

  // 2. Pull benchmark prices for the same window.
  const benchmarkRows = readBenchmarkRows(db, benchmarkSymbol, cutoff);
  if (benchmarkRows.length < MIN_DATA_POINTS + 1) return null;

  // 3. Build aligned daily returns.
  //    Security closes are split-adjusted to today's basis from import-mode
  //    corporate actions: a vendor's unadjusted forward split otherwise shows
  //    up as a -75% (4:1) one-day return that dominates vol and beta.
  const splits = splitsNotYetAbsorbed(securityRows, importSplitsFor(db, securityId));
  const securityByDate = new Map<string, number>();
  for (const r of securityRows) {
    securityByDate.set(r.date, splitAdjustedClose(r.date, r.close_price, splits));
  }

  // Options are exempt from the split guard (premiums legitimately double or
  // halve; options don't split in-series) — same rule as computePositionRisk.
  const typeRow = db
    .prepare("SELECT security_type FROM securities WHERE id = ?")
    .get(securityId) as { security_type: string | null } | undefined;
  const splitGuardApplies = typeRow?.security_type?.toLowerCase() !== "option";

  return regressAlignedSeries(securityByDate, byDate(benchmarkRows), splitGuardApplies);
}

/**
 * Regress one BENCHMARK series against another (Gains at risk, 2026-11-24):
 * e.g. QQQ's beta to SPY, or a tracked index's beta to the driver. Reads
 * `benchmark_prices` only, never `prices` or `securities`. Same window, gap
 * rule, split-shape guard and OLS as `computeSecurityRegression`; benchmark
 * series are stored adjusted, so no corporate-action adjustment applies.
 * Symbols are trimmed and upper-cased.
 */
export function computeBenchmarkRegression(
  db: Database.Database,
  symbol: string,
  againstSymbol: string,
  days = 252
): SecurityRegression | null {
  const cutoff = addDays(todayET(), -days);
  const rows = readBenchmarkRows(db, symbol.trim().toUpperCase(), cutoff);
  if (rows.length < MIN_DATA_POINTS + 1) return null;
  const againstRows = readBenchmarkRows(db, againstSymbol.trim().toUpperCase(), cutoff);
  if (againstRows.length < MIN_DATA_POINTS + 1) return null;
  return regressAlignedSeries(byDate(rows), byDate(againstRows), true);
}

function readBenchmarkRows(
  db: Database.Database,
  symbol: string,
  cutoff: string
): { date: string; close_price: number }[] {
  return db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = ? AND date >= ?
       ORDER BY date ASC`
    )
    .all(symbol, cutoff) as { date: string; close_price: number }[];
}

function byDate(rows: { date: string; close_price: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.date, r.close_price);
  return out;
}

interface AlignedReturnPairs {
  sReturns: number[];
  bReturns: number[];
  /** The later date of each kept pair, ascending. */
  dates: string[];
  droppedGapPairs: number;
  droppedGuardPairs: number;
}

/**
 * Aligned daily log returns on the dates both series carry. A pair whose
 * dates are more than MAX_RETURN_GAP_DAYS calendar days apart is dropped and
 * counted; a pair with a non-positive close is skipped (not counted: priced
 * bars never carry one); a pair `dropPair` rejects is dropped and counted.
 */
function buildAlignedReturnPairs(
  securityByDate: Map<string, number>,
  benchmarkByDate: Map<string, number>,
  dropPair: (sPrev: number, sCurr: number, bPrev: number, bCurr: number) => boolean
): AlignedReturnPairs {
  const allDates = [...securityByDate.keys()]
    .filter((d) => benchmarkByDate.has(d))
    .sort();

  const out: AlignedReturnPairs = {
    sReturns: [],
    bReturns: [],
    dates: [],
    droppedGapPairs: 0,
    droppedGuardPairs: 0,
  };

  for (let i = 1; i < allDates.length; i++) {
    const sPrev = securityByDate.get(allDates[i - 1])!;
    const sCurr = securityByDate.get(allDates[i])!;
    const bPrev = benchmarkByDate.get(allDates[i - 1])!;
    const bCurr = benchmarkByDate.get(allDates[i])!;
    if (calendarDaysBetween(allDates[i - 1], allDates[i]) > MAX_RETURN_GAP_DAYS) {
      out.droppedGapPairs++;
      continue;
    }
    if (sPrev > 0 && sCurr > 0 && bPrev > 0 && bCurr > 0) {
      if (dropPair(sPrev, sCurr, bPrev, bCurr)) {
        out.droppedGuardPairs++;
        continue;
      }
      out.sReturns.push(Math.log(sCurr / sPrev));
      out.bReturns.push(Math.log(bCurr / bPrev));
      out.dates.push(allDates[i]);
    }
  }
  return out;
}

/**
 * OLS Rs = alpha + beta * Rb over paired returns. Null when the benchmark leg
 * has zero variance (which includes fewer than two pairs). No minimum count:
 * each caller applies its own.
 */
function olsRegression(sReturns: number[], bReturns: number[]): SecurityRegression | null {
  const n = sReturns.length;
  if (n === 0) return null;
  const meanS = sReturns.reduce((s, v) => s + v, 0) / n;
  const meanB = bReturns.reduce((s, v) => s + v, 0) / n;

  let covSB = 0;
  let varB = 0;
  let varS = 0;
  for (let i = 0; i < n; i++) {
    const dS = sReturns[i] - meanS;
    const dB = bReturns[i] - meanB;
    covSB += dS * dB;
    varB += dB * dB;
    varS += dS * dS;
  }

  if (varB === 0) return null;

  const beta = covSB / varB;
  const denom = Math.sqrt(varS * varB);
  const correlation = denom > 0 ? covSB / denom : 0;
  const rSquared = correlation * correlation;
  // Annualized vol of the security itself (not residual). Standard finance convention.
  const dailyVol = Math.sqrt(varS / (n - 1));
  const vol = dailyVol * Math.sqrt(TRADING_DAYS_PER_YEAR);

  return { beta, vol, correlation, rSquared, dataPoints: n };
}

/**
 * The core shared by the two price-table regressions: aligned daily log
 * returns, long-gap pairs and (when `splitGuardApplies`) split-shaped pairs
 * dropped, at least MIN_DATA_POINTS pairs, then OLS.
 */
function regressAlignedSeries(
  securityByDate: Map<string, number>,
  benchmarkByDate: Map<string, number>,
  splitGuardApplies: boolean
): SecurityRegression | null {
  // A split-shaped jump left after adjustment (a split with no action row, or
  // an action row over an already-adjusted series) is a series artifact, not
  // a return: drop the day, as computePositionRisk does.
  const pairs = buildAlignedReturnPairs(
    securityByDate,
    benchmarkByDate,
    (sPrev, sCurr) => splitGuardApplies && isSplitSignatureReturnPair(sPrev, sCurr)
  );
  if (pairs.sReturns.length < MIN_DATA_POINTS) return null;
  return olsRegression(pairs.sReturns, pairs.bReturns);
}

// ─── Bar-to-bar regression (Gains at risk addendum, 2026-11-24) ────────────

/** Lookback for the bar-to-bar regression, in calendar days (ruling B1). */
export const DAILY_BAR_WINDOW_DAYS = 730;
/** Fewest aligned pairs, after both guards, for a measured link (B1). */
export const DAILY_BAR_MIN_PAIRS = 60;
/**
 * Smallest |slope t-statistic| for a measured link (controller ruling
 * 2026-11-24, replacing the r-squared >= 0.10 gate for this function only):
 * with two years of daily pairs the question is whether the slope is
 * distinguishable from zero, not how much of the name's variance the driver
 * explains. r-squared is still reported as evidence.
 */
export const MIN_SLOPE_T_STAT = 2;
/**
 * The largest |slopeTStat| ever reported. A perfect fit (zero residual
 * variance) has an infinite t-statistic; it is reported as this finite value
 * with the slope's sign, so it survives JSON (Infinity would serialize as
 * null, which reads as "OLS could not run").
 */
export const SLOPE_T_STAT_CAP = 1e9;
/** Largest |security log return - driver log return| a pair may carry (B2). */
export const OUTLIER_RESIDUAL_LOG_BOUND = 0.35;

export type NoMeasuredLinkReason =
  | "foreign-session"
  | "driver-bars-missing"
  | "no-daily-bars"
  | "short-history"
  | "flat-driver"
  | "low-fit";

/** What the bar-to-bar regression found, for every outcome (ruling C13). */
export interface DailyBarEvidence {
  outcome: "measured" | NoMeasuredLinkReason;
  /** Set whenever OLS could run (two or more pairs and a moving driver). */
  beta: number | null;
  rSquared: number | null;
  /**
   * beta / standard error of the slope (residual variance on n - 2 degrees of
   * freedom over the driver's sum of squared deviations). Null when OLS could
   * not run or n < 3. Always finite: clamped to +/- SLOPE_T_STAT_CAP, which is
   * also what a perfect fit reports.
   */
  slopeTStat: number | null;
  /** Aligned pairs kept after the gap guard and the residual guard. */
  pairs: number;
  /** Priced daily bars in the window, per leg. */
  securityBars: number;
  driverBars: number;
  droppedOutlierPairs: number;
  droppedGapPairs: number;
  /** Later date of the first and last kept pair. */
  firstDate: string | null;
  lastDate: string | null;
}

/**
 * The residual guard (B2): a pair whose security and driver daily log returns
 * differ by more than OUTLIER_RESIDUAL_LOG_BOUND. It catches an unrecorded
 * 3:2 (0.405), 2:1 (0.693) or 3:1 (1.099) split when nothing else moved the
 * security, and keeps a day both fall together. NOT a guarantee (C14): a split
 * on a day the security also moved a lot against the driver can cancel and
 * pass, and that pair then moves the beta.
 */
export function isOutlierReturnPair(securityLogReturn: number, driverLogReturn: number): boolean {
  return Math.abs(securityLogReturn - driverLogReturn) > OUTLIER_RESIDUAL_LOG_BOUND;
}

/**
 * The OLS slope's t-statistic for Rs = alpha + beta * Rb: beta / se(beta),
 * se(beta) = sqrt(SSR / (n - 2) / Sbb), with SSR summed from the residuals
 * directly (no cancellation). Null when n < 3 or the driver does not move.
 * Clamped to +/- SLOPE_T_STAT_CAP; a zero residual with a non-zero slope
 * reports the cap with the slope's sign, a zero slope reports 0.
 */
export function slopeTStatistic(securityReturns: number[], driverReturns: number[]): number | null {
  const n = securityReturns.length;
  if (n < 3 || driverReturns.length !== n) return null;
  const meanS = securityReturns.reduce((a, v) => a + v, 0) / n;
  const meanB = driverReturns.reduce((a, v) => a + v, 0) / n;
  let sbb = 0;
  let ssb = 0;
  for (let i = 0; i < n; i++) {
    const dB = driverReturns[i] - meanB;
    sbb += dB * dB;
    ssb += (securityReturns[i] - meanS) * dB;
  }
  if (sbb === 0) return null;
  const beta = ssb / sbb;
  let ssr = 0;
  for (let i = 0; i < n; i++) {
    const r = securityReturns[i] - meanS - beta * (driverReturns[i] - meanB);
    ssr += r * r;
  }
  if (beta === 0) return 0;
  const se = Math.sqrt(ssr / (n - 2) / sbb);
  const t = se > 0 ? beta / se : Math.sign(beta) * SLOPE_T_STAT_CAP;
  return Math.max(-SLOPE_T_STAT_CAP, Math.min(SLOPE_T_STAT_CAP, t));
}

/**
 * A security trades in the US session when its stored currency is USD (C4).
 * `securities.currency` is NOT NULL with a USD default; a missing value reads
 * as USD.
 */
export function isUsSessionSecurity(currency: string | null): boolean {
  return (currency ?? "USD").trim().toUpperCase() === "USD";
}

/**
 * Regress a security's daily log returns on a driver's, BOTH legs read from
 * `ohlcv_bars` (`bar_size = '1 day'`, priced bars only, through
 * `getOhlcvBars`), over `[today - days, today)` (B1, C1, C3). Reads no
 * `prices` and no `benchmark_prices` row, and no corporate action: TWS bars
 * are split-adjusted when fetched. The shared ratio-shaped split guard does
 * not apply here; the residual guard does (B2).
 *
 * Outcome order: foreign-session, driver-bars-missing, no-daily-bars,
 * short-history (fewer than DAILY_BAR_MIN_PAIRS pairs, none included),
 * flat-driver, low-fit (|slope t-statistic| below MIN_SLOPE_T_STAT: the link
 * is not distinguishable from zero), measured. r-squared is evidence only. Always returns evidence, never null.
 *
 * Read-only. No cache is read or written.
 */
export function computeDailyBarRegression(
  db: Database.Database,
  securityId: number,
  driverSecurityId: number | null,
  opts?: { days?: number; today?: string }
): DailyBarEvidence {
  const today = opts?.today ?? todayET();
  const days = opts?.days ?? DAILY_BAR_WINDOW_DAYS;
  const window = { startDate: addDays(today, -days), endDate: addDays(today, -1) };

  const currencyOf = db.prepare("SELECT currency FROM securities WHERE id = ?");
  const readCurrency = (id: number): string | null =>
    (currencyOf.get(id) as { currency: string | null } | undefined)?.currency ?? null;

  const securityBars = getOhlcvBars(db, securityId, "1 day", window);
  const driverBars =
    driverSecurityId === null ? [] : getOhlcvBars(db, driverSecurityId, "1 day", window);

  const evidence: DailyBarEvidence = {
    outcome: "measured",
    beta: null,
    rSquared: null,
    slopeTStat: null,
    pairs: 0,
    securityBars: securityBars.length,
    driverBars: driverBars.length,
    droppedOutlierPairs: 0,
    droppedGapPairs: 0,
    firstDate: null,
    lastDate: null,
  };

  const foreign =
    !isUsSessionSecurity(readCurrency(securityId)) ||
    (driverSecurityId !== null && !isUsSessionSecurity(readCurrency(driverSecurityId)));
  if (foreign) return { ...evidence, outcome: "foreign-session" };
  if (driverBars.length === 0) return { ...evidence, outcome: "driver-bars-missing" };
  if (securityBars.length === 0) return { ...evidence, outcome: "no-daily-bars" };

  const closes = (bars: { date: string; close: number }[]) => {
    const m = new Map<string, number>();
    for (const b of bars) m.set(b.date, b.close);
    return m;
  };
  const aligned = buildAlignedReturnPairs(
    closes(securityBars),
    closes(driverBars),
    (sPrev, sCurr, bPrev, bCurr) =>
      isOutlierReturnPair(Math.log(sCurr / sPrev), Math.log(bCurr / bPrev))
  );

  const n = aligned.sReturns.length;
  evidence.pairs = n;
  evidence.droppedOutlierPairs = aligned.droppedGuardPairs;
  evidence.droppedGapPairs = aligned.droppedGapPairs;
  evidence.firstDate = n > 0 ? aligned.dates[0] : null;
  evidence.lastDate = n > 0 ? aligned.dates[n - 1] : null;

  const fit = n >= 2 ? olsRegression(aligned.sReturns, aligned.bReturns) : null;
  if (fit) {
    evidence.beta = fit.beta;
    evidence.rSquared = fit.rSquared;
    evidence.slopeTStat = slopeTStatistic(aligned.sReturns, aligned.bReturns);
  }

  if (n < DAILY_BAR_MIN_PAIRS) return { ...evidence, outcome: "short-history" };
  if (!fit) return { ...evidence, outcome: "flat-driver" };
  const t = evidence.slopeTStat;
  if (t === null || Math.abs(t) < MIN_SLOPE_T_STAT) return { ...evidence, outcome: "low-fit" };
  return evidence;
}

/**
 * Should this regression's beta be PUBLISHED as a number?
 *
 * qa: security-detail-factor-profile--regression-card-publishes-betas-failing-confidence-gate
 *
 * `computeSecurityRegression` only refuses to regress at all below
 * MIN_DATA_POINTS (10) — deliberately loose, because the backfill and the
 * `security_regressions` cache want the raw statistics whatever they say. But
 * a slope estimated over a dozen observations with r² near zero is noise, and
 * rendering it as an emphasised "Beta 17.4" states a fact the data cannot
 * carry.
 *
 * So the publish decision is derived at READ time from the same gate cached
 * OLS betas already pass through (`betaConfidenceVerdict`: r² ≥ 0.10 and ≥ 30
 * return pairs). Deriving rather than storing means rows cached before this
 * gate existed are covered too — no schema change, no backfill.
 *
 * Pure: takes only the two statistics the gate scores.
 */
export function regressionBetaVerdict(
  r: Pick<SecurityRegression, "rSquared" | "dataPoints">
): BetaConfidenceResult {
  return betaConfidenceVerdict({ rSquared: r.rSquared, pairs: r.dataPoints });
}

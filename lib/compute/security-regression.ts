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

const TRADING_DAYS_PER_YEAR = 252;
const MIN_DATA_POINTS = 10;

// Drop a return pair whose dates straddle a multi-week hole: the prices table
// mixes sparse month-end statement anchors with dense daily TWS rows, so an
// adjacent pair can span months and is not a daily return. Mirrors
// MAX_RETURN_GAP_DAYS in lib/compute/risk.ts (not exported there); keep the two
// equal.
const MAX_RETURN_GAP_DAYS = 7;

export interface SecurityRegression {
  beta: number;
  vol: number; // annualized stddev of security daily returns
  correlation: number;
  rSquared: number;
  dataPoints: number;
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
 */
export function computeSecurityRegression(
  db: Database.Database,
  securityId: number,
  benchmarkSymbol: string,
  days = 252
): SecurityRegression | null {
  // 1. Pull security prices for the lookback window.
  //    The window counts back from the Eastern day: a UTC slice of the wall
  //    clock is already tomorrow after 20:00 Eastern.
  const cutoff = addDays(todayET(), -days);

  const securityRows = db
    .prepare(
      `SELECT date, close_price FROM prices
       WHERE security_id = ? AND date >= ?
       ORDER BY date ASC`
    )
    .all(securityId, cutoff) as { date: string; close_price: number }[];

  if (securityRows.length < MIN_DATA_POINTS + 1) return null; // need >=11 prices for >=10 returns

  // 2. Pull benchmark prices for the same window.
  const benchmarkRows = db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = ? AND date >= ?
       ORDER BY date ASC`
    )
    .all(benchmarkSymbol, cutoff) as { date: string; close_price: number }[];

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
  const benchmarkByDate = new Map<string, number>();
  for (const b of benchmarkRows) benchmarkByDate.set(b.date, b.close_price);

  const allDates = [...securityByDate.keys()]
    .filter((d) => benchmarkByDate.has(d))
    .sort();

  // Options are exempt from the split guard (premiums legitimately double or
  // halve; options don't split in-series) — same rule as computePositionRisk.
  const typeRow = db
    .prepare("SELECT security_type FROM securities WHERE id = ?")
    .get(securityId) as { security_type: string | null } | undefined;
  const splitGuardApplies = typeRow?.security_type?.toLowerCase() !== "option";

  const sReturns: number[] = [];
  const bReturns: number[] = [];

  for (let i = 1; i < allDates.length; i++) {
    const sPrev = securityByDate.get(allDates[i - 1])!;
    const sCurr = securityByDate.get(allDates[i])!;
    const bPrev = benchmarkByDate.get(allDates[i - 1])!;
    const bCurr = benchmarkByDate.get(allDates[i])!;
    if (calendarDaysBetween(allDates[i - 1], allDates[i]) > MAX_RETURN_GAP_DAYS) continue;
    if (sPrev > 0 && sCurr > 0 && bPrev > 0 && bCurr > 0) {
      // A split-shaped jump left after adjustment (a split with no action
      // row, or an action row over an already-adjusted series) is a series
      // artifact, not a return: drop the day, as computePositionRisk does.
      if (splitGuardApplies && isSplitSignatureReturnPair(sPrev, sCurr)) continue;
      sReturns.push(Math.log(sCurr / sPrev));
      bReturns.push(Math.log(bCurr / bPrev));
    }
  }

  if (sReturns.length < MIN_DATA_POINTS) return null;

  // 4. OLS regression: Rs = alpha + beta * Rb
  const n = sReturns.length;
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

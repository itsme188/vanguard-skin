/**
 * anomalies.ts — Vanguard holdings anomaly detection for the evening email.
 *
 * Flags securities held in Vanguard (non-Roth) accounts whose daily move
 * significantly deviates from what their beta would predict given SPY's move.
 *
 * Privacy rule: output MUST NOT contain $ amounts, share counts, or position
 * size language. Only public market data (ticker, % move, beta) is emitted.
 */

import type Database from "better-sqlite3";
import { isMarketClosed, nextTradingDay } from "@/lib/calendar/market-holidays";
import { BETA_LOOKBACK_DAYS } from "@/lib/queries/security-betas";

// ─── Trigger constants ────────────────────────────────────────────────────────
// A move is "out of the ordinary" only if it is BOTH large in raw terms AND
// statistically rare for that specific security. See design doc 2026-06-01.
const MIN_ABS_MOVE_PCT = 3.0;     // magnitude floor (percent)
const MIN_RESIDUAL_Z = 2.0;       // std-devs of the stock's own residual noise
const RESIDUAL_STD_EPSILON = 0.1; // percent; at/below this, skip the z-gate

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnomalyFlag {
  securityId: number;
  symbol: string;
  companyName: string | null;
  actualPct: number;    // today's % move
  spyPct: number;       // SPY's % move today
  beta: number;
  expectedPct: number;  // spyPct × beta
  residualPct: number;  // actualPct − expectedPct (move the market doesn't explain)
  zScore: number | null; // |residualPct| / residualStd; null in degraded mode
  directionFlipped: boolean;
}

// ─── Internal row types ───────────────────────────────────────────────────────

interface HeldSecurityRow {
  security_id: number;
  symbol: string;
  name: string | null;
  today_close: number;
  prior_close: number;
  beta: number | null;
  residual_std: number | null;
}

interface PricePairRow {
  today_close: number;
  prior_close: number;
}

export interface TradingDayPair {
  /** Latest trading day with an SPY close (YYYY-MM-DD). */
  latest: string;
  /** The trading day immediately before `latest` (consecutive). */
  prior: string;
}

/**
 * Resolve the (latest, prior) **consecutive trading-day** pair from SPY's price
 * history. SPY is the market clock — always present, always the benchmark.
 *
 * Why this exists (2026-05-31): the prior implementation took each security's
 * own `MAX(date)` close vs. the row before it. That had three defects that
 * produced the wrong "Significant Moves" email on Fri 5/29:
 *   1. A weekend/holiday-stamped TWS snapshot row (e.g. a phantom 2026-05-31
 *      Sunday price, written because the snapshot writer had no trading-day
 *      guard) became "today".
 *   2. A security whose latest price was weeks old (mutual funds with no fresh
 *      TWS data) reported a stale multi-week move as if it were today's.
 *   3. Each security used its OWN date pair, so names weren't compared on the
 *      same two days — and not against SPY's day either.
 *
 * Fix: derive ONE consecutive trading-day pair from SPY (filtering out any
 * non-trading-day phantom rows) and compare every held name on those exact two
 * dates. A security missing either date is omitted — better to under-report
 * than to publish a move computed across a gap or a bad date.
 *
 * Returns null when SPY lacks a clean consecutive pair; callers then emit
 * nothing.
 */
export function resolveTradingDayPair(db: Database.Database): TradingDayPair | null {
  const rows = db
    .prepare(
      `SELECT p.date AS date
         FROM prices p
         JOIN securities s ON s.id = p.security_id
        WHERE UPPER(s.symbol) = 'SPY'
        ORDER BY p.date DESC
        LIMIT 10`
    )
    .all() as { date: string }[];

  // Drop any non-trading-day rows (weekend/holiday phantoms) before picking
  // the two most-recent sessions.
  const tradingDays = rows.map((r) => r.date).filter((d) => !isMarketClosed(d));
  if (tradingDays.length < 2) return null;

  const latest = tradingDays[0];
  const prior = tradingDays[1];

  // Require the two most-recent SPY trading days to be CONSECUTIVE. A gap (SPY
  // missed a session) means we can't compute a clean 1-day move, so bail rather
  // than report a multi-day move as "today".
  if (nextTradingDay(prior) !== latest) return null;

  return { latest, prior };
}

// ─── Main computation ─────────────────────────────────────────────────────────

/**
 * Compute anomaly flags for all securities held in Vanguard (non-Roth) accounts.
 *
 * Algorithm:
 * 1. Resolve a single (latest, prior) consecutive trading-day pair from SPY.
 * 2. Compute spyPct from SPY's closes on exactly those two dates.
 * 3. For each Vanguard-held security, read its close on those SAME two dates
 *    (skip the security if either is missing) + cached beta.
 * 4. Compute actualPct, expectedPct, residualPct; flag only if |actualPct| >= 3%
 *    AND (residual_std is unusable OR zScore >= 2).
 * 5. Sort by zScore descending.
 */
export function computeAnomalies(db: Database.Database): AnomalyFlag[] {
  // ── 1. Resolve the consecutive trading-day pair (SPY = market clock) ───────
  const pair = resolveTradingDayPair(db);
  if (!pair) return [];
  const { latest, prior } = pair;

  // ── 2. SPY closes on exactly those two dates ──────────────────────────────
  const spyPrices = db
    .prepare(
      `SELECT
         (SELECT p.close_price FROM prices p JOIN securities s ON s.id = p.security_id
           WHERE UPPER(s.symbol) = 'SPY' AND p.date = ?) AS today_close,
         (SELECT p.close_price FROM prices p JOIN securities s ON s.id = p.security_id
           WHERE UPPER(s.symbol) = 'SPY' AND p.date = ?) AS prior_close`
    )
    .get(latest, prior) as PricePairRow | undefined;

  if (
    !spyPrices ||
    spyPrices.today_close == null ||
    spyPrices.prior_close == null ||
    spyPrices.prior_close === 0
  ) {
    return [];
  }

  const spyPct =
    ((spyPrices.today_close - spyPrices.prior_close) / spyPrices.prior_close) * 100;

  // ── 3. Vanguard (non-Roth) account IDs ─────────────────────────────────────
  const vanguardAccounts = db
    .prepare(
      `SELECT id FROM accounts
       WHERE LOWER(name) LIKE '%vanguard%'
         AND LOWER(name) NOT LIKE '%roth%'`
    )
    .all() as { id: number }[];

  if (vanguardAccounts.length === 0) return [];

  const accountIds = vanguardAccounts.map((a) => a.id);
  const placeholders = accountIds.map(() => "?").join(",");

  // ── 4. Held securities, pinned to the SAME (latest, prior) dates ───────────
  // Every name is compared on the identical trading-day pair as SPY. A security
  // missing a close on either date (stale fund, gap) yields NULL and is dropped
  // by the loop below — omission over a misleading number.
  const rows = db
    .prepare(
      `SELECT DISTINCT
              s.id AS security_id,
              s.symbol,
              s.name,
              (SELECT close_price FROM prices
                WHERE security_id = s.id AND date = ?) AS today_close,
              (SELECT close_price FROM prices
                WHERE security_id = s.id AND date = ?) AS prior_close,
              sb.beta,
              sb.residual_std
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         LEFT JOIN security_betas sb
               ON sb.security_id = s.id AND sb.lookback_days = ${BETA_LOOKBACK_DAYS}
        WHERE h.account_id IN (${placeholders})
          AND UPPER(s.symbol) != 'SPY'`
    )
    .all(latest, prior, ...accountIds) as HeldSecurityRow[];

  // ── 4. Compute flags ────────────────────────────────────────────────────────
  const flags: AnomalyFlag[] = [];

  for (const row of rows) {
    // Skip: no beta, no prior close, or zero prior close
    if (row.beta == null) continue;
    if (row.prior_close == null || row.prior_close === 0) continue;
    if (row.today_close == null) continue;

    const actualPct = ((row.today_close - row.prior_close) / row.prior_close) * 100;
    const expectedPct = spyPct * row.beta;
    const residualPct = actualPct - expectedPct;

    // Gate 1: magnitude floor — always enforced.
    if (Math.abs(actualPct) < MIN_ABS_MOVE_PCT) continue;

    // Gate 2: statistical rarity — enforced only when residual_std is usable.
    // Degraded mode (null/tiny residual_std) falls through on the floor alone.
    let zScore: number | null = null;
    if (row.residual_std != null && row.residual_std > RESIDUAL_STD_EPSILON) {
      zScore = Math.abs(residualPct) / row.residual_std;
      if (zScore < MIN_RESIDUAL_Z) continue;
    }

    // Direction flipped: opposite signs AND |expected| is meaningful (> 0.1%)
    const directionFlipped =
      Math.abs(expectedPct) > 0.1 &&
      Math.sign(actualPct) !== 0 &&
      Math.sign(expectedPct) !== 0 &&
      Math.sign(actualPct) !== Math.sign(expectedPct);

    flags.push({
      securityId: row.security_id,
      symbol: row.symbol,
      companyName: row.name,
      actualPct,
      spyPct,
      beta: row.beta,
      expectedPct,
      residualPct,
      zScore,
      directionFlipped,
    });
  }

  // Sort by z-score desc (most statistically extreme first). Degraded flags
  // (null z) rank by how far they cleared the magnitude floor. Symbol is the
  // tie-break so the ordering is deterministic and byte-identical to the Worker
  // engine (workers/cron/src/fallback-evening.ts) on exact z-score ties.
  const sortKey = (f: AnomalyFlag): number =>
    f.zScore ?? Math.abs(f.actualPct) / MIN_ABS_MOVE_PCT;
  flags.sort((a, b) => sortKey(b) - sortKey(a) || a.symbol.localeCompare(b.symbol));

  return flags;
}

// ─── Formatter ────────────────────────────────────────────────────────────────

/** Format a number as a signed percentage string, e.g. "+1.2%" or "-3.4%". */
function signedPct(value: number, decimals = 1): string {
  const rounded = parseFloat(value.toFixed(decimals));
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${rounded.toFixed(decimals)}%`;
}

/**
 * Format the Vanguard anomalies block for inclusion in an email.
 *
 * Returns "" when there are no anomalies (caller should omit the section).
 * Renders ALL flagged securities — no cap.
 *
 * Privacy: output contains only public market data — ticker, % move, beta.
 * No $ amounts, share counts, or position size language.
 */
export function formatVanguardAnomaliesBlock(db: Database.Database): string {
  const flags = computeAnomalies(db);
  if (flags.length === 0) return "";

  const lines: string[] = [
    "## Significant Moves in Vanguard Holdings (vs. expected)",
    "",
  ];

  for (const flag of flags) {
    const signedActual = signedPct(flag.actualPct);
    const signedExpected = signedPct(flag.expectedPct);
    const signedSpy = signedPct(flag.spyPct);
    const reason = flag.directionFlipped
      ? "Direction flipped."
      : flag.zScore != null
        ? `${flag.zScore.toFixed(1)}σ move.`
        : `${signedActual} move.`;

    lines.push(
      `- **${flag.symbol}** ${signedActual} — expected ${signedExpected} (beta ${flag.beta.toFixed(1)} × SPY ${signedSpy}). ${reason}`
    );
  }

  lines.push("");

  return lines.join("\n");
}

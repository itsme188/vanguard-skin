/**
 * refresh-vanguard-betas.ts
 *
 * Nightly script: for every security held in a Vanguard (non-Roth) account,
 * compute a 60-day OLS beta vs SPY and cache it in `security_betas`.
 *
 * Vanguard scope rule (from CLAUDE.md):
 *   account name LIKE '%vanguard%' AND NOT LIKE '%roth%'  (case-insensitive)
 *
 * CLI usage:
 *   npx tsx scripts/refresh-vanguard-betas.ts
 *
 * Exits non-zero when any per-security errors are collected.
 */

import type Database from "better-sqlite3";
import { upsertBeta, deleteBeta } from "@/lib/mutations/security-betas";
import { BETA_LOOKBACK_DAYS } from "@/lib/queries/security-betas";
import { calendarDaysBetween } from "@/lib/calendar/date-utils";
import { isSplitSignatureReturnPair } from "@/lib/compute/risk";
import {
  betaConfidenceVerdict,
  type BetaConfidenceReason,
} from "@/lib/compute/beta-confidence";

// ─── Constants ────────────────────────────────────────────────────

const LOOKBACK_DAYS = BETA_LOOKBACK_DAYS;
// Floor on RAW price rows before we bother regressing. The floor on ALIGNED
// return pairs now lives in the publish gate (MIN_BETA_PAIRS in
// lib/compute/beta-confidence.ts) so that a thin regression DELETES its
// stale cached row instead of silently leaving last week's beta on screen.
const MIN_DATA_POINTS = 30;
const BENCHMARK_SYMBOL = "SPY";
// Drop return pairs whose dates are more than ~a week apart. The prices table
// mixes sparse month-end statement anchors with dense daily TWS rows, so an
// adjacent pair can straddle a multi-month hole (a real example: a 9-month gap
// that also crossed Netflix's stock split → a spurious −91% "daily" return that
// produced β=−14). 7 days tolerates weekends + holidays + a missed day or two;
// anything larger is a discontinuity, not a single-period return.
const MAX_RETURN_GAP_DAYS = 7;

// ─── Types ────────────────────────────────────────────────────────

/** A regression that ran but failed the publish gate — its cached row is deleted. */
export interface InvalidatedBeta {
  symbol: string;
  rSquared: number;
  /** Aligned return pairs the regression used. */
  pairs: number;
  reason: BetaConfidenceReason;
}

export interface RefreshResult {
  computed: number;
  skipped: string[]; // symbols with insufficient history to regress at all
  /** Symbols whose regression had no explanatory power → cached row DELETED. */
  invalidated: InvalidatedBeta[];
  errors: { symbol: string; error: string }[];
}

interface SecurityRow {
  id: number;
  symbol: string;
  security_type: string;
}

interface PriceRow {
  date: string;
  close_price: number;
}

// ─── OLS beta helper ──────────────────────────────────────────────

export interface BetaResult {
  beta: number;
  /** Residual std-dev of the regression, in PERCENT units (decimal x 100). */
  residualStdPct: number;
  /** corr(stock, spy)² — the share of the name's variance the market explains. */
  rSquared: number;
  /** Aligned return pairs the regression actually used. */
  pairs: number;
}

/**
 * Compute beta = cov(stock_returns, spy_returns) / var(spy_returns) using log
 * daily returns on the aligned date pairs, plus the residual standard deviation
 * (idiosyncratic daily volatility) of that regression and its r².
 *
 * residual_i = (sLog_i - meanS) - beta x (bLog_i - meanB)
 * residualStd = sqrt( sum residual_i^2 / (n - 2) )   [n-2 = regression dof]
 * Returned in PERCENT units so the anomaly engine compares it directly to
 * simple-percent daily moves.
 *
 * r² and the pair count are returned so the CALLER can decide whether the
 * slope is publishable (`betaConfidenceVerdict`). The sample-size test lives
 * in that gate, not here — a 12-pair regression must reach the gate as
 * `few_pairs` (which DELETES the stale cached row) rather than vanish into a
 * silent skip that leaves last week's beta on screen.
 *
 * Returns null only when no regression is defined at all: fewer than two
 * usable pairs, or a benchmark series with zero variance.
 */
export function computeBeta(
  stockPrices: Map<string, number>,
  spyPrices: Map<string, number>
): BetaResult | null {
  const dates = [...stockPrices.keys()]
    .filter((d) => spyPrices.has(d))
    .sort();

  const stockReturns: number[] = [];
  const spyReturns: number[] = [];

  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1];
    const curr = dates[i];

    // Skip non-consecutive pairs (statement-anchor / sync-gap discontinuities).
    if (calendarDaysBetween(prev, curr) > MAX_RETURN_GAP_DAYS) continue;

    const sPrev = stockPrices.get(prev)!;
    const sCurr = stockPrices.get(curr)!;
    const bPrev = spyPrices.get(prev)!;
    const bCurr = spyPrices.get(curr)!;

    if (sPrev > 0 && sCurr > 0 && bPrev > 0 && bCurr > 0) {
      // Sibling of computePositionRisk's guard: an unadjusted stock split
      // (VGT 8:1) would inject a phantom −87.5% "daily return" into the
      // regression, corrupting beta + residual_std (the anomaly σ inputs).
      // This script covers stocks/ETFs only, so no option exemption needed.
      if (isSplitSignatureReturnPair(sPrev, sCurr)) continue;
      stockReturns.push(Math.log(sCurr / sPrev));
      spyReturns.push(Math.log(bCurr / bPrev));
    }
  }

  if (stockReturns.length < 2) return null;

  const n = stockReturns.length;
  const meanS = stockReturns.reduce((s, v) => s + v, 0) / n;
  const meanB = spyReturns.reduce((s, v) => s + v, 0) / n;

  let covSB = 0;
  let varB = 0;
  let varS = 0;

  for (let i = 0; i < n; i++) {
    const dS = stockReturns[i] - meanS;
    const dB = spyReturns[i] - meanB;
    covSB += dS * dB;
    varB += dB * dB;
    varS += dS * dS;
  }

  if (varB === 0) return null;

  const beta = covSB / varB;
  // r² = corr(stock, spy)². varS === 0 (a flat stock series) leaves it
  // non-finite; the confidence gate fails closed on that.
  const rSquared = (covSB * covSB) / (varS * varB);

  // Residual (idiosyncratic) std-dev around the regression line.
  let residSumSq = 0;
  for (let i = 0; i < n; i++) {
    const resid = (stockReturns[i] - meanS) - beta * (spyReturns[i] - meanB);
    residSumSq += resid * resid;
  }
  const dof = n - 2;
  const residualStd = dof > 0 ? Math.sqrt(residSumSq / dof) : 0; // decimal log-return
  const residualStdPct = residualStd * 100;

  return { beta, residualStdPct, rSquared, pairs: n };
}

// ─── Main refresh function ────────────────────────────────────────

/**
 * Refresh 60-day OLS betas for all securities held in Vanguard (non-Roth) accounts.
 *
 * - Reads closing prices from the `prices` table (not `ohlcv_bars`).
 * - Matches SPY close dates pairwise.
 * - Securities with too little raw price history to regress → result.skipped.
 * - Regressions that fail the publish gate (r² < 0.10 or fewer than 30 aligned
 *   pairs) → result.invalidated, and their cached row is DELETED so a
 *   noise-signed beta never renders as fact on Significant Moves.
 * - Per-security errors are collected and do not abort the run.
 */
export async function refreshVanguardBetas(
  db: Database.Database
): Promise<RefreshResult> {
  const result: RefreshResult = {
    computed: 0,
    skipped: [],
    invalidated: [],
    errors: [],
  };

  // ── 1. Find Vanguard (non-Roth) account IDs ──────────────────────
  const vanguardAccounts = db
    .prepare(
      `SELECT id FROM accounts
       WHERE LOWER(name) LIKE '%vanguard%'
         AND LOWER(name) NOT LIKE '%roth%'`
    )
    .all() as { id: number }[];

  if (vanguardAccounts.length === 0) {
    return result;
  }

  const accountIds = vanguardAccounts.map((a) => a.id);
  const placeholders = accountIds.map(() => "?").join(",");

  // ── 2. Find distinct held securities (Stock, ETF, Mutual Fund; exclude SPY) ─
  const securities = db
    .prepare(
      `SELECT DISTINCT s.id, s.symbol, s.security_type
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE h.account_id IN (${placeholders})
          AND LOWER(s.security_type) IN ('stock', 'etf', 'mutual fund')
          AND UPPER(s.symbol) != ?
        ORDER BY s.symbol`
    )
    .all(...accountIds, BENCHMARK_SYMBOL) as SecurityRow[];

  if (securities.length === 0) {
    return result;
  }

  // ── 3. Load SPY prices for the lookback window ────────────────────
  //    We load the last LOOKBACK_DAYS + some buffer days of SPY prices.
  const spySecurity = db
    .prepare("SELECT id FROM securities WHERE UPPER(symbol) = ?")
    .get(BENCHMARK_SYMBOL) as { id: number } | undefined;

  // SPY may not be in the `prices` table at all; handle gracefully.
  const spyPrices = new Map<string, number>();

  if (spySecurity) {
    const spyRows = db
      .prepare(
        `SELECT date, close_price FROM prices
           WHERE security_id = ?
           ORDER BY date DESC
           LIMIT ?`
      )
      .all(spySecurity.id, LOOKBACK_DAYS + 10) as PriceRow[];

    for (const row of spyRows) {
      spyPrices.set(row.date, row.close_price);
    }
  }

  // If no SPY data at all, every security will be skipped — that's correct.

  // ── 4. Per-security beta computation ─────────────────────────────
  for (const sec of securities) {
    try {
      // Load recent prices for this security
      const priceRows = db
        .prepare(
          `SELECT date, close_price FROM prices
             WHERE security_id = ?
             ORDER BY date DESC
             LIMIT ?`
        )
        .all(sec.id, LOOKBACK_DAYS + 10) as PriceRow[];

      if (priceRows.length < MIN_DATA_POINTS) {
        // No evidence to regress against — an older cached beta describes a
        // window we can no longer reproduce, so it must stop publishing.
        deleteBeta(db, sec.id, LOOKBACK_DAYS);
        result.skipped.push(sec.symbol);
        continue;
      }

      const stockPrices = new Map<string, number>();
      for (const row of priceRows) {
        stockPrices.set(row.date, row.close_price);
      }

      const regression = computeBeta(stockPrices, spyPrices);

      if (regression === null) {
        // No regression is defined (fewer than 2 aligned pairs, or a
        // zero-variance benchmark) — same fail-closed treatment.
        deleteBeta(db, sec.id, LOOKBACK_DAYS);
        result.skipped.push(sec.symbol);
        continue;
      }

      // Publish gate: a slope with no explanatory power is noise, and its SIGN
      // is what Significant Moves renders as a "Direction flipped" badge.
      const verdict = betaConfidenceVerdict({
        rSquared: regression.rSquared,
        pairs: regression.pairs,
      });

      if (!verdict.ok) {
        deleteBeta(db, sec.id, LOOKBACK_DAYS);
        result.invalidated.push({
          symbol: sec.symbol,
          rSquared: regression.rSquared,
          pairs: regression.pairs,
          reason: verdict.reason!,
        });
        continue;
      }

      upsertBeta(db, {
        securityId: sec.id,
        lookbackDays: LOOKBACK_DAYS,
        beta: regression.beta,
        residualStd: regression.residualStdPct,
      });
      result.computed++;
    } catch (err) {
      result.errors.push({
        symbol: sec.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// ─── CLI entry point ──────────────────────────────────────────────

// Detect if this file is being run directly (not imported by tests)
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("refresh-vanguard-betas.ts") ||
    process.argv[1].endsWith("refresh-vanguard-betas.js"));

if (isMain) {
  // Dynamic import so the module is still importable without next.js context
  (async () => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { runMigrations } = await import("@/lib/db/migrate");
    const path = await import("path");
    const fs = await import("fs");

    const dataDir =
      process.env.VANGUARD_DB_DIR ||
      path.default.join(process.cwd(), "data");
    const dbPath = path.default.join(dataDir, "vanguard.db");

    if (!fs.default.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
    }

    const db = new BetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    console.log(`${new Date().toISOString()} — refreshVanguardBetas starting`);
    const result = await refreshVanguardBetas(db);
    console.log(JSON.stringify(result, null, 2));

    // One line per invalidated symbol: which gate it failed, with the evidence.
    for (const inv of result.invalidated) {
      console.log(
        `  invalidated ${inv.symbol}: ${inv.reason} (r²=${inv.rSquared.toFixed(3)}, n=${inv.pairs}) — cached ${LOOKBACK_DAYS}d beta deleted`
      );
    }

    if (result.errors.length > 0) {
      console.error(
        `${new Date().toISOString()} — ${result.errors.length} error(s) encountered`
      );
      process.exit(1);
    }

    console.log(
      `${new Date().toISOString()} — done: computed=${result.computed} invalidated=${result.invalidated.length} skipped=${result.skipped.length}`
    );
    process.exit(0);
  })();
}

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
import { upsertBeta } from "@/lib/mutations/security-betas";
import { BETA_LOOKBACK_DAYS } from "@/lib/queries/security-betas";
import { calendarDaysBetween } from "@/lib/calendar/date-utils";
import { isSplitSignatureReturnPair } from "@/lib/compute/risk";

// ─── Constants ────────────────────────────────────────────────────

const LOOKBACK_DAYS = BETA_LOOKBACK_DAYS;
const MIN_DATA_POINTS = 30; // skip securities with fewer aligned return pairs
const BENCHMARK_SYMBOL = "SPY";
// Drop return pairs whose dates are more than ~a week apart. The prices table
// mixes sparse month-end statement anchors with dense daily TWS rows, so an
// adjacent pair can straddle a multi-month hole (a real example: a 9-month gap
// that also crossed Netflix's stock split → a spurious −91% "daily" return that
// produced β=−14). 7 days tolerates weekends + holidays + a missed day or two;
// anything larger is a discontinuity, not a single-period return.
const MAX_RETURN_GAP_DAYS = 7;

// ─── Types ────────────────────────────────────────────────────────

export interface RefreshResult {
  computed: number;
  skipped: string[]; // symbols with insufficient history
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

interface BetaResult {
  beta: number;
  /** Residual std-dev of the regression, in PERCENT units (decimal x 100). */
  residualStdPct: number;
}

/**
 * Compute beta = cov(stock_returns, spy_returns) / var(spy_returns) using log
 * daily returns on the aligned date pairs, plus the residual standard deviation
 * (idiosyncratic daily volatility) of that regression.
 *
 * residual_i = (sLog_i - meanS) - beta x (bLog_i - meanB)
 * residualStd = sqrt( sum residual_i^2 / (n - 2) )   [n-2 = regression dof]
 * Returned in PERCENT units so the anomaly engine compares it directly to
 * simple-percent daily moves.
 *
 * Returns null when there are insufficient aligned data points.
 */
function computeBeta(
  stockPrices: Map<string, number>,
  spyPrices: Map<string, number>
): BetaResult | null {
  const dates = [...stockPrices.keys()]
    .filter((d) => spyPrices.has(d))
    .sort();

  if (dates.length < MIN_DATA_POINTS + 1) return null;

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

  if (stockReturns.length < MIN_DATA_POINTS) return null;

  const n = stockReturns.length;
  const meanS = stockReturns.reduce((s, v) => s + v, 0) / n;
  const meanB = spyReturns.reduce((s, v) => s + v, 0) / n;

  let covSB = 0;
  let varB = 0;

  for (let i = 0; i < n; i++) {
    const dS = stockReturns[i] - meanS;
    const dB = spyReturns[i] - meanB;
    covSB += dS * dB;
    varB += dB * dB;
  }

  if (varB === 0) return null;

  const beta = covSB / varB;

  // Residual (idiosyncratic) std-dev around the regression line.
  let residSumSq = 0;
  for (let i = 0; i < n; i++) {
    const resid = (stockReturns[i] - meanS) - beta * (spyReturns[i] - meanB);
    residSumSq += resid * resid;
  }
  const dof = n - 2;
  const residualStd = dof > 0 ? Math.sqrt(residSumSq / dof) : 0; // decimal log-return
  const residualStdPct = residualStd * 100;

  return { beta, residualStdPct };
}

// ─── Main refresh function ────────────────────────────────────────

/**
 * Refresh 60-day OLS betas for all securities held in Vanguard (non-Roth) accounts.
 *
 * - Reads closing prices from the `prices` table (not `ohlcv_bars`).
 * - Matches SPY close dates pairwise.
 * - Skips securities with <30 aligned return pairs → adds to result.skipped.
 * - Per-security errors are collected and do not abort the run.
 */
export async function refreshVanguardBetas(
  db: Database.Database
): Promise<RefreshResult> {
  const result: RefreshResult = {
    computed: 0,
    skipped: [],
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
        result.skipped.push(sec.symbol);
        continue;
      }

      const stockPrices = new Map<string, number>();
      for (const row of priceRows) {
        stockPrices.set(row.date, row.close_price);
      }

      const regression = computeBeta(stockPrices, spyPrices);

      if (regression === null) {
        // Insufficient aligned data after matching with SPY dates
        result.skipped.push(sec.symbol);
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

    if (result.errors.length > 0) {
      console.error(
        `${new Date().toISOString()} — ${result.errors.length} error(s) encountered`
      );
      process.exit(1);
    }

    console.log(
      `${new Date().toISOString()} — done: computed=${result.computed} skipped=${result.skipped.length}`
    );
    process.exit(0);
  })();
}

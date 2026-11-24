/**
 * A position's beta to the DRIVER index (Gains at risk, 2026-11-24).
 *
 * The Gains at risk engine moves one index (the driver: SPY, QQQ or VTI in
 * step 1) and needs each position's beta to it, with an honest label for
 * where that number came from, and a refusal with a reason (never a guess)
 * when no beta can be justified.
 *
 * THE RULES, first match wins (symbols trimmed and upper-cased):
 *   1. A leveraged or inverse fund, or an option on one: tracked index's
 *      beta to the driver (1 when the tracked index IS the driver, else a
 *      benchmark-to-benchmark regression passing the confidence gate) times
 *      the signed factor -> "leveraged". The fund's own regression is never
 *      read (F5). No factor, no tracked index, or an unmeasured tracked index
 *      is a refusal.
 *   2. The identity (or an option's stored underlying) IS the driver -> 1, "driver".
 *   3. A fixed engine value (cash, bond, bond fund with no market move) -> "fixed".
 *   4. A measured regression of the identity against the driver passing the
 *      gate -> "measured".
 *   5. Otherwise convert a beta to the broad market (SPY) through the
 *      driver's own SPY beta (`driverMarketBeta`). With no usable driver
 *      beta the row is refused (`no-driver-conversion`): it is NEVER divided
 *      by an assumed 1 (F6). A measured SPY regression -> "market-converted";
 *      else the heuristic market beta -> "estimated" (a non-finite heuristic
 *      is refused: `no-heuristic-beta`).
 *
 * MEASURED regressions (rules 4 and 5, F8/F9) read only correctly dated rows:
 * `MEASURED_BETA_EXCLUDED_PRICE_SOURCES` are left out of the security series
 * (`lib/plaid/refresh.ts` stamps every price it writes 'plaid', dated on
 * Plaid's own as-of day). The `security_regressions` cache was computed over
 * every row, so it is read only when the security has no excluded-source row
 * in the window that cached row covered, and only when the row is at most
 * `REGRESSION_CACHE_MAX_AGE_DAYS` old; otherwise the regression is computed on
 * demand. This module is READ-ONLY: it never writes the cache or any table.
 */

import type Database from "better-sqlite3";
import { addDays, calendarDaysBetween, todayET } from "@/lib/calendar/date-utils";
import type { LeveragedExposure } from "@/lib/compute/leveraged-fund";
import {
  computeBenchmarkRegression,
  computeSecurityRegression,
  regressionBetaVerdict,
  type SecurityRegression,
} from "@/lib/compute/security-regression";
import { getCachedRegression } from "@/lib/queries/security-regressions";

export const MEASURED_BETA_EXCLUDED_PRICE_SOURCES = ["plaid"] as const;
export const REGRESSION_CACHE_MAX_AGE_DAYS = 7;
/** A driver whose beta to SPY is smaller than this in size cannot convert a market beta. */
export const MIN_USABLE_DRIVER_MARKET_BETA = 0.2;

/** The regression window, in calendar days: `computeSecurityRegression`'s default. */
const REGRESSION_WINDOW_DAYS = 252;
const MARKET_SYMBOL = "SPY";

export type DriverBetaSource =
  | "driver"
  | "measured"
  | "market-converted"
  | "estimated"
  | "fixed"
  | "leveraged";
export type DriverBetaRefusal =
  | "leveraged-no-factor"
  | "leveraged-no-tracked-index"
  | "tracked-index-not-measured"
  | "no-driver-conversion"
  /** Rule 5 fell through to the heuristic, and the heuristic market beta is not a finite number. */
  | "no-heuristic-beta";
export type DriverBeta =
  | { beta: number; source: DriverBetaSource }
  | { beta: null; source: "not-modelled"; reason: DriverBetaRefusal };

export interface DriverBetaInput {
  securityId: number;
  /** equityIdentity(pos).symbol: the underlying for an option, else the row's own symbol. */
  identitySymbol: string;
  /** An option's stored securities.underlying_symbol, kept even when no underlying row exists (F7); else null. */
  storedUnderlyingSymbol: string | null;
  /** securities.id of the identity row; null when not on file. */
  identitySecurityId: number | null;
  leveraged: LeveragedExposure;
  /** The custom engine's fixed beta (cash-equivalent 0, bond 0.1, bond fund with no market move 0), else null. */
  fixedBeta: number | null;
  /** estimateBeta(...) for the identity: a beta to the broad market. */
  heuristicMarketBeta: number;
  /** Leveraged rows: trackedIndexFor(identity symbol). */
  trackedIndexSymbol: string | null;
}

function norm(symbol: string | null | undefined): string {
  return (symbol ?? "").trim().toUpperCase();
}

function refuse(reason: DriverBetaRefusal): DriverBeta {
  return { beta: null, source: "not-modelled", reason };
}

/** A regression whose beta may be published: passes the confidence gate and is finite. */
function usableBeta(r: SecurityRegression | null): number | null {
  if (r === null) return null;
  if (!regressionBetaVerdict(r).ok) return null;
  return Number.isFinite(r.beta) ? r.beta : null;
}

/**
 * A measured regression of a security against a benchmark from correctly
 * dated rows: the fresh cache when it may be trusted, else computed on demand
 * with the excluded sources left out. Null when nothing can be regressed.
 */
function measuredRegression(
  db: Database.Database,
  securityId: number,
  benchmarkSymbol: string,
  today: string,
): SecurityRegression | null {
  const cached = getCachedRegression(db, securityId, benchmarkSymbol);
  if (cached !== null) {
    // calendarDaysBetween is a size, not a direction: a row dated after
    // `today` is refused by the string compare (look-ahead).
    const age = calendarDaysBetween(cached.computedAtDay, today);
    if (cached.computedAtDay <= today && age <= REGRESSION_CACHE_MAX_AGE_DAYS) {
      // The cached row covered the window ending on its own day; any excluded
      // row from that window's start onward may have fed it.
      const windowStart = addDays(cached.computedAtDay, -REGRESSION_WINDOW_DAYS);
      if (!hasExcludedPriceRow(db, securityId, windowStart)) return cached;
    }
  }
  return computeSecurityRegression(db, securityId, benchmarkSymbol, REGRESSION_WINDOW_DAYS, {
    excludePriceSources: MEASURED_BETA_EXCLUDED_PRICE_SOURCES,
  });
}

function hasExcludedPriceRow(db: Database.Database, securityId: number, since: string): boolean {
  const sources = MEASURED_BETA_EXCLUDED_PRICE_SOURCES;
  const row = db
    .prepare(
      `SELECT 1 FROM prices
        WHERE security_id = ? AND date >= ?
          AND source IN (${sources.map(() => "?").join(", ")})
        LIMIT 1`,
    )
    .get(securityId, since, ...sources);
  return row !== undefined;
}

/**
 * The driver's beta to the broad market (SPY): exactly 1 for SPY, else a
 * benchmark-to-benchmark regression that passes the gate, is finite and is at
 * least `MIN_USABLE_DRIVER_MARKET_BETA` in size. Null = not usable. Reads
 * `benchmark_prices` only; independent of holdings.
 */
export function driverMarketBeta(
  db: Database.Database,
  driverSymbol: string,
  _opts?: { today?: string },
): number | null {
  const driver = norm(driverSymbol);
  if (driver === MARKET_SYMBOL) return 1;
  if (driver === "") return null;
  const beta = usableBeta(computeBenchmarkRegression(db, driver, MARKET_SYMBOL));
  if (beta === null || Math.abs(beta) < MIN_USABLE_DRIVER_MARKET_BETA) return null;
  return beta;
}

/**
 * A position's beta to the driver index, or a refusal with its reason. See the rules above.
 * Throws on a blank `driverSymbol`. `opts.today` controls the cache age and the Plaid probe only; the regression window counts back from the real Eastern day (`todayET()`).
 */
export function resolveDriverBeta(
  db: Database.Database,
  input: DriverBetaInput,
  driverSymbol: string,
  opts?: { today?: string },
): DriverBeta {
  const driver = norm(driverSymbol);
  if (driver === "") throw new Error("driverSymbol is required");
  const today = opts?.today ?? todayET();

  // 1. Leveraged or inverse: the tracked index times the signed factor.
  if (input.leveraged.flagged) {
    const factor = input.leveraged.factor;
    if (factor === null || !Number.isFinite(factor) || factor === 0) {
      return refuse("leveraged-no-factor");
    }
    const tracked = norm(input.trackedIndexSymbol);
    if (tracked === "") return refuse("leveraged-no-tracked-index");
    let trackedBeta: number | null;
    if (tracked === driver) {
      trackedBeta = 1;
    } else {
      trackedBeta = usableBeta(computeBenchmarkRegression(db, tracked, driver));
    }
    if (trackedBeta === null) return refuse("tracked-index-not-measured");
    return { beta: trackedBeta * factor, source: "leveraged" };
  }

  // 2. The driver itself, or an option on it (even with no underlying row).
  if (norm(input.identitySymbol) === driver || norm(input.storedUnderlyingSymbol) === driver) {
    return { beta: 1, source: "driver" };
  }

  // 3. The engine's fixed value.
  if (input.fixedBeta !== null) {
    return { beta: input.fixedBeta, source: "fixed" };
  }

  // 4. Measured against the driver.
  if (input.identitySecurityId !== null) {
    const measured = usableBeta(measuredRegression(db, input.identitySecurityId, driver, today));
    if (measured !== null) return { beta: measured, source: "measured" };
  }

  // 5. Convert a market beta through the driver's own SPY beta; never by an assumed 1.
  const marketBeta = driverMarketBeta(db, driver, { today });
  if (marketBeta === null) return refuse("no-driver-conversion");
  if (input.identitySecurityId !== null) {
    const spy = usableBeta(
      measuredRegression(db, input.identitySecurityId, MARKET_SYMBOL, today),
    );
    if (spy !== null) return { beta: spy / marketBeta, source: "market-converted" };
  }
  if (!Number.isFinite(input.heuristicMarketBeta)) return refuse("no-heuristic-beta");
  return { beta: input.heuristicMarketBeta / marketBeta, source: "estimated" };
}

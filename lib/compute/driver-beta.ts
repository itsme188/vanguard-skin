/**
 * A position's beta to the DRIVER index (Gains at risk, 2026-11-24; ladder
 * reworked by the addendum, rulings B1, B3, C3, C4, C13).
 *
 * The Gains at risk engine moves one index (the driver: SPY, QQQ or VTI in
 * step 1) and needs each position's beta to it, with an honest label for
 * where that number came from. There is NO estimate: a name either has a
 * beta measured from true daily closes, or it has "no measured link" with
 * the reason, and the engine decides what to do with it per case.
 *
 * THE RULES, first match wins (symbols trimmed and upper-cased):
 *   1. A leveraged or inverse fund, or an option on one: the tracked index's
 *      beta to the driver (1 when the tracked index IS the driver, else a
 *      bar-to-bar regression of the tracked index's series row on the
 *      driver's that comes out `measured`) times the signed factor ->
 *      "leveraged". The fund's own regression is never read (F5). No factor,
 *      no tracked index, or a tracked index that is not measured (no
 *      securities row included) is a refusal -> "not-modelled".
 *   2. The identity (or an option's stored underlying) IS the driver -> 1, "driver".
 *   3. A fixed engine value (cash-equivalent, bond, bond fund with no market move) -> "fixed".
 *   4. `computeDailyBarRegression(identitySecurityId, driverSecurityId)`
 *      with outcome `measured` -> "measured".
 *   5. Otherwise "no-measured-link" with its reason (`no-daily-bars` when the
 *      identity has no securities row).
 *
 * Only `outcome === "measured"` yields a beta. `DailyBarEvidence.beta` is
 * also set on `short-history` and `low-fit`; it is carried as evidence and
 * NEVER read as a beta here (the union below makes that a type error).
 *
 * READ-ONLY. Both legs come from `ohlcv_bars` (daily, priced bars, before
 * `today`). Reads no `prices`, no `benchmark_prices`, no `security_regressions`.
 * Nothing is cached across calls; a caller passes one `regressionMemo` per
 * request so each identity is regressed once.
 */

import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import type { LeveragedExposure } from "@/lib/compute/leveraged-fund";
import { isOptionSecurityType } from "@/lib/compute/option-elasticity";
import {
  computeDailyBarRegression,
  type DailyBarEvidence,
  type NoMeasuredLinkReason,
} from "@/lib/compute/security-regression";
import { PRICED_BAR_SQL } from "@/lib/queries/ohlcv";

export type DriverBetaSource = "driver" | "fixed" | "leveraged" | "measured";
export type DriverBetaRefusal =
  | "leveraged-no-factor"
  | "leveraged-no-tracked-index"
  | "tracked-index-not-measured";
export type DriverBeta =
  | { beta: number; source: "driver" | "fixed" }
  | {
      beta: number;
      source: "leveraged";
      /** The tracked index's beta to the driver (1 when it is the driver). */
      trackedBeta: number;
      /** The fund's signed leverage factor. */
      factor: number;
      /** The tracked index's regression; null when the tracked index is the driver. */
      evidence: DailyBarEvidence | null;
    }
  | { beta: number; source: "measured"; evidence: DailyBarEvidence }
  | { beta: null; source: "no-measured-link"; reason: NoMeasuredLinkReason; evidence: DailyBarEvidence }
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
  /** Leveraged rows: trackedIndexFor(identity symbol). */
  trackedIndexSymbol: string | null;
}

export interface ResolveDriverBetaOptions {
  /** The Eastern day; bars are read strictly before it. Default `todayET()`. */
  today?: string;
  /** `barSeriesSecurityId(db, driver)`, resolved once per request by the caller. */
  driverSecurityId: number | null;
  /** Per-request memo of bar regressions keyed by security id. Never kept across requests. */
  regressionMemo?: Map<number, DailyBarEvidence>;
}

function norm(symbol: string | null | undefined): string {
  return (symbol ?? "").trim().toUpperCase();
}

function refuse(reason: DriverBetaRefusal): DriverBeta {
  return { beta: null, source: "not-modelled", reason };
}

/** Evidence for an identity with no securities row: nothing could be read. */
function noRowEvidence(): DailyBarEvidence {
  return {
    outcome: "no-daily-bars",
    beta: null,
    rSquared: null,
    pairs: 0,
    securityBars: 0,
    driverBars: 0,
    droppedOutlierPairs: 0,
    droppedGapPairs: 0,
    firstDate: null,
    lastDate: null,
  };
}

/**
 * The securities row whose daily bars stand for a symbol: non-option,
 * `ib_con_id` set, most priced daily bars (`bar_size = '1 day'`,
 * `PRICED_BAR_SQL`, any date). Ties, a row with no bars included, go to the
 * lowest id, so the answer is deterministic. Symbol matched trimmed and
 * upper-cased. Null when no row qualifies (or a blank symbol); never throws.
 */
export function barSeriesSecurityId(db: Database.Database, symbol: string): number | null {
  const key = norm(symbol);
  if (key === "") return null;
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.security_type AS security_type,
              (SELECT COUNT(*) FROM ohlcv_bars b
                WHERE b.security_id = s.id AND b.bar_size = '1 day' AND ${PRICED_BAR_SQL}) AS bars
         FROM securities s
        WHERE UPPER(TRIM(s.symbol)) = ? AND s.ib_con_id IS NOT NULL
        ORDER BY bars DESC, s.id ASC`,
    )
    .all(key) as { id: number; security_type: string | null; bars: number }[];
  const pick = rows.find((r) => !isOptionSecurityType(r.security_type));
  return pick ? pick.id : null;
}

function regression(
  db: Database.Database,
  securityId: number,
  opts: ResolveDriverBetaOptions,
  today: string,
): DailyBarEvidence {
  const memo = opts.regressionMemo;
  const hit = memo?.get(securityId);
  if (hit !== undefined) return hit;
  const evidence = computeDailyBarRegression(db, securityId, opts.driverSecurityId, { today });
  memo?.set(securityId, evidence);
  return evidence;
}

/** The measured beta, only when the outcome is `measured` and the figure is finite. */
function measuredBeta(e: DailyBarEvidence): number | null {
  if (e.outcome !== "measured") return null;
  return e.beta !== null && Number.isFinite(e.beta) ? e.beta : null;
}

/**
 * A position's beta to the driver index, "no measured link" with its reason,
 * or a refusal. See the rules above. Throws on a blank `driverSymbol`.
 */
export function resolveDriverBeta(
  db: Database.Database,
  input: DriverBetaInput,
  driverSymbol: string,
  opts: ResolveDriverBetaOptions,
): DriverBeta {
  const driver = norm(driverSymbol);
  if (driver === "") throw new Error("driverSymbol is required");
  const today = opts.today ?? todayET();

  // 1. Leveraged or inverse: the tracked index times the signed factor.
  if (input.leveraged.flagged) {
    const factor = input.leveraged.factor;
    if (factor === null || !Number.isFinite(factor) || factor === 0) {
      return refuse("leveraged-no-factor");
    }
    const tracked = norm(input.trackedIndexSymbol);
    if (tracked === "") return refuse("leveraged-no-tracked-index");
    if (tracked === driver) {
      return { beta: factor, source: "leveraged", trackedBeta: 1, factor, evidence: null };
    }
    const trackedId = barSeriesSecurityId(db, tracked);
    if (trackedId === null) return refuse("tracked-index-not-measured");
    const evidence = regression(db, trackedId, opts, today);
    const trackedBeta = measuredBeta(evidence);
    if (trackedBeta === null) return refuse("tracked-index-not-measured");
    return { beta: trackedBeta * factor, source: "leveraged", trackedBeta, factor, evidence };
  }

  // 2. The driver itself, or an option on it (even with no underlying row).
  if (norm(input.identitySymbol) === driver || norm(input.storedUnderlyingSymbol) === driver) {
    return { beta: 1, source: "driver" };
  }

  // 3. The engine's fixed value.
  if (input.fixedBeta !== null) {
    return { beta: input.fixedBeta, source: "fixed" };
  }

  // 4. Measured from daily bars against the driver's daily bars.
  if (input.identitySecurityId === null) {
    return { beta: null, source: "no-measured-link", reason: "no-daily-bars", evidence: noRowEvidence() };
  }
  const evidence = regression(db, input.identitySecurityId, opts, today);
  const beta = measuredBeta(evidence);
  if (beta !== null) return { beta, source: "measured", evidence };

  // 5. No measured link, with the reason. A `measured` outcome with a
  //    non-finite beta cannot occur from OLS; it is read as low-fit, never a number.
  const reason: NoMeasuredLinkReason = evidence.outcome === "measured" ? "low-fit" : evidence.outcome;
  return { beta: null, source: "no-measured-link", reason, evidence };
}

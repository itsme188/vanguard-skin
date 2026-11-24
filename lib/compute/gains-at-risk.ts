/**
 * Gains at risk: the book's profit or loss under a sweep of moves of ONE
 * driver index, at a valuation date (Gains at risk, step 1, 2026-11-24;
 * two cases by the addendum, rulings B3, B4, C4, C5, C6, C12, C13).
 *
 * For every held row (one per account and security, F11) the engine finds
 * the row's beta to the driver (`resolveDriverBeta`: measured from daily bars
 * on both legs, or "no measured link" with a reason; never an estimate) and
 * prices it in TWO cases:
 *
 *   - "measured": each name at its measured beta. A name with no measured
 *     link has its underlying HELD UNCHANGED (beta 0) and is listed: a stock
 *     or fund row then has P&L exactly 0, and an option on it is still
 *     repriced at a 0% underlying move for time to the date, the volatility
 *     change and expiry (C5).
 *   - "selloff": an ASSUMPTION, never a measurement. Every equity-like
 *     identity (stock, ETF or mutual fund, case-insensitive; options through
 *     their underlying) moves at least one-for-one with the driver: beta is
 *     max(measured, 1), a negative measured beta becomes 1, a name with no
 *     measured link takes 1. A leveraged or inverse fund takes
 *     max(trackedBeta, 1) x factor, so an inverse fund still offsets. Fixed
 *     rows and the driver are the same in both cases.
 *
 * The owner's figure (`betaOverrides`, keyed by `identitySecurityId`: the
 * underlying's id for an option, the row's own otherwise) wins in BOTH cases
 * when finite, within `BETA_OVERRIDE_BOUNDS`, and on an identity that is
 * neither fixed nor the driver; all options on that underlying follow. A key
 * matching no position is ignored and counted (`betaOverridesIgnored`).
 *
 * The thing a row tracks moves by beta x move (floored at -100%), and is repriced:
 *   - a stock, fund or bond: market value x that move;
 *   - an option: `repriceOptionUnderShock` at the valuation date. An
 *     own-priced row takes market value x changePercent; a model-priced row,
 *     an owner-priced (override) row and a row that expires before the date
 *     take per-share change x quantity x multiplier x FX (market value is
 *     zero on an unpriced row, so a percent of it would print nothing). A row
 *     that expires before the date takes the worse of "the move lands after
 *     expiry" and "the move lands first" (F4).
 *
 * NOTHING VANISHES. A row that cannot be modelled (no price, no FX rate, a
 * refused leveraged beta, an option the model cannot price in either case)
 * contributes zero to every move in both cases and is listed under
 * `notModelled` with its reason; a row whose value is unknown carries
 * `valueUsd: null` and is counted, never shown as a 0% share (F12).
 *
 * The split (F15, down direction), per case: a row whose dollar exposure to
 * the driver is positive LOSES in a fall; negative OFFSETS it; zero or not
 * modelled is flat. For every move and case, book = losers + offsets.
 *
 * READ-ONLY over the database. Reads no `benchmark_prices` row and no
 * `prices` row for a beta (C3); the driver's bars are read through its own
 * securities row (`barSeriesSecurityId`), once per run, and every regression
 * is memoised within the run only. Throws a worded Error on a bad input
 * (blank driver, impossible or past valuation date, non-finite move or
 * volatility change) as `GainsAtRiskInputError` so the route can answer 400.
 */

import type Database from "better-sqlite3";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";
import { getOhlcvBars } from "@/lib/queries/ohlcv";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { BETA_OVERRIDE_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import { resolveLeveragedExposure, type LeveragedExposure } from "./leveraged-fund";
import { isOptionSecurityType, normalizeExpirationDate } from "./option-elasticity";
import {
  repriceOptionUnderShock,
  type OptionRepriceResult,
  type OptionUnmodelledReason,
} from "./option-reprice";
import {
  barSeriesSecurityId,
  resolveDriverBeta,
  type DriverBeta,
  type DriverBetaInput,
  type DriverBetaRefusal,
  type DriverBetaSource,
} from "./driver-beta";
import {
  DAILY_BAR_WINDOW_DAYS,
  type DailyBarEvidence,
  type NoMeasuredLinkReason,
} from "./security-regression";
import { LEVERAGED_TRACKED_INDEX_SEEDS, trackedIndexFor } from "@/lib/securities/leveraged-tracked-index";
import { equityIdentity } from "./scenario-recipes";
import { estimateBeta, isBondFundWithoutMarketMove } from "./scenarios";
import { loadScenarioPositionsByAccount, type ScenarioPositionAccountRow } from "./scenario-positions";
import { mapSecurityType } from "@/lib/tws/security-type-map";

// ─── Types ──────────────────────────────────────────────────────

export interface GainsAtRiskInput {
  /** `undefined` is every account; `[]` is none and reads nothing. */
  accountIds?: number[];
  driverSymbol: string;
  /** YYYY-MM-DD, not before today. Today means the current instant; a later day means that day's close (F16). */
  valuationDate: string;
  /** Driver moves as decimals, e.g. -0.2 for -20%; each finite and at least -1. */
  moves: number[];
  /** Volatility change in points (15 = +15 points). */
  volChangePoints: number;
  /** Owner-entered option prices per share, by security id; only for a row with no price of its own. */
  priceOverrides?: Record<number, number>;
  /**
   * The owner's own figure per name: the name's move per unit of driver move,
   * keyed by `identitySecurityId` (C6). Used in both cases. Page state only; never stored.
   */
  betaOverrides?: Record<number, number>;
  /** Injected for tests; default the Eastern day and the wall clock, each read once. */
  today?: string;
  now?: Date;
}

export interface GainsAtRiskOptions {
  /** Tracked-index map for leveraged funds; defaults to the shipped `LEVERAGED_TRACKED_INDEX_SEEDS`. */
  trackedIndexSeeds?: Readonly<Record<string, string>>;
}

export type GainsAtRiskCaseKey = "measured" | "selloff";
/** The two cases, in display order (Measured is the default). */
export const GAINS_AT_RISK_CASE_KEYS: readonly GainsAtRiskCaseKey[] = Object.freeze(["measured", "selloff"]);

export type GainsAtRiskSide = "loses" | "offsets" | "flat";
export type GainsAtRiskUnmodelled = DriverBetaRefusal | OptionUnmodelledReason | "no-price" | "no-fx-rate";
export type GainsAtRiskOverrideRefusal =
  | "not-positive"
  | "below-intrinsic"
  | "row-has-price"
  | "not-solvable"
  /** The override is keyed to a stock, fund or bond: overrides price options only. */
  | "not-an-option";
export type GainsAtRiskBetaSource = DriverBetaSource | "owner" | "no-measured-link" | "not-modelled";
export type GainsAtRiskBetaOverrideRefusal = "fixed-row" | "is-driver" | "out-of-bounds";

export interface GainsAtRiskPositionCase {
  /** The underlying's move per unit driver move in this case; 0 = held unchanged; null = not modelled. */
  beta: number | null;
  /** Dollars, one per input move, in the input's order. Zero on a not-modelled row. */
  pnlByMove: number[];
  side: GainsAtRiskSide;
  /** Dollar change per unit driver move at today's prices (valuation today, no vol change), at this case's beta. */
  exposureUsd: number;
}

export interface GainsAtRiskPosition {
  accountId: number;
  accountName: string;
  securityId: number;
  symbol: string;
  name: string | null;
  /** The underlying's securities id for an option, the row's own otherwise; null when the underlying has no row. */
  identitySecurityId: number | null;
  /** "owner" when the owner's figure was accepted; else the ladder's source. */
  betaSource: GainsAtRiskBetaSource;
  /** The ladder's beta (driver, fixed, leveraged or measured), before any owner figure; null otherwise. */
  measuredBeta: number | null;
  /** The identity's bar regression, when one ran (measured or no measured link). */
  evidence?: DailyBarEvidence;
  /** Set when the ladder found no measured link (also when the owner's figure then won). */
  noMeasuredLinkReason?: NoMeasuredLinkReason;
  betaOverrideRefusal?: GainsAtRiskBetaOverrideRefusal;
  /** Set when the owner's figure prices a row the ladder refused (e.g. a fund with no tracked index): why the app could not model it. */
  ladderRefusal?: DriverBetaRefusal;
  priceSource: "own-price" | "model" | "override" | null;
  /** Model value today, per share, on a model-priced row. */
  modelPricePerShare?: number;
  expiresBeforeDate?: true;
  /** Options: the normalized expiry. */
  expiry?: string;
  unmodelledReason?: GainsAtRiskUnmodelled;
  overrideRefusal?: GainsAtRiskOverrideRefusal;
  /** Signed USD value; null = value unknown (F12). */
  valueUsd: number | null;
  cases: Record<GainsAtRiskCaseKey, GainsAtRiskPositionCase>;
}

export interface GainsAtRiskMoveRow {
  move: number;
  bookPnlUsd: number;
  losersPnlUsd: number;
  offsetsPnlUsd: number;
}

export interface GainsAtRiskDisclosure {
  count: number;
  /** Σ|known listed values| / grossBookUsd; null when the gross book is zero. */
  shareOfBook: number | null;
  /** Listed rows whose value is unknown. */
  unknownValueCount: number;
  symbols: string[];
}

export interface GainsAtRiskCase {
  moves: GainsAtRiskMoveRow[];
  disclosures: {
    notModelled: GainsAtRiskDisclosure;
    /** Modelled rows the ladder found no measured link for (and no owner's figure replaced). Same rows in both cases. */
    noMeasuredLink: GainsAtRiskDisclosure & { reasons: Record<NoMeasuredLinkReason, number> };
    /** Modelled rows priced at the owner's figure. */
    ownerFigure: GainsAtRiskDisclosure;
    pricedFromModel: GainsAtRiskDisclosure;
    expiresBeforeDate: GainsAtRiskDisclosure;
  };
}

export interface GainsAtRiskBetaEvidence {
  /** Latest priced daily bar of the driver before today, in the regression window; null when none. */
  driverBarsThrough: string | null;
  /** No driver series row, or no priced driver bar in the regression window. */
  driverBarsMissing: boolean;
  /** Distinct identities whose reason is `no-daily-bars` (C13). */
  namesWaitingForBars: number;
}

export interface GainsAtRiskResult {
  driverSymbol: string;
  valuationDate: string;
  volChangePoints: number;
  /** Σ|valueUsd| over rows with a known value, per account row (F11). */
  grossBookUsd: number;
  /** Rows whose value is unknown. */
  unknownValueCount: number;
  positions: GainsAtRiskPosition[];
  cases: Record<GainsAtRiskCaseKey, GainsAtRiskCase>;
  betaEvidence: GainsAtRiskBetaEvidence;
  /** Owner's-figure keys that match no position's identity. */
  betaOverridesIgnored: number;
}

// ─── Input checks ───────────────────────────────────────────────

/**
 * A refusal of the caller's input (blank driver, impossible or past date,
 * non-finite or below -100% move, non-finite volatility change). The route
 * answers 400 for this class and 500 for anything else.
 *
 * `checkInput` refuses every date the option repricer would refuse (same
 * calendar test, same `today`), so the repricer's own untyped date errors
 * cannot be reached from this engine.
 */
export class GainsAtRiskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GainsAtRiskInputError";
  }
}

/** A real calendar day in YYYY-MM-DD (2026-02-30 fails); the same test the option repricer applies. */
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function checkInput(input: GainsAtRiskInput, today: string): string {
  const driver = (input.driverSymbol ?? "").trim().toUpperCase();
  if (driver === "") throw new GainsAtRiskInputError("driverSymbol is required");
  if (typeof input.valuationDate !== "string" || !isCalendarDay(input.valuationDate)) {
    throw new GainsAtRiskInputError("valuationDate is not a valid date");
  }
  if (input.valuationDate < today) throw new GainsAtRiskInputError("valuationDate is before today");
  if (!Array.isArray(input.moves) || input.moves.some((m) => typeof m !== "number" || !Number.isFinite(m))) {
    throw new GainsAtRiskInputError("moves must be finite numbers");
  }
  // A driver cannot fall more than 100%; a deeper move would credit an
  // inverse fund or a put with a gain no price path can produce.
  if (input.moves.some((m) => m < -1)) throw new GainsAtRiskInputError("moves must be at least -1");
  if (typeof input.volChangePoints !== "number" || !Number.isFinite(input.volChangePoints)) {
    throw new GainsAtRiskInputError("volChangePoints must be a finite number");
  }
  return driver;
}

// ─── Helpers ────────────────────────────────────────────────────

/** -0 prints as 0; anything else passes through (a NaN is never hidden here). */
function clean(x: number): number {
  return x === 0 ? 0 : x;
}

function intrinsicToday(row: ScenarioPositionAccountRow): number | null {
  const type = (row.option_type ?? "").trim().toUpperCase();
  const K = row.strike_price;
  const S = row.underlying_price;
  if (K == null || S == null || !(S > 0)) return null;
  if (type.startsWith("P")) return Math.max(K - S, 0);
  if (type.startsWith("C")) return Math.max(S - K, 0);
  return null;
}

function disclosure(rows: GainsAtRiskPosition[], grossBookUsd: number): GainsAtRiskDisclosure {
  let known = 0;
  let unknownValueCount = 0;
  for (const r of rows) {
    if (r.valueUsd === null) unknownValueCount += 1;
    else known += Math.abs(r.valueUsd);
  }
  return {
    count: rows.length,
    shareOfBook: grossBookUsd > 0 ? known / grossBookUsd : null,
    unknownValueCount,
    symbols: [...new Set(rows.map((r) => r.symbol))].sort(),
  };
}

const NO_MEASURED_LINK_REASONS: readonly NoMeasuredLinkReason[] = [
  "foreign-session",
  "driver-bars-missing",
  "no-daily-bars",
  "short-history",
  "flat-driver",
  "low-fit",
];

function reasonCounts(rows: GainsAtRiskPosition[]): Record<NoMeasuredLinkReason, number> {
  const out = Object.fromEntries(NO_MEASURED_LINK_REASONS.map((r) => [r, 0])) as Record<NoMeasuredLinkReason, number>;
  for (const p of rows) if (p.noMeasuredLinkReason !== undefined) out[p.noMeasuredLinkReason] += 1;
  return out;
}

function caseFor(
  key: GainsAtRiskCaseKey,
  positions: GainsAtRiskPosition[],
  moves: number[],
  grossBookUsd: number,
): GainsAtRiskCase {
  const rows: GainsAtRiskMoveRow[] = moves.map((move, i) => {
    let losers = 0;
    let offsets = 0;
    for (const p of positions) {
      const c = p.cases[key];
      if (c.side === "offsets") offsets += c.pnlByMove[i];
      else if (c.side === "loses") losers += c.pnlByMove[i];
      // "flat" rows carry exactly zero at every move, so book = losers + offsets.
    }
    return { move, bookPnlUsd: clean(losers + offsets), losersPnlUsd: clean(losers), offsetsPnlUsd: clean(offsets) };
  });
  const modelled = positions.filter((p) => p.unmodelledReason === undefined);
  const noLink = modelled.filter((p) => p.betaSource === "no-measured-link");
  return {
    moves: rows,
    disclosures: {
      notModelled: disclosure(positions.filter((p) => p.unmodelledReason !== undefined), grossBookUsd),
      noMeasuredLink: { ...disclosure(noLink, grossBookUsd), reasons: reasonCounts(noLink) },
      ownerFigure: disclosure(modelled.filter((p) => p.betaSource === "owner"), grossBookUsd),
      pricedFromModel: disclosure(modelled.filter((p) => p.priceSource === "model"), grossBookUsd),
      expiresBeforeDate: disclosure(modelled.filter((p) => p.expiresBeforeDate === true), grossBookUsd),
    },
  };
}

function emptyResult(driver: string, input: GainsAtRiskInput): GainsAtRiskResult {
  const cases = {} as Record<GainsAtRiskCaseKey, GainsAtRiskCase>;
  for (const k of GAINS_AT_RISK_CASE_KEYS) cases[k] = caseFor(k, [], input.moves, 0);
  return {
    driverSymbol: driver,
    valuationDate: input.valuationDate,
    volChangePoints: input.volChangePoints,
    grossBookUsd: 0,
    unknownValueCount: 0,
    positions: [],
    cases,
    // Nothing is read for an empty scope, so nothing is reported missing.
    betaEvidence: { driverBarsThrough: null, driverBarsMissing: false, namesWaitingForBars: 0 },
    betaOverridesIgnored: Object.keys(input.betaOverrides ?? {}).length,
  };
}

/** Stock, ETF or mutual fund (case-insensitive): the identities the selloff floor applies to. */
/*
 * Equity-like identity types (review fix 1): read through the single type
 * mapper (`mapSecurityType`), as `isMoverSecurityType` does. The mapper
 * defaults an unknown type to the stock class, so the mapper's class alone is
 * not enough: the trimmed, lower-cased stored type must also be one of these
 * spellings. Fail closed: a future, forex, cash, warrant or unknown type is not
 * floored and keeps its measured beta.
 */
const EQUITY_CLASS = mapSecurityType("stock");
const FUND_CLASS = mapSecurityType("mutual fund");
const EQUITY_LIKE_TYPES: ReadonlySet<string> = new Set([
  "stock",
  "etf",
  "mutual fund",
  "mutual_fund",
  "adr",
  "reit",
  "closed-end fund",
  "closed end fund",
  "closed_end_fund",
]);

/** Stock, ETF or mutual fund in any spelling the mapper reads (plus ADR, REIT, closed-end fund): floored in the selloff case. */
export function isEquityLikeType(type: string | null | undefined): boolean {
  const t = (type ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (t === "") return false;
  const cls = mapSecurityType(t);
  if (cls !== EQUITY_CLASS && cls !== FUND_CLASS) return false;
  return EQUITY_LIKE_TYPES.has(t);
}

/**
 * A row's side in one case (review fix 2). Exposure decides when it is not
 * zero. A row with zero exposure (its underlying held unchanged) can still
 * carry P&L on its options (time decay, a volatility change), the same at
 * every move: a loss "loses", a gain "offsets", exactly zero is "flat" (in
 * neither column). Mixed signs cannot arise with the underlying held
 * unchanged; should they, the row "loses" (never credited as an offset).
 */
function sideOf(exposureUsd: number, pnlByMove: number[]): GainsAtRiskSide {
  if (exposureUsd > 0) return "loses";
  if (exposureUsd < 0) return "offsets";
  const anyLoss = pnlByMove.some((x) => x < 0);
  const anyGain = pnlByMove.some((x) => x > 0);
  if (anyGain && !anyLoss) return "offsets";
  if (anyLoss) return "loses";
  return "flat";
}

type CaseBetas = Record<GainsAtRiskCaseKey, number | null>;

/** Per-case beta of an identity; see the module comment. `owner` is an accepted owner's figure. */
function caseBetas(resolved: DriverBeta, owner: number | undefined, equityLike: boolean): CaseBetas {
  if (owner !== undefined) return { measured: owner, selloff: owner };
  switch (resolved.source) {
    case "driver":
    case "fixed":
      return { measured: resolved.beta, selloff: resolved.beta };
    case "leveraged":
      return {
        measured: resolved.trackedBeta * resolved.factor,
        selloff: Math.max(resolved.trackedBeta, 1) * resolved.factor,
      };
    case "measured":
      return { measured: resolved.beta, selloff: equityLike ? Math.max(resolved.beta, 1) : resolved.beta };
    case "no-measured-link":
      return { measured: 0, selloff: equityLike ? 1 : 0 };
    case "not-modelled":
      return { measured: null, selloff: null };
  }
}

// ─── Engine ─────────────────────────────────────────────────────

export function computeGainsAtRisk(
  db: Database.Database,
  input: GainsAtRiskInput,
  opts?: GainsAtRiskOptions,
): GainsAtRiskResult {
  // The clock is read ONCE: every option shares one time to expiry.
  const today = input.today ?? todayET();
  const now = input.now ?? new Date();
  const driver = checkInput(input, today);
  if (input.accountIds !== undefined && input.accountIds.length === 0) return emptyResult(driver, input);

  const seeds = opts?.trackedIndexSeeds ?? LEVERAGED_TRACKED_INDEX_SEEDS;
  const rows = loadScenarioPositionsByAccount(db, input.accountIds, { today });
  const riskFreeRate = getRiskFreeRate(db);
  const volChange = input.volChangePoints / 100;
  const overrides = input.priceOverrides ?? {};
  const betaOverrides = input.betaOverrides ?? {};

  // The driver's own series row and its bars: read once per run (C3).
  const driverSecurityId = barSeriesSecurityId(db, driver);
  const driverBars =
    driverSecurityId === null
      ? []
      : getOhlcvBars(db, driverSecurityId, "1 day", {
          startDate: addDays(today, -DAILY_BAR_WINDOW_DAYS),
          endDate: addDays(today, -1),
        });
  const regressionMemo = new Map<number, DailyBarEvidence>();
  const betaMemo = new Map<string, DriverBeta>();
  /** Distinct identities whose reason is no-daily-bars: by id, else by identity symbol. */
  const waitingForBars = new Set<string>();

  const positions = rows.map((row): GainsAtRiskPosition => {
    const isOption = isOptionSecurityType(row.security_type);
    const identitySecurityId = isOption ? row.underlying_security_id : row.security_id;
    const base = {
      accountId: row.account_id,
      accountName: row.account_name,
      securityId: row.security_id,
      symbol: row.symbol,
      name: row.security_name,
      identitySecurityId,
      ...(isOption && row.expiration_date
        ? { expiry: normalizeExpirationDate(row.expiration_date) ?? row.expiration_date }
        : {}),
    };
    const ownPriced = (row.own_price ?? 0) > 0;
    const flatCase = (beta: null): GainsAtRiskPositionCase => ({
      beta,
      pnlByMove: input.moves.map(() => 0),
      side: "flat",
      exposureUsd: 0,
    });
    const notModelled = (
      reason: GainsAtRiskUnmodelled,
      valueUsd: number | null,
      extra: Partial<GainsAtRiskPosition> = {},
    ): GainsAtRiskPosition => ({
      ...base,
      betaSource: "not-modelled",
      measuredBeta: null,
      // A row whose value is unknown has no price source to show.
      priceSource: ownPriced && valueUsd !== null ? "own-price" : null,
      unmodelledReason: reason,
      valueUsd,
      ...extra,
      cases: { measured: flatCase(null), selloff: flatCase(null) },
    });

    // 1. A foreign row with no rate cannot be put in dollars at all.
    const currency = (row.currency ?? "USD").trim().toUpperCase();
    if (currency !== "USD" && row.fx_usd_per_unit == null) return notModelled("no-fx-rate", null);

    // 2. A stock, fund or bond with no price of its own: listed, value unknown.
    //    (An override is for an option's model price only.)
    const overrideRaw = Object.prototype.hasOwnProperty.call(overrides, row.security_id)
      ? overrides[row.security_id]
      : undefined;
    if (!isOption && !ownPriced) {
      return notModelled("no-price", null, overrideRaw !== undefined ? { overrideRefusal: "not-an-option" } : {});
    }

    // 3. The owner's price for an unpriced option (F13).
    let pricingRow: ScenarioPositionAccountRow = row;
    let overrideRefusal: GainsAtRiskOverrideRefusal | undefined;
    let overrideAccepted = false;
    if (overrideRaw !== undefined) {
      if (!isOption) {
        overrideRefusal = "not-an-option";
      } else if (ownPriced) {
        overrideRefusal = "row-has-price";
      } else if (typeof overrideRaw !== "number" || !Number.isFinite(overrideRaw) || !(overrideRaw > 0)) {
        overrideRefusal = "not-positive";
      } else {
        const floor = intrinsicToday(row);
        if (floor !== null && overrideRaw < floor) {
          overrideRefusal = "below-intrinsic";
        } else {
          const probe = repriceOptionUnderShock(
            { ...row, own_price: overrideRaw },
            { underlyingMove: 0, riskFreeRate, today, now, valuationDate: today },
          );
          if (probe.modelled && probe.ivSource === "own-price") {
            pricingRow = { ...row, own_price: overrideRaw };
            overrideAccepted = true;
          } else {
            overrideRefusal = "not-solvable";
          }
        }
      }
    }
    const refusalField = overrideRefusal ? { overrideRefusal } : {};

    // 4. Beta to the driver: the ladder, then the owner's figure.
    const leveraged: LeveragedExposure = resolveLeveragedExposure(
      {
        security_type: row.security_type,
        fund_category: row.fund_category,
        name: row.security_name,
        leverage_factor: row.leverage_factor,
      },
      row.underlying_security_type == null
        ? null
        : {
            security_type: row.underlying_security_type,
            fund_category: row.underlying_fund_category,
            name: row.underlying_name,
            leverage_factor: row.underlying_leverage_factor,
          },
    );
    const identity = equityIdentity(row);
    const zeroBeta =
      isCashEquivalentSecurity({ security_type: row.security_type, fund_category: row.fund_category }) ||
      isBondFundWithoutMarketMove(row);
    const betaType = isOption ? row.underlying_security_type ?? "stock" : row.security_type;
    // estimateBeta is read for the bond's fixed 0.1 only; it never prices an equity.
    const fixedBeta = zeroBeta
      ? 0
      : betaType.toLowerCase() === "bond"
        ? estimateBeta(betaType, identity.sector, row.style, row.market_cap_category, false)
        : null;
    const betaInput: DriverBetaInput = {
      securityId: row.security_id,
      identitySymbol: identity.symbol,
      storedUnderlyingSymbol: isOption ? row.stored_underlying_symbol : null,
      identitySecurityId,
      leveraged,
      fixedBeta,
      trackedIndexSymbol: leveraged.flagged ? trackedIndexFor(identity.symbol, seeds) : null,
    };
    const { securityId: _ignored, ...identityKey } = betaInput;
    const memoKey = JSON.stringify(identityKey);
    let resolved = betaMemo.get(memoKey);
    if (resolved === undefined) {
      resolved = resolveDriverBeta(db, betaInput, driver, { today, driverSecurityId, regressionMemo });
      betaMemo.set(memoKey, resolved);
    }
    if (resolved.source === "no-measured-link" && resolved.reason === "no-daily-bars") {
      waitingForBars.add(
        identitySecurityId !== null ? `id:${identitySecurityId}` : `sym:${identity.symbol.trim().toUpperCase()}`,
      );
    }

    // The owner's figure (C6): keyed by the identity, refused on a fixed row or the driver.
    let ownerBeta: number | undefined;
    let betaOverrideRefusal: GainsAtRiskBetaOverrideRefusal | undefined;
    if (
      identitySecurityId !== null &&
      Object.prototype.hasOwnProperty.call(betaOverrides, identitySecurityId)
    ) {
      const raw: unknown = betaOverrides[identitySecurityId];
      if (resolved.source === "fixed") betaOverrideRefusal = "fixed-row";
      else if (resolved.source === "driver") betaOverrideRefusal = "is-driver";
      else if (
        typeof raw !== "number" ||
        !Number.isFinite(raw) ||
        raw < BETA_OVERRIDE_BOUNDS.min ||
        raw > BETA_OVERRIDE_BOUNDS.max
      ) {
        betaOverrideRefusal = "out-of-bounds";
      } else {
        ownerBeta = raw;
      }
    }

    const equityLike = isEquityLikeType(betaType);
    const betas = caseBetas(resolved, ownerBeta, equityLike);
    const betaSource: GainsAtRiskBetaSource = ownerBeta !== undefined ? "owner" : resolved.source;
    const betaFields: Partial<GainsAtRiskPosition> = {
      betaSource,
      measuredBeta: resolved.beta,
      ...(resolved.source === "measured" || resolved.source === "no-measured-link"
        ? { evidence: resolved.evidence }
        : {}),
      ...(resolved.source === "no-measured-link" ? { noMeasuredLinkReason: resolved.reason } : {}),
      ...(betaOverrideRefusal ? { betaOverrideRefusal } : {}),
      ...(resolved.source === "not-modelled" && ownerBeta !== undefined ? { ladderRefusal: resolved.reason } : {}),
    };

    const optionValueIfUnmodelled = overrideAccepted
      ? (pricingRow.own_price as number) * row.total_qty * row.multiplier * row.usd_per_unit
      : ownPriced
        ? row.market_value
        : null;

    if (resolved.source === "not-modelled" && ownerBeta === undefined) {
      return notModelled(resolved.reason, isOption ? optionValueIfUnmodelled : row.market_value, {
        ...refusalField,
        ...(betaOverrideRefusal ? { betaOverrideRefusal } : {}),
      });
    }

    // 5. Price every move in each case.
    const units = row.total_qty * row.multiplier * row.usd_per_unit;
    type Priced = { pnl: number; result?: OptionRepriceResult & { modelled: true } };
    const priceAt = (
      beta: number,
      move: number,
      valuationDate: string,
      vol: number,
    ): Priced | { unmodelled: OptionUnmodelledReason } => {
      const underlyingMove = Math.max(beta * move, -1);
      if (!isOption) return { pnl: row.market_value * underlyingMove };
      const r = repriceOptionUnderShock(pricingRow, {
        underlyingMove,
        volChange: vol,
        riskFreeRate,
        today,
        now,
        valuationDate,
        modelWhenUnpriced: true,
      });
      if (!r.modelled) return { unmodelled: r.reason };
      if (r.expiresBeforeDate) {
        // perShareChange describes v1 (the move lands after expiry); the
        // move-first case is computed here. The worse for the owner stands,
        // its sign carried by the quantity (F4).
        const after = r.perShareChange * units;
        const first = ((r.v1IfMoveFirst ?? r.v1) - r.v0) * units;
        return { pnl: Math.min(after, first), result: r };
      }
      if (r.priceSource === "model" || overrideAccepted) return { pnl: r.perShareChange * units, result: r };
      return { pnl: row.market_value * r.changePercent, result: r };
    };

    const pricedByCase = {} as Record<GainsAtRiskCaseKey, Priced[]>;
    let failure: OptionUnmodelledReason | undefined;
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      const beta = betas[k] as number;
      const priced = input.moves.map((m) => priceAt(beta, m, input.valuationDate, volChange));
      const failed = priced.find((p): p is { unmodelled: OptionUnmodelledReason } => "unmodelled" in p);
      if (failed) {
        failure = failed.unmodelled;
        break;
      }
      pricedByCase[k] = priced as Priced[];
    }
    if (failure !== undefined) {
      // An option the model cannot price is left out of BOTH cases, listed once.
      // Nothing on the row reads as a beta (review fix 5): betaSource
      // "not-modelled", no measuredBeta, per-case beta null. The underlying's
      // evidence, reason and any figure refusal stay in their own fields.
      return notModelled(failure, optionValueIfUnmodelled, {
        ...refusalField,
        ...(resolved.source === "measured" || resolved.source === "no-measured-link"
          ? { evidence: resolved.evidence }
          : {}),
        ...(resolved.source === "no-measured-link" ? { noMeasuredLinkReason: resolved.reason } : {}),
        ...(betaOverrideRefusal ? { betaOverrideRefusal } : {}),
        priceSource: overrideAccepted ? "override" : ownPriced ? "own-price" : null,
      });
    }

    const caseOut = (k: GainsAtRiskCaseKey): GainsAtRiskPositionCase => {
      const beta = betas[k] as number;
      // Exposure: today, no volatility change, ±1% of the driver.
      const up = priceAt(beta, 0.01, today, 0);
      const down = priceAt(beta, -0.01, today, 0);
      const exposureUsd = "pnl" in up && "pnl" in down ? clean((up.pnl - down.pnl) / 0.02) : 0;
      const pnlByMove = pricedByCase[k].map((p) => clean(p.pnl));
      return { beta, pnlByMove, side: sideOf(exposureUsd, pnlByMove), exposureUsd };
    };

    // Value and price source: v0 does not depend on the move or the case.
    const anyResult = pricedByCase.measured.find((p) => p.result)?.result;
    let priceSource: GainsAtRiskPosition["priceSource"];
    let valueUsd: number;
    let modelPricePerShare: number | undefined;
    if (!isOption) {
      priceSource = "own-price";
      valueUsd = row.market_value;
    } else if (overrideAccepted) {
      priceSource = "override";
      valueUsd = (pricingRow.own_price as number) * units;
    } else if (ownPriced) {
      priceSource = "own-price";
      valueUsd = row.market_value;
    } else {
      // Model-priced. With no moves at all, price once at rest to read it.
      const r =
        anyResult ??
        (() => {
          const rest = priceAt(0, 0, today, 0);
          return "result" in rest ? rest.result : undefined;
        })();
      priceSource = "model";
      modelPricePerShare = r?.v0;
      valueUsd = (r?.v0 ?? 0) * units;
    }

    const expiresBeforeDate = GAINS_AT_RISK_CASE_KEYS.some((k) =>
      pricedByCase[k].some((p) => p.result?.expiresBeforeDate === true),
    );

    return {
      ...base,
      betaSource,
      measuredBeta: resolved.beta,
      ...betaFields,
      priceSource,
      ...(modelPricePerShare !== undefined ? { modelPricePerShare } : {}),
      ...(expiresBeforeDate ? { expiresBeforeDate: true as const } : {}),
      ...refusalField,
      valueUsd: clean(valueUsd),
      cases: { measured: caseOut("measured"), selloff: caseOut("selloff") },
    };
  });

  // ─── Totals, cases and evidence ───────────────────────────────
  let grossBookUsd = 0;
  let unknownValueCount = 0;
  for (const p of positions) {
    if (p.valueUsd === null) unknownValueCount += 1;
    else grossBookUsd += Math.abs(p.valueUsd);
  }

  const cases = {} as Record<GainsAtRiskCaseKey, GainsAtRiskCase>;
  for (const k of GAINS_AT_RISK_CASE_KEYS) cases[k] = caseFor(k, positions, input.moves, grossBookUsd);

  // A key is applied (or refused on the row) only where a row with that
  // identity reached the beta: a key matching no identity, or only rows left
  // out for a non-beta reason (no price, no FX rate, an option the model
  // cannot price), is ignored and counted (review fix 4).
  const appliedIdentities = new Set<number>();
  for (const p of positions) {
    if (p.identitySecurityId === null) continue;
    if (p.unmodelledReason === undefined || p.betaOverrideRefusal !== undefined) {
      appliedIdentities.add(p.identitySecurityId);
    }
  }
  let betaOverridesIgnored = 0;
  for (const key of Object.keys(betaOverrides)) {
    const id = Number(key);
    if (!Number.isInteger(id) || !appliedIdentities.has(id)) betaOverridesIgnored += 1;
  }

  return {
    driverSymbol: driver,
    valuationDate: input.valuationDate,
    volChangePoints: input.volChangePoints,
    grossBookUsd,
    unknownValueCount,
    positions,
    cases,
    betaEvidence: {
      driverBarsThrough: driverBars.length > 0 ? driverBars[driverBars.length - 1].date : null,
      driverBarsMissing: driverBars.length === 0,
      namesWaitingForBars: waitingForBars.size,
    },
    betaOverridesIgnored,
  };
}

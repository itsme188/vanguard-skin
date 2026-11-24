/**
 * Gains at risk: the book's profit or loss under a sweep of moves of ONE
 * driver index, at a valuation date (Gains at risk, step 1, 2026-11-24).
 *
 * For every held row (one per account and security, F11) the engine finds
 * the row's beta to the driver (`resolveDriverBeta`), moves the thing the
 * row tracks by beta x move (floored at -100%), and reprices it:
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
 * refused beta, an option the model cannot price) contributes zero to every
 * move and is listed under `disclosures.notModelled` with its reason; a row
 * whose value is unknown carries `valueUsd: null` and is counted, never
 * shown as a 0% share (F12).
 *
 * The split (F15, down direction): a row whose dollar exposure to the driver
 * is positive LOSES in a fall; negative OFFSETS it; zero or not modelled is
 * flat. For every move, book = losers + offsets.
 *
 * READ-ONLY over the database. Throws a worded Error on a bad input (blank
 * driver, impossible or past valuation date, non-finite move or volatility
 * change) so the route can answer 400; it never prints zeros for one.
 */

import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { resolveLeveragedExposure, type LeveragedExposure } from "./leveraged-fund";
import { isOptionSecurityType, normalizeExpirationDate } from "./option-elasticity";
import {
  repriceOptionUnderShock,
  type OptionRepriceResult,
  type OptionUnmodelledReason,
} from "./option-reprice";
import {
  resolveDriverBeta,
  type DriverBeta,
  type DriverBetaInput,
  type DriverBetaRefusal,
  type DriverBetaSource,
} from "./driver-beta";
import { LEVERAGED_TRACKED_INDEX_SEEDS, trackedIndexFor } from "@/lib/securities/leveraged-tracked-index";
import { equityIdentity } from "./scenario-recipes";
import { estimateBeta, isBondFundWithoutMarketMove } from "./scenarios";
import { loadScenarioPositionsByAccount, type ScenarioPositionAccountRow } from "./scenario-positions";

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
  /** Injected for tests; default the Eastern day and the wall clock, each read once. */
  today?: string;
  now?: Date;
}

export interface GainsAtRiskOptions {
  /** Tracked-index map for leveraged funds; defaults to the shipped `LEVERAGED_TRACKED_INDEX_SEEDS`. */
  trackedIndexSeeds?: Readonly<Record<string, string>>;
}

export type GainsAtRiskSide = "loses" | "offsets" | "flat";
export type GainsAtRiskUnmodelled = DriverBetaRefusal | OptionUnmodelledReason | "no-price" | "no-fx-rate";
export type GainsAtRiskOverrideRefusal =
  | "not-positive"
  | "below-intrinsic"
  | "row-has-price"
  | "not-solvable"
  /** The override is keyed to a stock, fund or bond: overrides price options only. */
  | "not-an-option";

export interface GainsAtRiskPosition {
  accountId: number;
  accountName: string;
  securityId: number;
  symbol: string;
  name: string | null;
  side: GainsAtRiskSide;
  /** Beta to the driver when one resolved (also on a row an option reason then left out); null otherwise. */
  beta: number | null;
  betaSource: DriverBetaSource | "not-modelled";
  /** The tracked thing's move per unit of driver move (the beta used); null when not modelled. */
  assumedMovePerUnitDriver: number | null;
  /** Dollars, one per input move, in the input's order. Zero on a not-modelled row. */
  pnlByMove: number[];
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
  /** Dollar change per unit driver move at today's prices (valuation today, no vol change). */
  exposureUsd: number;
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

export interface GainsAtRiskResult {
  driverSymbol: string;
  valuationDate: string;
  volChangePoints: number;
  /** Σ|valueUsd| over rows with a known value, per account row (F11). */
  grossBookUsd: number;
  /** Rows whose value is unknown. */
  unknownValueCount: number;
  moves: GainsAtRiskMoveRow[];
  positions: GainsAtRiskPosition[];
  disclosures: {
    notModelled: GainsAtRiskDisclosure;
    /** Modelled rows whose beta is `market-converted` or `estimated`. */
    betaEstimated: GainsAtRiskDisclosure;
    pricedFromModel: GainsAtRiskDisclosure;
    expiresBeforeDate: GainsAtRiskDisclosure;
  };
}

// ─── Input checks ───────────────────────────────────────────────

/** A real calendar day in YYYY-MM-DD (2026-02-30 fails); the same test the option repricer applies. */
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function checkInput(input: GainsAtRiskInput, today: string): string {
  const driver = (input.driverSymbol ?? "").trim().toUpperCase();
  if (driver === "") throw new Error("driverSymbol is required");
  if (typeof input.valuationDate !== "string" || !isCalendarDay(input.valuationDate)) {
    throw new Error("valuationDate is not a valid date");
  }
  if (input.valuationDate < today) throw new Error("valuationDate is before today");
  if (!Array.isArray(input.moves) || input.moves.some((m) => typeof m !== "number" || !Number.isFinite(m))) {
    throw new Error("moves must be finite numbers");
  }
  // A driver cannot fall more than 100%; a deeper move would credit an
  // inverse fund or a put with a gain no price path can produce.
  if (input.moves.some((m) => m < -1)) throw new Error("moves must be at least -1");
  if (typeof input.volChangePoints !== "number" || !Number.isFinite(input.volChangePoints)) {
    throw new Error("volChangePoints must be a finite number");
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

function emptyResult(driver: string, input: GainsAtRiskInput): GainsAtRiskResult {
  const none: GainsAtRiskDisclosure = { count: 0, shareOfBook: null, unknownValueCount: 0, symbols: [] };
  return {
    driverSymbol: driver,
    valuationDate: input.valuationDate,
    volChangePoints: input.volChangePoints,
    grossBookUsd: 0,
    unknownValueCount: 0,
    moves: input.moves.map((move) => ({ move, bookPnlUsd: 0, losersPnlUsd: 0, offsetsPnlUsd: 0 })),
    positions: [],
    disclosures: { notModelled: none, betaEstimated: { ...none }, pricedFromModel: { ...none }, expiresBeforeDate: { ...none } },
  };
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
  const betaMemo = new Map<string, DriverBeta>();

  const positions = rows.map((row): GainsAtRiskPosition => {
    const isOption = isOptionSecurityType(row.security_type);
    const base = {
      accountId: row.account_id,
      accountName: row.account_name,
      securityId: row.security_id,
      symbol: row.symbol,
      name: row.security_name,
      ...(isOption && row.expiration_date
        ? { expiry: normalizeExpirationDate(row.expiration_date) ?? row.expiration_date }
        : {}),
    };
    const ownPriced = (row.own_price ?? 0) > 0;
    const notModelled = (
      reason: GainsAtRiskUnmodelled,
      valueUsd: number | null,
      extra: Partial<GainsAtRiskPosition> = {},
    ): GainsAtRiskPosition => ({
      ...base,
      side: "flat",
      beta: null,
      betaSource: "not-modelled",
      assumedMovePerUnitDriver: null,
      pnlByMove: input.moves.map(() => 0),
      // A row whose value is unknown has no price source to show.
      priceSource: ownPriced && valueUsd !== null ? "own-price" : null,
      unmodelledReason: reason,
      valueUsd,
      exposureUsd: 0,
      ...extra,
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

    // 4. Beta to the driver, with the custom engine's own fixed values and heuristic.
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
    const heuristicMarketBeta = estimateBeta(betaType, identity.sector, row.style, row.market_cap_category, zeroBeta);
    const fixedBeta = zeroBeta ? 0 : betaType.toLowerCase() === "bond" ? heuristicMarketBeta : null;
    const betaInput: DriverBetaInput = {
      securityId: row.security_id,
      identitySymbol: identity.symbol,
      storedUnderlyingSymbol: isOption ? row.stored_underlying_symbol : null,
      identitySecurityId: isOption ? row.underlying_security_id : row.security_id,
      leveraged,
      fixedBeta,
      heuristicMarketBeta,
      trackedIndexSymbol: leveraged.flagged ? trackedIndexFor(identity.symbol, seeds) : null,
    };
    const { securityId: _ignored, ...identityKey } = betaInput;
    const memoKey = JSON.stringify(identityKey);
    let resolved = betaMemo.get(memoKey);
    if (resolved === undefined) {
      resolved = resolveDriverBeta(db, betaInput, driver, { today });
      betaMemo.set(memoKey, resolved);
    }

    const optionValueIfUnmodelled = overrideAccepted
      ? (pricingRow.own_price as number) * row.total_qty * row.multiplier * row.usd_per_unit
      : ownPriced
        ? row.market_value
        : null;

    if (resolved.beta === null) {
      return notModelled(resolved.reason, isOption ? optionValueIfUnmodelled : row.market_value, refusalField);
    }
    const beta = resolved.beta;
    const betaSource = resolved.source;

    // 5. Price every move.
    const units = row.total_qty * row.multiplier * row.usd_per_unit;
    type Priced = { pnl: number; result?: OptionRepriceResult & { modelled: true } };
    const priceAt = (move: number, valuationDate: string, vol: number): Priced | { unmodelled: OptionUnmodelledReason } => {
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

    const priced = input.moves.map((m) => priceAt(m, input.valuationDate, volChange));
    const failed = priced.find((p): p is { unmodelled: OptionUnmodelledReason } => "unmodelled" in p);
    if (failed) {
      return notModelled(failed.unmodelled, optionValueIfUnmodelled, {
        ...refusalField,
        beta,
        betaSource,
        priceSource: overrideAccepted ? "override" : ownPriced ? "own-price" : null,
      });
    }
    const ok = priced as Priced[];

    // Exposure: today, no volatility change, ±1% of the driver.
    const up = priceAt(0.01, today, 0);
    const down = priceAt(-0.01, today, 0);
    const exposureUsd = "pnl" in up && "pnl" in down ? clean((up.pnl - down.pnl) / 0.02) : 0;

    // Value and price source.
    const anyResult = ok.find((p) => p.result)?.result;
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
      // Model-priced: v0 does not depend on the move. With no moves at all,
      // price once at rest to read it.
      const r =
        anyResult ??
        (() => {
          const rest = priceAt(0, today, 0);
          return "result" in rest ? rest.result : undefined;
        })();
      priceSource = "model";
      modelPricePerShare = r?.v0;
      valueUsd = (r?.v0 ?? 0) * units;
    }

    const expiresBeforeDate = ok.some((p) => p.result?.expiresBeforeDate === true);
    const side: GainsAtRiskSide = exposureUsd > 0 ? "loses" : exposureUsd < 0 ? "offsets" : "flat";

    return {
      ...base,
      side,
      beta,
      betaSource,
      assumedMovePerUnitDriver: beta,
      pnlByMove: ok.map((p) => clean(p.pnl)),
      priceSource,
      ...(modelPricePerShare !== undefined ? { modelPricePerShare } : {}),
      ...(expiresBeforeDate ? { expiresBeforeDate: true as const } : {}),
      ...refusalField,
      valueUsd: clean(valueUsd),
      exposureUsd,
    };
  });

  // ─── Totals and disclosures ───────────────────────────────────
  let grossBookUsd = 0;
  let unknownValueCount = 0;
  for (const p of positions) {
    if (p.valueUsd === null) unknownValueCount += 1;
    else grossBookUsd += Math.abs(p.valueUsd);
  }

  const moves: GainsAtRiskMoveRow[] = input.moves.map((move, i) => {
    let losers = 0;
    let offsets = 0;
    for (const p of positions) {
      if (p.side === "offsets") offsets += p.pnlByMove[i];
      else losers += p.pnlByMove[i];
    }
    return { move, bookPnlUsd: clean(losers + offsets), losersPnlUsd: clean(losers), offsetsPnlUsd: clean(offsets) };
  });

  const modelled = positions.filter((p) => p.unmodelledReason === undefined);
  return {
    driverSymbol: driver,
    valuationDate: input.valuationDate,
    volChangePoints: input.volChangePoints,
    grossBookUsd,
    unknownValueCount,
    moves,
    positions,
    disclosures: {
      notModelled: disclosure(positions.filter((p) => p.unmodelledReason !== undefined), grossBookUsd),
      betaEstimated: disclosure(
        modelled.filter((p) => p.betaSource === "market-converted" || p.betaSource === "estimated"),
        grossBookUsd,
      ),
      pricedFromModel: disclosure(modelled.filter((p) => p.priceSource === "model"), grossBookUsd),
      expiresBeforeDate: disclosure(modelled.filter((p) => p.expiresBeforeDate === true), grossBookUsd),
    },
  };
}

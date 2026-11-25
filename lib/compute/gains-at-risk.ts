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
 * refused leveraged beta with no owner's figure, an option the model cannot
 * price in either case)
 * contributes zero to every move in both cases and is listed under
 * `notModelled` with its reason; a row whose value is unknown carries
 * `valueUsd: null` and is counted, never shown as a 0% share (F12).
 *
 * The split (F15, down direction), per case (`sideOf`): a row whose dollar
 * exposure to the driver is positive LOSES in a fall; negative OFFSETS it. A
 * row with zero exposure, or one that expires before the valuation date,
 * takes its side from the sign of its own P&L (an expiring row: the sign at
 * the most negative move). "flat" means zero at every move (a not-modelled
 * row included). For every move and case, book = losers + offsets; a figure
 * under half a cent is exactly 0.
 *
 * TRIAL POSITIONS (step 2, `trialPositions`; spec
 * 2026-11-24-gains-at-risk-step2-trial-positions-design.md). Absent or empty:
 * the result is step 1's exactly, with no `trial` key (pinned in
 * tests/fixtures/gains-at-risk-no-trial-pin.json). Present: after the book,
 * in the same run (same clock, risk-free rate, betas memo, `caseBetas`,
 * `sideOf`, exposure and rounding), each trial is priced as a row with no
 * account:
 *   - an option at the RECORDED volatility (solved once at the click, R1;
 *     never solved again, never the broker's), at an underlying of
 *     entryUnderlyingPrice x (valuation price now / valuationPriceAtEntry):
 *     marked relative to the app's own price series, so a quote off the
 *     stored price shows nothing at the click; less the price paid (bought) or the premium received less the
 *     cost to close (written); worse-of-two when it expires before the date;
 *   - shares against the typed price (R3), sign -1 for a sale.
 * Its underlying price is `trialValuationPrice` (the stored price the loader
 * reads when the name is held in any account, else the latest priced daily
 * close, else the stored price): one price per name in every scope, the
 * entry's rule too. Every zero-effect trial is REFUSED, with no cost and out
 * of net cash: unknown or option id, foreign underlying, no FX rate, expired
 * (a kept trial whose contract has since expired, P11), no price, or a name
 * the ladder cannot model with no owner's figure ("not-modelled", with
 * `ladderRefusal`). Trial rows
 * never enter `positions`, `grossBookUsd`, `unknownValueCount`,
 * `betaEvidence` or a disclosure (R6). Per case and move: book with trial =
 * book + Σ trial rows, to the cent. An owner's figure keyed to a trial's
 * identity is applied, not counted as ignored.
 *
 * ONE STOCK OR FUND AS THE DRIVER (step 3, `driver: { kind: "single-name" }`;
 * spec 2026-11-25-gains-at-risk-step3-candidates-design.md, P2-P8, P20, D5).
 * No regression and no driver bars: the driver, its share classes
 * (`siblingsOf`, default `issuerSiblings`) and every option on them move by
 * exactly the driver move; a leveraged fund whose seed names the family moves
 * by its signed factor; everything else is "held-unchanged" (its options
 * still reprice for time). The volatility change reaches only options whose
 * underlying moves (the family and a seeded leveraged fund). No owner's figure is applied (every key is counted ignored). One case
 * is computed and returned under both keys; each row carries `sideDown` and
 * `sideUp`, and each move row its `split`. Moves lie in
 * `SINGLE_NAME_MOVE_BOUNDS`; the trial crossing reads the selected move's
 * direction. With no `driver` (or `{ kind: "index" }`) the result is step 2's
 * exactly (pinned in tests/fixtures/gains-at-risk-with-trial-pin.json).
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
import {
  BETA_OVERRIDE_BOUNDS,
  CANDIDATE_BOUNDS,
  SINGLE_NAME_MOVE_BOUNDS,
  TRIAL_OPTION_MULTIPLIER,
  TRIAL_POSITION_BOUNDS,
} from "@/lib/analysis/gains-at-risk-constants";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { resolveLeveragedExposure, type LeveragedExposure } from "./leveraged-fund";
import { isOptionSecurityType, normalizeExpirationDate } from "./option-elasticity";
import { isExpiredAsOf } from "./options-greeks";
import {
  readTrialSecurity,
  trialBetaRow,
  trialCrossing,
  trialCurrency,
  trialHoldingsByAccount,
  trialShortfalls,
  trialValuationPrice,
} from "./gains-at-risk-trial";
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
// The capture's own target list: the one rule for which names get daily bars.
// Its module imports the TWS client lazily (no connection at load) and does not import this engine.
import { listDailyBarTargets } from "@/lib/tws/daily-bar-capture";

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
  /**
   * Step 2: positions that do not exist yet, priced in the same run as the
   * book (R1-R10, P1-P11). Absent or empty: the result is step 1's, with no
   * `trial` key. Page state only; never stored.
   */
  trialPositions?: TrialPositionInput[];
  /**
   * Step 3: what the sweep moves. Absent means index, today's behaviour (P8).
   * In single-name mode `driverSymbol` is ignored for pricing and the
   * result's `driverSymbol` is `driver.symbol`, trimmed and upper-cased.
   */
  driver?: GainsAtRiskDriverInput;
  /**
   * Step 3: the move the page has selected. In single-name mode it must be
   * one of `moves`, and it sets the trial crossing's direction (D5): a
   * positive move reads rises, a negative or zero move (or none) reads falls.
   */
  selectedMove?: number;
  /**
   * Step 3 (engine change 6): bought options tried one at a time against the
   * book plus the trial positions, in the same run. Requires `selectedMove`
   * (one of `moves`); at most `CANDIDATE_BOUNDS.maxCandidates`; unique ids.
   * Never part of the book's or the trial list's figures. Absent or empty: no
   * `candidates` key in the result.
   */
  candidates?: GainsAtRiskCandidateInput[];
  /** Injected for tests; default the Eastern day and the wall clock, each read once. */
  today?: string;
  now?: Date;
}

/**
 * A trial position (step 2). An option is FIXED AT THE CLICK (R1): the price
 * paid, the underlying's price used and the volatility solved from the two
 * (`solveTrialEntry`) travel with it, and no run solves the volatility again.
 * Shares are marked against the typed price (R3).
 */
export type TrialPositionInput =
  | {
      kind: "option";
      /** Client-supplied, unique within the request (≤ 40 chars). */
      id: string;
      /** securities.id of the underlying (a non-option row). */
      underlyingSecurityId: number;
      right: "put" | "call";
      side: "buy" | "write";
      /** YYYY-MM-DD. */
      expiry: string;
      strike: number;
      /** Whole contracts, 1..maxContracts. Multiplier is TRIAL_OPTION_MULTIPLIER. */
      contracts: number;
      /** Per share, at the click (R1). */
      pricePaid: number;
      /** The underlying's price used at the click (R1, R2): the quote's when one was fetched. The volatility is solved at it. */
      entryUnderlyingPrice: number;
      /**
       * The app's own valuation price of the underlying at the click (`trialValuationPrice`);
       * equal to `entryUnderlyingPrice` when no quote was used. The option is marked RELATIVE
       * to the app's price series: underlying = entryUnderlyingPrice x (valuation now / this).
       */
      valuationPriceAtEntry: number;
      /** Solved at the click by solveTrialEntry; never re-solved (R1). */
      entryVolatility: number;
      /**
       * Step 3 (F3): the broker's contract id, when the trial came from a
       * quoted candidate. The holdings match then counts only a held row with
       * that same id (an adjusted contract shares terms with a standard one);
       * a held row with no id on file is still matched by its terms. Absent:
       * exactly step 2's terms match.
       */
      brokerContractId?: number;
    }
  | {
      kind: "shares";
      id: string;
      /** securities.id of a non-option row. */
      securityId: number;
      side: "buy" | "sell";
      /** Whole shares, 1..maxShares. */
      quantity: number;
      /** The typed price per share (R3). */
      price: number;
    };

/**
 * A trial position without its id (what an entry builds before the page
 * names it). Distributive over the union: a plain `Omit<TrialPositionInput,
 * "id">` keeps only the keys both kinds share and loses every option and
 * share field.
 */
export type TrialPositionDraft = TrialPositionInput extends infer T ? (T extends unknown ? Omit<T, "id"> : never) : never;

/**
 * Step 3: the driver kind. An index (SPY, QQQ or VTI, named by
 * `driverSymbol`), or one name: the name, its share classes and every option
 * on them move by exactly the driver move; everything else is held unchanged
 * (P2). `securityId` is null for an option underlying with no securities row.
 */
export type GainsAtRiskDriverInput =
  | { kind: "index" }
  | { kind: "single-name"; symbol: string; securityId: number | null };

export interface GainsAtRiskOptions {
  /** Tracked-index map for leveraged funds; defaults to the shipped `LEVERAGED_TRACKED_INDEX_SEEDS`. */
  trackedIndexSeeds?: Readonly<Record<string, string>>;
  /** Share-class family; default issuerSiblings. Tests inject a ZZ family (the shipped map holds real tickers). */
  siblingsOf?: (symbol: string) => readonly string[];
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
export type GainsAtRiskBetaSource =
  | DriverBetaSource
  | "owner"
  | "no-measured-link"
  | "not-modelled"
  /** Single-name mode: not the driver and not a sibling (never "no measured link", which means a measurement failed). */
  | "held-unchanged"
  /** Single-name mode: a flagged leveraged or inverse fund whose tracked-index seed names neither the driver nor a sibling. */
  | "leveraged-not-linked";
export type GainsAtRiskBetaOverrideRefusal = "fixed-row" | "is-driver" | "out-of-bounds";

export interface GainsAtRiskPositionCase {
  /** The underlying's move per unit driver move in this case; 0 = held unchanged; null = not modelled. */
  beta: number | null;
  /** Dollars, one per input move, in the input's order. Zero on a not-modelled row. */
  pnlByMove: number[];
  side: GainsAtRiskSide;
  /** Single-name mode only: the side in a fall (equal to `side`). */
  sideDown?: GainsAtRiskSide;
  /** Single-name mode only: the side in a rise (the exposure's sign reversed; an expiring row reads the most positive move). */
  sideUp?: GainsAtRiskSide;
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
  /**
   * Single-name mode only: which split totals this row (P6). "down" uses each
   * row's `sideDown`, "up" its `sideUp`; on "none" (move 0) losers and offsets
   * are 0 and only `bookPnlUsd` is meaningful.
   */
  split?: "down" | "up" | "none";
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
    /** Single-name mode only: flagged funds held unchanged because no seed links them to the driver (P3). */
    leveragedNotLinked?: GainsAtRiskDisclosure;
  };
}

export interface GainsAtRiskBetaEvidence {
  /** Latest priced daily bar of the driver before today, in the regression window; null when none. */
  driverBarsThrough: string | null;
  /** No driver series row, or no priced driver bar in the regression window. */
  driverBarsMissing: boolean;
  /**
   * Distinct identities whose reason is `no-daily-bars` (C13) AND that the
   * daily-bar capture will fetch: they are waiting for their first bars.
   */
  namesWaitingForBars: number;
  /**
   * Distinct `no-daily-bars` identities the capture never fetches (not in
   * `listDailyBarTargets`: a mutual fund, no contract id, a non-USD row, a
   * bond fund, or an option underlying with no securities row). They will not
   * get bars by waiting.
   */
  namesNotCaptured: number;
  /** Single-name mode only: no regression is run (all counts 0, `driverBarsThrough` null). */
  notApplicable?: true;
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
  /** Owner's-figure keys that match no position's identity (a trial position's identity counts as a match). */
  betaOverridesIgnored: number;
  /** Step 2: present only when `trialPositions` has at least one entry. */
  trial?: GainsAtRiskTrialResult;
  /** Step 3: present only in single-name mode. `measured` and `selloff` then hold equal figures (P20). */
  driverKind?: "single-name";
  /** Step 3: present only when `candidates` has at least one entry; in the input's order. */
  candidates?: GainsAtRiskCandidateResult[];
}

// ─── Candidates (step 3): input and result types ────────────────

/** A sized candidate: a bought option with its entry fixed at call 1 (never re-solved). */
export interface GainsAtRiskCandidateInput {
  id: string;
  /** side "buy", contracts >= 1; the same field rules as a trial option. */
  position: Extract<TrialPositionInput, { kind: "option" }>;
}

export interface GainsAtRiskCandidateCase {
  beta: number | null;
  /** The candidate alone, net of its price paid, per input move. */
  pnlByMove: number[];
  atSelectedMoveUsd: number;
  /** Evaluated on the run context whether or not 0 is in moves (D10). */
  atZeroMoveUsd: number;
  crossing: GainsAtRiskTrialCrossing;
  /** D5: the driver's direction (index mode: fall; single-name: the selected move's sign), never the row's right. */
  crossingDirection: "fall" | "rise";
  /** P13a: this run holds the candidate's underlying unchanged in this case. */
  heldUnchanged: boolean;
}

export interface GainsAtRiskCandidateResult {
  id: string;
  identitySecurityId: number;
  symbol: string;
  betaSource: GainsAtRiskBetaSource;
  refusal?: TrialRefusal;
  valueUsd: number | null;
  /** Premium paid; null when refused. */
  cost: TrialCost | null;
  /** Null when refused. */
  cases: Record<GainsAtRiskCaseKey, GainsAtRiskCandidateCase> | null;
}

// ─── Trial positions (step 2): result types ─────────────────────

export type TrialRefusal =
  | "unknown-security"
  | "is-an-option"
  | "foreign-currency"
  | "no-fx-rate"
  | "no-underlying-price"
  | "expired"
  | "no-option-terms"
  /** The beta ladder cannot model the name (`ladderRefusal` says why) and no owner's figure is set. */
  | "not-modelled";

export type TrialCost =
  /** Bought option: price paid x contracts x 100. */
  | { kind: "premium-paid"; usd: number }
  /** Written option: an obligation, not a gain (R7). */
  | { kind: "premium-received"; usd: number }
  /** Bought shares. */
  | { kind: "cash-used"; usd: number }
  /** Sold shares. */
  | { kind: "cash-raised"; usd: number };

export interface GainsAtRiskTrialRow {
  id: string;
  kind: "option" | "shares";
  /** The traded security for shares, the underlying for an option. */
  identitySecurityId: number;
  /** The traded security's symbol for shares, the underlying's for an option ("" when the id is not on file). */
  symbol: string;
  name: string | null;
  betaSource: GainsAtRiskBetaSource;
  measuredBeta: number | null;
  evidence?: DailyBarEvidence;
  noMeasuredLinkReason?: NoMeasuredLinkReason;
  /** Set when the ladder refused the name: why (with `refusal: "not-modelled"`, or beside an owner's figure that then priced it). */
  ladderRefusal?: DriverBetaRefusal;
  /** A trial option whose underlying has no measured link and no owner's figure: its protection is not counted in the measured case. */
  noLinkWarning: boolean;
  /**
   * The valuation price of the shares or of the underlying (`trialValuationPrice`): the
   * stored price the loader reads when the name is held in any account ("book"), else the
   * latest priced daily bar, else the latest stored price ("stored-price"). Native currency.
   */
  valuation: { price: number; date: string; source: "book" | "daily-bar" | "stored-price" } | null;
  expiresBeforeDate?: true;
  refusal?: TrialRefusal;
  /** Signed USD mark now (shares at the valuation price; option at its model value at the recorded volatility); null when refused. */
  valueUsd: number | null;
  /** Null when refused: a refused row has no dollar cost to print. */
  cost: TrialCost | null;
  /** R4/P3: account id → holdings of that exact security (shares) or contract (option) now, every account; accounts at 0 omitted. */
  holdingsNowByAccount: Record<number, number>;
  /** P4: sold shares only: the part of the name's projected shortfall attributed to this sale in list order; null otherwise. */
  leavesShortBy: number | null;
  cases: Record<GainsAtRiskCaseKey, GainsAtRiskPositionCase>;
}

export interface GainsAtRiskTrialMoveRow {
  move: number;
  trialPnlUsd: number;
  bookWithTrialPnlUsd: number;
}

/** P5: over the moves at or below 0, by deepening fall; "better" = trial total > 0 (exactly 0 is not better). */
export type GainsAtRiskTrialCrossing =
  | { kind: "better-at-every-move" }
  | { kind: "worse-at-every-move"; deepestMove: number }
  | { kind: "no-trial-effect" }
  | { kind: "pays-beyond"; move: number }
  | { kind: "helps-until"; move: number }
  | { kind: "changes-more-than-once"; firstHelpFrom: number; firstHelpTo: number };

export interface GainsAtRiskTrialCase {
  moves: GainsAtRiskTrialMoveRow[];
  /** −(Σ trial P&L at move 0) at the date; null when 0 is not in the sweep. Positive = a cost. */
  noMoveCostUsd: number | null;
  crossing: GainsAtRiskTrialCrossing;
  /** Single-name mode only: the direction the crossing reads (D5), from the selected move's sign. */
  crossingDirection?: "fall" | "rise";
}

export interface GainsAtRiskTrialResult {
  rows: GainsAtRiskTrialRow[];
  /** Σ: −premium paid + premium received − cash used + cash raised, over rows not refused. */
  netCashUsd: number;
  count: number;
  refusedCount: number;
  noLinkWarningCount: number;
  /**
   * P4: one entry per name the trial sales leave short. `shortBy` is the part the trial
   * positions cause (the sum of the per-sale `leavesShortBy`); `heldShortBefore` is the short
   * every account held before any trial (0 when none).
   */
  shortByName: { securityId: number; symbol: string; shortBy: number; heldShortBefore: number }[];
  cases: Record<GainsAtRiskCaseKey, GainsAtRiskTrialCase>;
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

/** The checked driver: its upper-cased symbol, and the single-name fields when that is the kind. */
type CheckedDriver = { symbol: string; singleName: null | { securityId: number | null } };

function checkDriver(input: GainsAtRiskInput): CheckedDriver {
  const raw: unknown = input.driver;
  if (raw === undefined) return checkIndexDriver(input);
  if (raw === null || typeof raw !== "object") throw new GainsAtRiskInputError("driver must be an object");
  const d = raw as Record<string, unknown>;
  if (d.kind === "index") return checkIndexDriver(input);
  if (d.kind !== "single-name") throw new GainsAtRiskInputError("driver kind must be index or single-name");
  const symbol = typeof d.symbol === "string" ? d.symbol.trim().toUpperCase() : "";
  if (symbol === "") throw new GainsAtRiskInputError("a single-name driver needs a symbol");
  const id = d.securityId;
  if (id !== null && !(typeof id === "number" && Number.isSafeInteger(id) && id > 0)) {
    throw new GainsAtRiskInputError("a single-name driver's securityId must be a positive whole number or null");
  }
  return { symbol, singleName: { securityId: id as number | null } };
}

function checkIndexDriver(input: GainsAtRiskInput): CheckedDriver {
  const driver = (input.driverSymbol ?? "").trim().toUpperCase();
  if (driver === "") throw new GainsAtRiskInputError("driverSymbol is required");
  return { symbol: driver, singleName: null };
}

function checkInput(input: GainsAtRiskInput, today: string): CheckedDriver {
  const driver = checkDriver(input);
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
  // Step 3 (P5): one name can fall or rise, within its own bounds. Index mode keeps today's checks only.
  if (driver.singleName !== null) {
    const B = SINGLE_NAME_MOVE_BOUNDS;
    if (input.moves.some((m) => m < B.min || m > B.max)) {
      throw new GainsAtRiskInputError(`a single-name move must be between ${B.min} and ${B.max}`);
    }
    if (input.selectedMove !== undefined && !input.moves.includes(input.selectedMove)) {
      throw new GainsAtRiskInputError("selectedMove must be one of the moves");
    }
  }
  return driver;
}

/**
 * The trial positions, checked (the route refuses these first). Throws for
 * more than `maxPositions`, a missing, duplicate or over-long id, a security
 * id that is not a positive safe integer, a choice outside its list, an
 * impossible expiry, or a number outside `TRIAL_POSITION_BOUNDS`. A past
 * expiry is NOT an input error (P11): that trial is priced as expired.
 */
function checkTrialPositions(input: GainsAtRiskInput): TrialPositionInput[] {
  const raw: unknown = input.trialPositions;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new GainsAtRiskInputError("trialPositions must be a list");
  const B = TRIAL_POSITION_BOUNDS;
  if (raw.length > B.maxPositions) throw new GainsAtRiskInputError(`at most ${B.maxPositions} trial positions`);
  const isId = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
  const isCount = (x: unknown, max: number) => typeof x === "number" && Number.isSafeInteger(x) && x >= 1 && x <= max;
  const isPositive = (x: unknown, max: number) => typeof x === "number" && Number.isFinite(x) && x > 0 && x <= max;
  const ids = new Set<string>();
  for (const p of raw as unknown[]) {
    if (p === null || typeof p !== "object") throw new GainsAtRiskInputError("a trial position must be an object");
    const t = p as Record<string, unknown>;
    if (typeof t.id !== "string" || t.id.length === 0 || t.id.length > B.idMaxLength) {
      throw new GainsAtRiskInputError(`a trial position id must be 1 to ${B.idMaxLength} characters`);
    }
    if (ids.has(t.id)) throw new GainsAtRiskInputError("trial position ids must be unique");
    ids.add(t.id);
    if (t.kind === "option") {
      checkOptionFields(t);
    } else if (t.kind === "shares") {
      if (!isId(t.securityId)) throw new GainsAtRiskInputError("securityId must be a positive whole number");
      if (t.side !== "buy" && t.side !== "sell") throw new GainsAtRiskInputError("a share trade's side must be buy or sell");
      if (!isCount(t.quantity, B.maxShares)) throw new GainsAtRiskInputError("quantity is out of bounds");
      if (!isPositive(t.price, B.maxPrice)) throw new GainsAtRiskInputError("price is out of bounds");
    } else {
      throw new GainsAtRiskInputError("a trial position's kind must be option or shares");
    }
  }
  return raw as TrialPositionInput[];
}

const isPositiveId = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x > 0;

/** The field rules of an option trial (and of a candidate's position): throws on the first bad field. */
function checkOptionFields(t: Record<string, unknown>): void {
  const B = TRIAL_POSITION_BOUNDS;
  const isCount = (x: unknown, max: number) => typeof x === "number" && Number.isSafeInteger(x) && x >= 1 && x <= max;
  const isPositive = (x: unknown, max: number) => typeof x === "number" && Number.isFinite(x) && x > 0 && x <= max;
  if (!isPositiveId(t.underlyingSecurityId)) throw new GainsAtRiskInputError("underlyingSecurityId must be a positive whole number");
  if (t.right !== "put" && t.right !== "call") throw new GainsAtRiskInputError("right must be put or call");
  if (t.side !== "buy" && t.side !== "write") throw new GainsAtRiskInputError("an option's side must be buy or write");
  if (typeof t.expiry !== "string" || !isCalendarDay(t.expiry)) throw new GainsAtRiskInputError("expiry is not a valid date");
  if (!isPositive(t.strike, B.maxStrike)) throw new GainsAtRiskInputError("strike is out of bounds");
  if (!isCount(t.contracts, B.maxContracts)) throw new GainsAtRiskInputError("contracts is out of bounds");
  if (!isPositive(t.pricePaid, B.maxPrice)) throw new GainsAtRiskInputError("pricePaid is out of bounds");
  if (!isPositive(t.entryUnderlyingPrice, B.maxPrice)) throw new GainsAtRiskInputError("entryUnderlyingPrice is out of bounds");
  if (!isPositive(t.valuationPriceAtEntry, B.maxPrice)) throw new GainsAtRiskInputError("valuationPriceAtEntry is out of bounds");
  if (!isPositive(t.entryVolatility, B.maxVolatility)) {
    throw new GainsAtRiskInputError(`entryVolatility must be above 0 and at most ${B.maxVolatility}`);
  }
  // F3: optional; when present, a positive safe integer.
  if (t.brokerContractId !== undefined && !isPositiveId(t.brokerContractId)) {
    throw new GainsAtRiskInputError("brokerContractId must be a positive whole number");
  }
}

/**
 * Step 3: the candidates, checked. Throws for a non-list, more than
 * `maxCandidates`, a missing, duplicate or over-long id, a position that is
 * not a bought option, or any option field outside its bounds; and, when
 * there is at least one, for a `selectedMove` that is not one of `moves`.
 */
function checkCandidates(input: GainsAtRiskInput): GainsAtRiskCandidateInput[] {
  const raw: unknown = input.candidates;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new GainsAtRiskInputError("candidates must be a list");
  if (raw.length === 0) return [];
  if (raw.length > CANDIDATE_BOUNDS.maxCandidates) {
    throw new GainsAtRiskInputError(`at most ${CANDIDATE_BOUNDS.maxCandidates} candidates`);
  }
  if (typeof input.selectedMove !== "number" || !input.moves.includes(input.selectedMove)) {
    throw new GainsAtRiskInputError("candidates need a selectedMove that is one of the moves");
  }
  const ids = new Set<string>();
  for (const c of raw as unknown[]) {
    if (c === null || typeof c !== "object") throw new GainsAtRiskInputError("a candidate must be an object");
    const cand = c as Record<string, unknown>;
    if (typeof cand.id !== "string" || cand.id.length === 0 || cand.id.length > TRIAL_POSITION_BOUNDS.idMaxLength) {
      throw new GainsAtRiskInputError(`a candidate id must be 1 to ${TRIAL_POSITION_BOUNDS.idMaxLength} characters`);
    }
    if (ids.has(cand.id)) throw new GainsAtRiskInputError("candidate ids must be unique");
    ids.add(cand.id);
    const p = cand.position;
    if (p === null || typeof p !== "object") throw new GainsAtRiskInputError("a candidate needs a position");
    const pos = p as Record<string, unknown>;
    if (pos.kind !== "option") throw new GainsAtRiskInputError("a candidate's position must be an option");
    if (pos.side !== "buy") throw new GainsAtRiskInputError("a candidate's position must be a bought option");
    checkOptionFields(pos);
  }
  return raw as GainsAtRiskCandidateInput[];
}

// ─── Helpers ────────────────────────────────────────────────────

/** -0 prints as 0; anything else passes through (a NaN is never hidden here). */
function clean(x: number): number {
  return x === 0 ? 0 : x;
}

/** A dollar P&L figure: under half a cent in size is exactly 0 (never a -1e-13 printing as -0); a NaN is never hidden. */
function cents0(x: number): number {
  return Math.abs(x) < 0.005 ? 0 : x;
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
  singleName = false,
): GainsAtRiskCase {
  const rows: GainsAtRiskMoveRow[] = moves.map((move, i) => {
    if (singleName) {
      // P6: a fall totals each row by its down side, a rise by its up side; no move has no split.
      const split: "down" | "up" | "none" = move < 0 ? "down" : move > 0 ? "up" : "none";
      if (split === "none") {
        let book = 0;
        for (const p of positions) book += p.cases[key].pnlByMove[i];
        return { move, bookPnlUsd: cents0(book), losersPnlUsd: 0, offsetsPnlUsd: 0, split };
      }
      let losers = 0;
      let offsets = 0;
      for (const p of positions) {
        const c = p.cases[key];
        const side = (split === "down" ? c.sideDown : c.sideUp) ?? c.side;
        if (side === "offsets") offsets += c.pnlByMove[i];
        else if (side === "loses") losers += c.pnlByMove[i];
      }
      return { move, bookPnlUsd: cents0(losers + offsets), losersPnlUsd: cents0(losers), offsetsPnlUsd: cents0(offsets), split };
    }
    let losers = 0;
    let offsets = 0;
    for (const p of positions) {
      const c = p.cases[key];
      if (c.side === "offsets") offsets += c.pnlByMove[i];
      else if (c.side === "loses") losers += c.pnlByMove[i];
      // "flat" rows carry exactly zero at every move, so book = losers + offsets.
    }
    return { move, bookPnlUsd: cents0(losers + offsets), losersPnlUsd: cents0(losers), offsetsPnlUsd: cents0(offsets) };
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
      ...(singleName
        ? { leveragedNotLinked: disclosure(modelled.filter((p) => p.betaSource === "leveraged-not-linked"), grossBookUsd) }
        : {}),
    },
  };
}

/** Single-name mode (step 3): no regression is run, so the evidence is not applicable. */
function notApplicableEvidence(): GainsAtRiskBetaEvidence {
  return { driverBarsThrough: null, driverBarsMissing: false, namesWaitingForBars: 0, namesNotCaptured: 0, notApplicable: true };
}

function emptyResult(driver: string, input: GainsAtRiskInput, singleName = false): GainsAtRiskResult {
  const cases = {} as Record<GainsAtRiskCaseKey, GainsAtRiskCase>;
  for (const k of GAINS_AT_RISK_CASE_KEYS) cases[k] = caseFor(k, [], input.moves, 0, singleName);
  if (singleName) {
    return {
      driverSymbol: driver,
      valuationDate: input.valuationDate,
      volChangePoints: input.volChangePoints,
      grossBookUsd: 0,
      unknownValueCount: 0,
      positions: [],
      cases,
      betaEvidence: notApplicableEvidence(),
      betaOverridesIgnored: Object.keys(input.betaOverrides ?? {}).length,
      driverKind: "single-name",
    };
  }
  return {
    driverSymbol: driver,
    valuationDate: input.valuationDate,
    volChangePoints: input.volChangePoints,
    grossBookUsd: 0,
    unknownValueCount: 0,
    positions: [],
    cases,
    // Nothing is read for an empty scope, so nothing is reported missing.
    betaEvidence: { driverBarsThrough: null, driverBarsMissing: false, namesWaitingForBars: 0, namesNotCaptured: 0 },
    betaOverridesIgnored: Object.keys(input.betaOverrides ?? {}).length,
  };
}

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
 * A row's side in one case.
 *
 * - A row that EXPIRES BEFORE THE VALUATION DATE (`expiringWorstIndex` set)
 *   takes its side from the sign of its own worst-case P&L, not from its
 *   exposure today: a long put that lapses is a loser, not an offset whose loss
 *   sits in the offsetting column. The side is fixed across the case's moves;
 *   when the sign differs across moves, the sign at the MOST NEGATIVE move of
 *   the sweep decides (a fall is what the page shows). At exactly zero there,
 *   the zero-exposure rule below decides.
 * - Otherwise exposure decides when it is not zero.
 * - A row with zero exposure (its underlying held unchanged) can still carry
 *   P&L on its options (time decay, a volatility change), the same at every
 *   move: a loss "loses", a gain "offsets", exactly zero is "flat" (in neither
 *   column). Mixed signs cannot arise with the underlying held unchanged;
 *   should they, the row "loses" (never credited as an offset).
 *
 * "flat" is returned only when every figure is exactly 0, so book = losers + offsets.
 */
function sideOf(exposureUsd: number, pnlByMove: number[], expiringWorstIndex: number | null): GainsAtRiskSide {
  if (expiringWorstIndex !== null && expiringWorstIndex >= 0) {
    const worst = pnlByMove[expiringWorstIndex];
    if (worst < 0) return "loses";
    if (worst > 0) return "offsets";
  } else {
    if (exposureUsd > 0) return "loses";
    if (exposureUsd < 0) return "offsets";
  }
  const anyLoss = pnlByMove.some((x) => x < 0);
  const anyGain = pnlByMove.some((x) => x > 0);
  if (anyGain && !anyLoss) return "offsets";
  if (anyLoss) return "loses";
  return "flat";
}

type CaseBetas = Record<GainsAtRiskCaseKey, number | null>;

/** What the ladder resolved for an identity: the index ladder's answer, or a single-name rung (step 3). */
type LadderBeta = DriverBeta | { beta: 0; source: "held-unchanged" | "leveraged-not-linked" };

function normSymbol(symbol: string | null | undefined): string {
  return (symbol ?? "").trim().toUpperCase();
}

/**
 * Step 3, the single-name ladder (engine change 2; P2, P3). First match wins:
 *   1. the identity's symbol or an option's stored underlying symbol is in the
 *      driver's share-class family (which includes the driver), or the
 *      identity's id is the driver's: 1, "driver";
 *   2. a flagged leveraged or inverse fund whose tracked-index seed names the
 *      driver or a sibling: its signed factor, "leveraged" (tracked beta 1);
 *      such a fund with no usable factor is refused "leveraged-no-factor", as
 *      the index ladder refuses it; any other flagged fund: 0, "leveraged-not-linked";
 *   3. everything else (cash-equivalent, bond, every other name): 0, "held-unchanged".
 * No regression, no bars, no database read.
 */
function singleNameBeta(
  input: Omit<DriverBetaInput, "securityId" | "fixedBeta">,
  family: ReadonlySet<string>,
  driverSecurityId: number | null,
): LadderBeta {
  const inFamily = (symbol: string | null) => symbol !== null && family.has(normSymbol(symbol));
  if (
    inFamily(input.identitySymbol) ||
    inFamily(input.storedUnderlyingSymbol) ||
    (driverSecurityId !== null && input.identitySecurityId === driverSecurityId)
  ) {
    return { beta: 1, source: "driver" };
  }
  if (input.leveraged.flagged) {
    if (!inFamily(input.trackedIndexSymbol)) return { beta: 0, source: "leveraged-not-linked" };
    const factor = input.leveraged.factor;
    if (factor === null || !Number.isFinite(factor) || factor === 0) {
      return { beta: null, source: "not-modelled", reason: "leveraged-no-factor" };
    }
    return { beta: factor, source: "leveraged", trackedBeta: 1, factor, evidence: null };
  }
  return { beta: 0, source: "held-unchanged" };
}

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
  const { symbol: driver, singleName } = checkInput(input, today);
  const isSingleName = singleName !== null;
  const trials = checkTrialPositions(input);
  const candidates = checkCandidates(input);
  const emptyScope = input.accountIds !== undefined && input.accountIds.length === 0;
  if (emptyScope && trials.length === 0 && candidates.length === 0) return emptyResult(driver, input, isSingleName);

  const seeds = opts?.trackedIndexSeeds ?? LEVERAGED_TRACKED_INDEX_SEEDS;
  // Step 3: the driver's share-class family (it includes the driver), single-name mode only.
  const driverFamily: ReadonlySet<string> | null = isSingleName
    ? new Set([driver, ...(opts?.siblingsOf ?? issuerSiblings)(driver).map(normSymbol)].filter((x) => x !== ""))
    : null;
  // An empty scope reads no book; its trial positions are still priced (R5).
  const rows = emptyScope ? [] : loadScenarioPositionsByAccount(db, input.accountIds, { today });
  const riskFreeRate = getRiskFreeRate(db);
  const volChange = input.volChangePoints / 100;
  const overrides = input.priceOverrides ?? {};
  const betaOverrides = input.betaOverrides ?? {};

  // The driver's own series row and its bars: read once per run (C3). Single-name mode reads neither.
  const driverSecurityId = isSingleName ? null : barSeriesSecurityId(db, driver);
  const driverBars =
    driverSecurityId === null || emptyScope
      ? []
      : getOhlcvBars(db, driverSecurityId, "1 day", {
          startDate: addDays(today, -DAILY_BAR_WINDOW_DAYS),
          endDate: addDays(today, -1),
        });
  const regressionMemo = new Map<number, DailyBarEvidence>();
  /** Index of the most negative move in the sweep (first one on a tie); -1 with no moves. */
  const worstMoveIndex = input.moves.reduce((best, m, i, all) => (best < 0 || m < all[best] ? i : best), -1);
  /** Single-name mode: index of the most positive move (first one on a tie); -1 with no moves. */
  const bestMoveIndex = input.moves.reduce((best, m, i, all) => (best < 0 || m > all[best] ? i : best), -1);
  /** A row's sides for one case: `side` always; single-name mode adds the down and up sides (engine change 4). */
  const sidesOf = (
    exposureUsd: number,
    pnlByMove: number[],
    expires: boolean,
  ): Pick<GainsAtRiskPositionCase, "side" | "sideDown" | "sideUp"> => {
    const side = sideOf(exposureUsd, pnlByMove, expires ? worstMoveIndex : null);
    if (!isSingleName) return { side };
    return { side, sideDown: side, sideUp: sideOf(-exposureUsd, pnlByMove, expires ? bestMoveIndex : null) };
  };
  /** A flat case's sides: "flat" in every direction this mode reads. */
  const flatSides = (): Pick<GainsAtRiskPositionCase, "side" | "sideDown" | "sideUp"> =>
    isSingleName ? { side: "flat", sideDown: "flat", sideUp: "flat" } : { side: "flat" };
  const betaMemo = new Map<string, DriverBeta>();
  /** Distinct identities whose reason is no-daily-bars (by id, else by identity symbol) -> securities id. */
  const noBarsIdentities = new Map<string, number | null>();

  /**
   * Beta to the driver for a row: the ladder (memoised per identity within
   * the run), then the owner's figure keyed by the identity (C6), refused on
   * a fixed row or the driver. Shared by the book's rows and the trial rows.
   */
  const ladderFor = (row: ScenarioPositionAccountRow) => {
    const isOption = isOptionSecurityType(row.security_type);
    const identitySecurityId = isOption ? row.underlying_security_id : row.security_id;
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
    if (driverFamily !== null) {
      // Step 3: the single-name ladder. No owner's figure is applied (all are counted ignored, P2),
      // and the volatility change reaches only the driver's family (P4).
      const resolved: LadderBeta = singleNameBeta(
        {
          identitySymbol: identity.symbol,
          storedUnderlyingSymbol: isOption ? row.stored_underlying_symbol : null,
          identitySecurityId,
          leveraged,
          trackedIndexSymbol: leveraged.flagged ? trackedIndexFor(identity.symbol, seeds) : null,
        },
        driverFamily,
        singleName?.securityId ?? null,
      );
      const betas: CaseBetas = { measured: resolved.beta, selloff: resolved.beta };
      const betaSource: GainsAtRiskBetaSource = resolved.source;
      return {
        identity,
        resolved,
        ownerBeta: undefined as number | undefined,
        betaOverrideRefusal: undefined as GainsAtRiskBetaOverrideRefusal | undefined,
        betas,
        betaSource,
        // The volatility change reaches every option whose underlying moves with the driver:
        // the family itself and a leveraged fund a seed links to it (controller ruling, fix round 1).
        volApplies: resolved.source === "driver" || resolved.source === "leveraged",
      };
    }
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
    return { identity, resolved: resolved as LadderBeta, ownerBeta, betaOverrideRefusal, betas, betaSource, volApplies: true };
  };

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
      ...flatSides(),
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
    const { identity, resolved, ownerBeta, betaOverrideRefusal, betas, betaSource, volApplies } = ladderFor(row);
    const rowVol = volApplies ? volChange : 0;
    if (resolved.source === "no-measured-link" && resolved.reason === "no-daily-bars") {
      noBarsIdentities.set(
        identitySecurityId !== null ? `id:${identitySecurityId}` : `sym:${identity.symbol.trim().toUpperCase()}`,
        identitySecurityId,
      );
    }

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
      const priced = input.moves.map((m) => priceAt(beta, m, input.valuationDate, rowVol));
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
      const pnlByMove = pricedByCase[k].map((p) => cents0(p.pnl));
      const expires = pricedByCase[k].some((p) => p.result?.expiresBeforeDate === true);
      return { beta, pnlByMove, ...sidesOf(exposureUsd, pnlByMove, expires), exposureUsd };
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
  for (const k of GAINS_AT_RISK_CASE_KEYS) cases[k] = caseFor(k, positions, input.moves, grossBookUsd, isSingleName);

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
  const countIgnored = (applied: Set<number>): number => {
    let n = 0;
    for (const key of Object.keys(betaOverrides)) {
      const id = Number(key);
      if (!Number.isInteger(id) || !applied.has(id)) n += 1;
    }
    return n;
  };

  // Waiting vs never captured: membership in the capture's own target list
  // (`listDailyBarTargets`, the one rule), read only when some name has no bars.
  let namesWaitingForBars = 0;
  let namesNotCaptured = 0;
  if (noBarsIdentities.size > 0) {
    const captured = new Set(listDailyBarTargets(db, today, { trackedIndexSeeds: seeds }).targets);
    for (const id of noBarsIdentities.values()) {
      if (id !== null && captured.has(id)) namesWaitingForBars += 1;
      else namesNotCaptured += 1;
    }
  }

  // Single-name mode applies no owner's figure: every key is counted ignored (P2).
  const ignoredAll = Object.keys(betaOverrides).length;
  const book: GainsAtRiskResult = emptyScope
    ? emptyResult(driver, input, isSingleName)
    : isSingleName
      ? {
          driverSymbol: driver,
          valuationDate: input.valuationDate,
          volChangePoints: input.volChangePoints,
          grossBookUsd,
          unknownValueCount,
          positions,
          cases,
          betaEvidence: notApplicableEvidence(),
          betaOverridesIgnored: ignoredAll,
          driverKind: "single-name",
        }
      : {
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
            namesWaitingForBars,
            namesNotCaptured,
          },
          betaOverridesIgnored: countIgnored(appliedIdentities),
        };
  if (trials.length === 0 && candidates.length === 0) return book;

  // ─── The per-row body over the run context (engine change 6) ───
  // One function prices a trial position or a candidate, after the book, on
  // the run's own context: the loaded rows' clock, risk-free rate, betas memo,
  // `ladderFor`, volatility rule and sides (caseBetas, sideOf, the same
  // exposure and rounding). The book is loaded once, whatever the number of
  // rows. `applied` reports whether the row's identity reached the beta (the
  // ignored-key count reads it for trials only); `atZero` is the row's figure
  // at a 0% move on the valuation date, priced only when asked (D10).
  type PricedRow = { row: GainsAtRiskTrialRow; applied: boolean; atZero: Record<GainsAtRiskCaseKey, number> | null };
  const priceTrialRow = (t: TrialPositionInput, opt: { holdings: boolean; zeroMove: boolean }): PricedRow => {
    let applied = false;
    const done = (row: GainsAtRiskTrialRow, atZero: PricedRow["atZero"] = null): PricedRow => ({ row, applied, atZero });
    const identitySecurityId = t.kind === "shares" ? t.securityId : t.underlyingSecurityId;
    const buying = t.side === "buy";
    const sign = buying ? 1 : -1;
    const holdingsNowByAccount = opt.holdings ? trialHoldingsByAccount(db, t) : {};
    const flatCases = (): Record<GainsAtRiskCaseKey, GainsAtRiskPositionCase> => ({
      measured: { beta: null, pnlByMove: input.moves.map(() => 0), ...flatSides(), exposureUsd: 0 },
      selloff: { beta: null, pnlByMove: input.moves.map(() => 0), ...flatSides(), exposureUsd: 0 },
    });
    const sec = readTrialSecurity(db, identitySecurityId);
    // Dollars per unit of the security's own currency; null when a foreign row has no rate.
    const fx = sec === null ? null : trialCurrency(sec) === "USD" ? 1 : sec.fx_usd_per_unit;
    const refused = (
      refusal: TrialRefusal,
      extra: Partial<GainsAtRiskTrialRow> = {},
    ): GainsAtRiskTrialRow => ({
      id: t.id,
      kind: t.kind,
      identitySecurityId,
      symbol: sec?.symbol ?? "",
      name: sec?.name ?? null,
      betaSource: "not-modelled",
      measuredBeta: null,
      noLinkWarning: false,
      valuation: null,
      refusal,
      valueUsd: null,
      cost: null,
      holdingsNowByAccount,
      leavesShortBy: null,
      ...extra,
      cases: flatCases(),
    });

    if (sec === null) return done(refused("unknown-security"));
    if (isOptionSecurityType(sec.security_type)) return done(refused("is-an-option"));
    if (t.kind === "option" && trialCurrency(sec) !== "USD") return done(refused("foreign-currency"));
    if (fx === null) return done(refused("no-fx-rate"));
    // P11: a trial kept on the page whose contract has since expired adds nothing.
    if (t.kind === "option" && isExpiredAsOf(t.expiry, today, now)) return done(refused("expired"));
    // One price per name in every scope; the entry reads the same function.
    const valuation = trialValuationPrice(db, identitySecurityId, { today });
    if (valuation === null) return done(refused("no-underlying-price"));
    const cost: TrialCost =
      t.kind === "option"
        ? { kind: buying ? "premium-paid" : "premium-received", usd: t.pricePaid * t.contracts * TRIAL_OPTION_MULTIPLIER }
        : { kind: buying ? "cash-used" : "cash-raised", usd: t.quantity * t.price * fx };

    const { resolved, ownerBeta, betaOverrideRefusal, betas, betaSource, volApplies } = ladderFor(trialBetaRow(sec, t.kind));
    const rowVol = volApplies ? volChange : 0;
    // As for a held row: a key counts as applied where the trial reached the beta and
    // was priced, or where the owner's figure was refused on it (review fix 4).
    if (betaOverrideRefusal !== undefined) applied = true;
    const ladderRefusal = resolved.source === "not-modelled" ? { ladderRefusal: resolved.reason } : {};
    const betaFields = {
      betaSource,
      measuredBeta: resolved.beta,
      ...(resolved.source === "measured" || resolved.source === "no-measured-link"
        ? { evidence: resolved.evidence }
        : {}),
      ...(resolved.source === "no-measured-link" ? { noMeasuredLinkReason: resolved.reason } : {}),
    };
    // Shares are marked at the app's price (R3). An option is marked RELATIVE to the app's
    // own price series (fix round 2): the quote and the stored price are on different
    // bases and are never differenced, so at the click the ratio is exactly 1.
    const P =
      t.kind === "option"
        ? valuation.price === t.valuationPriceAtEntry
          ? t.entryUnderlyingPrice
          : t.entryUnderlyingPrice * (valuation.price / t.valuationPriceAtEntry)
        : valuation.price;

    type TrialPriced = { pnl: number; expires: boolean; v0: number };
    const priceAt = (
      beta: number,
      move: number,
      valuationDate: string,
      vol: number,
    ): TrialPriced | { unmodelled: OptionUnmodelledReason } => {
      const underlyingMove = Math.max(beta * move, -1);
      if (t.kind === "shares") {
        // R3: marked against the typed price; a sale carries the sign.
        return { pnl: sign * t.quantity * (P * (1 + underlyingMove) - t.price) * fx, expires: false, v0: P };
      }
      // R1: the recorded volatility at the underlying's current price; never solved again.
      const r = repriceOptionUnderShock(
        {
          option_type: t.right === "put" ? "PUT" : "CALL",
          strike_price: t.strike,
          expiration_date: t.expiry,
          own_price: null,
          underlying_price: P,
          underlying_iv: t.entryVolatility,
        },
        { underlyingMove, volChange: vol, riskFreeRate, today, now, valuationDate, modelWhenUnpriced: true },
      );
      if (!r.modelled) return { unmodelled: r.reason };
      // Expires before the date: the worse for the owner of the two orders (F4).
      const moveFirst = r.v1IfMoveFirst ?? r.v1;
      const v = r.expiresBeforeDate ? (buying ? Math.min(r.v1, moveFirst) : Math.max(r.v1, moveFirst)) : r.v1;
      const perShare = buying ? v - t.pricePaid : t.pricePaid - v;
      return { pnl: perShare * t.contracts * TRIAL_OPTION_MULTIPLIER, expires: r.expiresBeforeDate === true, v0: r.v0 };
    };
    const optionRefusal = (reason: OptionUnmodelledReason): TrialRefusal =>
      reason === "expired" || reason === "no-underlying-price" ? reason : "no-option-terms";

    // The mark now: at rest, today, no volatility change (beta plays no part at a 0% move).
    if (resolved.source === "not-modelled" && ownerBeta === undefined) {
      // The ladder refused the name (a leveraged fund with no factor or no
      // tracked index) and no owner's figure prices it: refused, as every
      // zero-effect trial is, with the ladder's reason.
      return done(refused("not-modelled", { valuation, ...ladderRefusal }));
    }
    const rest = priceAt(0, 0, today, 0);
    if ("unmodelled" in rest) return done(refused(optionRefusal(rest.unmodelled), { valuation }));
    const valueUsd = clean(t.kind === "shares" ? sign * t.quantity * P * fx : sign * rest.v0 * t.contracts * TRIAL_OPTION_MULTIPLIER);
    const identityName = { symbol: sec.symbol, name: sec.name };
    const noLinkWarning = t.kind === "option" && betaSource === "no-measured-link";

    const pricedByCase = {} as Record<GainsAtRiskCaseKey, TrialPriced[]>;
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      const beta = betas[k] as number;
      const priced = input.moves.map((m) => priceAt(beta, m, input.valuationDate, rowVol));
      const failed = priced.find((p): p is { unmodelled: OptionUnmodelledReason } => "unmodelled" in p);
      if (failed) return done(refused(optionRefusal(failed.unmodelled), { valuation }));
      pricedByCase[k] = priced as TrialPriced[];
    }
    // D10: the figure at a 0% move on the valuation date, whether or not 0 is in the sweep.
    let atZero: PricedRow["atZero"] = null;
    if (opt.zeroMove) {
      const z = {} as Record<GainsAtRiskCaseKey, number>;
      for (const k of GAINS_AT_RISK_CASE_KEYS) {
        const p = priceAt(betas[k] as number, 0, input.valuationDate, rowVol);
        if ("unmodelled" in p) return done(refused(optionRefusal(p.unmodelled), { valuation }));
        z[k] = cents0(p.pnl);
      }
      atZero = z;
    }
    const caseOut = (k: GainsAtRiskCaseKey): GainsAtRiskPositionCase => {
      const beta = betas[k] as number;
      const up = priceAt(beta, 0.01, today, 0);
      const down = priceAt(beta, -0.01, today, 0);
      const exposureUsd = "pnl" in up && "pnl" in down ? clean((up.pnl - down.pnl) / 0.02) : 0;
      const pnlByMove = pricedByCase[k].map((p) => cents0(p.pnl));
      const expires = pricedByCase[k].some((p) => p.expires);
      return { beta, pnlByMove, ...sidesOf(exposureUsd, pnlByMove, expires), exposureUsd };
    };
    const expiresBeforeDate = GAINS_AT_RISK_CASE_KEYS.some((k) => pricedByCase[k].some((p) => p.expires));
    applied = true;
    return done({
      id: t.id,
      kind: t.kind,
      identitySecurityId,
      ...identityName,
      ...betaFields,
      ...ladderRefusal,
      noLinkWarning,
      valuation,
      ...(expiresBeforeDate ? { expiresBeforeDate: true as const } : {}),
      valueUsd,
      cost,
      holdingsNowByAccount,
      leavesShortBy: null,
      cases: { measured: caseOut("measured"), selloff: caseOut("selloff") },
    }, atZero);
  };

  // D5: index mode reads falls; single-name mode reads the selected move's direction (rise only when positive).
  const crossingDirection: "fall" | "rise" =
    isSingleName && input.selectedMove !== undefined && input.selectedMove > 0 ? "rise" : "fall";

  // ─── Candidates (step 3) ──────────────────────────────────────
  // Each priced by the same body, on the same run context. A candidate never
  // enters positions, the trial list, net cash, the shortfall check, a
  // disclosure or the ignored-key count.
  const candidateResults = candidates.map((c): GainsAtRiskCandidateResult => {
    const { row, atZero } = priceTrialRow({ ...c.position, id: c.id }, { holdings: false, zeroMove: true });
    const base = {
      id: c.id,
      identitySecurityId: row.identitySecurityId,
      symbol: row.symbol,
      betaSource: row.betaSource,
    };
    if (row.refusal !== undefined || atZero === null) {
      return { ...base, refusal: row.refusal ?? "no-option-terms", valueUsd: null, cost: null, cases: null };
    }
    const selectedIndex = input.moves.indexOf(input.selectedMove as number);
    const caseOf = (k: GainsAtRiskCaseKey): GainsAtRiskCandidateCase => {
      const rc = row.cases[k];
      return {
        beta: rc.beta,
        pnlByMove: rc.pnlByMove,
        atSelectedMoveUsd: rc.pnlByMove[selectedIndex],
        atZeroMoveUsd: atZero[k],
        crossing: trialCrossing(input.moves, rc.pnlByMove, crossingDirection),
        crossingDirection,
        // P13a: read from the row's own beta source, never a guess.
        heldUnchanged:
          rc.beta === 0 &&
          (row.betaSource === "held-unchanged" ||
            row.betaSource === "leveraged-not-linked" ||
            row.betaSource === "no-measured-link"),
      };
    };
    return { ...base, valueUsd: row.valueUsd, cost: row.cost, cases: { measured: caseOf("measured"), selloff: caseOf("selloff") } };
  });
  if (trials.length === 0) return { ...book, candidates: candidateResults };

  // ─── Trial positions (step 2) ─────────────────────────────────
  // After the book, through the per-row body. Trial rows are never in
  // positions, gross book, unknown counts, evidence or any disclosure (R6):
  // only `trial` and the ignored-key count read them.
  const trialApplied = new Set<number>();
  const trialRows = trials.map((t): GainsAtRiskTrialRow => {
    const { row, applied } = priceTrialRow(t, { holdings: true, zeroMove: false });
    if (applied) trialApplied.add(row.identitySecurityId);
    return row;
  });

  // P4: "leaves you short", over the whole list, against every account's holding.
  const priced = trials.filter((_, i) => trialRows[i].refusal === undefined);
  const heldBySecurity = new Map<number, number>();
  trials.forEach((t, i) => {
    if (t.kind !== "shares") return;
    const total = Object.values(trialRows[i].holdingsNowByAccount).reduce((a, b) => a + b, 0);
    heldBySecurity.set(t.securityId, total);
  });
  const shortfalls = trialShortfalls(priced, heldBySecurity);
  trials.forEach((t, i) => {
    if (t.kind === "shares" && t.side === "sell" && trialRows[i].refusal === undefined) {
      trialRows[i].leavesShortBy = shortfalls.bySaleId.get(t.id) ?? 0;
    }
  });
  const shortByName = [...shortfalls.byName].map(([securityId, shortBy]) => ({
    securityId,
    symbol: trialRows.find((r) => r.identitySecurityId === securityId && r.kind === "shares")?.symbol ?? "",
    shortBy,
    heldShortBefore: Math.max(0, -(heldBySecurity.get(securityId) ?? 0)),
  }));

  let netCashUsd = 0;
  for (const r of trialRows) {
    if (r.refusal !== undefined || r.cost === null) continue;
    netCashUsd += r.cost.kind === "premium-received" || r.cost.kind === "cash-raised" ? r.cost.usd : -r.cost.usd;
  }

  const trialCases = {} as Record<GainsAtRiskCaseKey, GainsAtRiskTrialCase>;
  for (const k of GAINS_AT_RISK_CASE_KEYS) {
    const moveRows = input.moves.map((move, i): GainsAtRiskTrialMoveRow => {
      let total = 0;
      for (const r of trialRows) total += r.cases[k].pnlByMove[i];
      const trialPnlUsd = clean(cents0(total));
      return { move, trialPnlUsd, bookWithTrialPnlUsd: clean(cents0(book.cases[k].moves[i].bookPnlUsd + trialPnlUsd)) };
    });
    const atZero = input.moves.findIndex((m) => m === 0);
    trialCases[k] = {
      moves: moveRows,
      noMoveCostUsd: atZero < 0 ? null : clean(-moveRows[atZero].trialPnlUsd),
      crossing: trialCrossing(input.moves, moveRows.map((m) => m.trialPnlUsd), crossingDirection),
      ...(isSingleName ? { crossingDirection } : {}),
    };
  }

  const appliedWithTrials = new Set<number>([...(emptyScope ? [] : appliedIdentities), ...trialApplied]);
  return {
    ...book,
    betaOverridesIgnored: isSingleName ? ignoredAll : countIgnored(appliedWithTrials),
    trial: {
      rows: trialRows,
      netCashUsd: clean(netCashUsd),
      count: trialRows.length,
      refusedCount: trialRows.filter((r) => r.refusal !== undefined).length,
      noLinkWarningCount: trialRows.filter((r) => r.noLinkWarning).length,
      shortByName,
      cases: trialCases,
    },
    ...(candidates.length > 0 ? { candidates: candidateResults } : {}),
  };
}

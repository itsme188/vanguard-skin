/**
 * Gains at risk: the view's plain rules and words (Task 6).
 *
 * A plain module (no React, no database code at run time) so the server
 * section and the client view share one copy. A server page must never
 * import a function from a "use client" file; these helpers live here.
 *
 * The page shows one direction, down (ruling F15): the table rows are zero
 * and falls, the custom row takes zero or a fall, and the chart may run to a
 * small rise with its second line still on the engine's down split. No
 * on-screen copy names a plan step.
 */

import {
  GAINS_AT_RISK_BOUNDS,
  type GainsAtRiskDriver,
  type GainsAtRiskResponse,
} from "@/lib/analysis/gains-at-risk-input";
import { positionsFreshnessCell, type PositionsFreshnessCell } from "@/lib/ui/positions-freshness-label";
// Type only: erased at build, so no engine or query code reaches the client bundle.
import type {
  GainsAtRiskDisclosure,
  GainsAtRiskOverrideRefusal,
  GainsAtRiskPosition,
  GainsAtRiskResult,
  GainsAtRiskUnmodelled,
} from "@/lib/compute/gains-at-risk";
import type { YearGainReconciliationReason, YearGainResult } from "@/lib/compute/year-gain";
import type { PositionsFreshness } from "@/lib/queries/positions-freshness";

// ─── Inputs ─────────────────────────────────────────────────────

export const DEFAULT_DRIVER: GainsAtRiskDriver = "QQQ";

/** The fixed table rows: no move, then falls (F15). */
export const TABLE_MOVES = [0, -0.05, -0.1, -0.15] as const;

/** The table row selected when the page opens (the per-name table reads it). */
export const DEFAULT_SELECTED_MOVE = -0.1;

/** The chart sweep: -20% to +10% in 2.5% steps, written as exact decimals. */
export function defaultSweep(): number[] {
  return Array.from({ length: 13 }, (_, i) => (-200 + 25 * i) / 1000);
}

/** Dec 31 of the current year. */
export function defaultValuationDate(today: string): string {
  return `${today.slice(0, 4)}-12-31`;
}

/** Two moves are the same row when they agree to well under a basis point. */
export function sameMove(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/** null for a usable custom move (a decimal); otherwise one plain sentence. */
export function customMoveProblem(move: number): string | null {
  if (!Number.isFinite(move)) return "Type the move as a number of percent, for example -7.";
  if (move > 0) return "This page shows a fall: type zero or a negative percent.";
  const floorPct = Math.round(GAINS_AT_RISK_BOUNDS.moveAbsMax * 100);
  if (move < -GAINS_AT_RISK_BOUNDS.moveAbsMax) return `The move cannot be below -${floorPct}%.`;
  return null;
}

/** Every move the request asks for: the sweep, the table rows and the custom row; sorted, unique. */
export function requestMoves(sweep: number[], custom: number | null): number[] {
  const all = [...sweep, ...TABLE_MOVES, ...(custom === null ? [] : [custom])];
  const out: number[] = [];
  for (const m of [...all].sort((a, b) => a - b)) {
    if (!out.some((x) => sameMove(x, m))) out.push(m);
  }
  return out;
}

/** "-0.175" → "−17.5%". The driver's move is market data, shown plain. */
export function formatDriverMove(move: number): string {
  const pct = Number((Math.abs(move) * 100).toFixed(1));
  if (pct === 0) return "0%";
  return `${move < 0 ? "−" : "+"}${pct}%`;
}

/** The chart's tooltip label: the driver's move, whatever type the chart hands over. */
export function formatDriverMoveLabel(label: unknown): string {
  return typeof label === "number" && Number.isFinite(label) ? formatDriverMove(label) : String(label ?? "");
}

// ─── The share of the year's gain ───────────────────────────────

function usableGain(g: YearGainResult): number | null {
  if (g.gainUsd === null || !Number.isFinite(g.gainUsd) || g.gainUsd <= 0) return null;
  // F2: a gain the statements contradict carries no ratio.
  if (g.reconciliation.status === "differs") return null;
  return g.gainUsd;
}

/** Share of the year's gain the book gives back at a move (positive = given back). */
export function gainGivenBackShare(bookPnlUsd: number, yearGain: YearGainResult): number | null {
  const gain = usableGain(yearGain);
  if (gain === null || !Number.isFinite(bookPnlUsd)) return null;
  return -bookPnlUsd / gain;
}

/** Share of the year's gain still kept at a move. */
export function gainKeptShare(bookPnlUsd: number, yearGain: YearGainResult): number | null {
  const gain = usableGain(yearGain);
  if (gain === null || !Number.isFinite(bookPnlUsd)) return null;
  return 1 + bookPnlUsd / gain;
}

export const YEAR_GAIN_LABEL = "Year's gain so far";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-10-31" → "October 2026". Anything else passes through. */
export function monthLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(date);
  const name = m ? MONTH_NAMES[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : date;
}

/** Why the statements check could not stand, in plain words. */
/** Each is one sentence, written without its closing period. */
export const RECONCILIATION_REASON_LABELS: Record<YearGainReconciliationReason, string> = {
  "flows-disagree": "The ledger and a statement's own flow figure disagree",
  "foreign-in-kind": "A transfer of a foreign security in kind makes the two figures not comparable",
  "ledger-unverified": "The statements carry no flow figure to check the ledger against",
  "month-without-figure": "A statement month has no figure",
};

const NOT_CHECKED_DEFAULT = "No month of the year could be checked against the statements yet";

export interface ReconciliationLine {
  kind: "agrees" | "differs" | "not-checked";
  /**
   * The words after "Statements check: ", without the closing period. When
   * `differenceUsd` is set the page prints it (through <Money>) right after
   * them, then the period. One colon per line: the label's own.
   */
  text: string;
  differenceUsd: number | null;
}

export function reconciliationLine(g: YearGainResult): ReconciliationLine {
  const r = g.reconciliation;
  const through = r.throughMonth ? monthLabel(r.throughMonth) : null;
  if (r.status === "agrees") {
    return {
      kind: "agrees",
      text: `agrees with the statements' own flow figures${through ? ` through ${through}` : ""}`,
      differenceUsd: null,
    };
  }
  if (r.status === "differs") {
    if (r.reason === "flows-disagree" || r.differenceUsd === null) {
      return {
        kind: "differs",
        text: `differs${through ? ` through ${through}` : ""}. ${RECONCILIATION_REASON_LABELS["flows-disagree"]}`,
        differenceUsd: null,
      };
    }
    return {
      kind: "differs",
      text: `differs${through ? ` through ${through}` : ""} by`,
      differenceUsd: r.differenceUsd,
    };
  }
  return {
    kind: "not-checked",
    text: `not checked. ${r.reason ? RECONCILIATION_REASON_LABELS[r.reason] : NOT_CHECKED_DEFAULT}`,
    differenceUsd: null,
  };
}

function names(list: { name: string }[]): string {
  return list.map((a) => a.name).join(", ");
}

/**
 * The one line under the headline when the share column is hidden or needs a
 * note. null when the share stands with nothing to add.
 */
export function yearGainNote(g: YearGainResult): string | null {
  if (g.gainUsd === null || !Number.isFinite(g.gainUsd)) {
    const parts: string[] = [];
    if (g.missingBaseAccounts.length > 0) {
      parts.push(`no statement for ${monthLabel(g.baseDate)} in ${names(g.missingBaseAccounts)}`);
    }
    const noValue = g.unusableCurrentAccounts.filter((a) => a.reason === "no-current-value");
    if (noValue.length > 0) parts.push(`no current value for ${names(noValue)}`);
    const early = g.unusableCurrentAccounts.filter((a) => a.reason === "value-before-year");
    if (early.length > 0) parts.push(`a current value dated before this year for ${names(early)}`);
    if (g.unconvertedFlowAccounts.length > 0) {
      parts.push(`money moved in or out with no dollar rate in ${names(g.unconvertedFlowAccounts)}`);
    }
    return parts.length > 0
      ? `The year's gain is not available, so no share of it is shown: ${parts.join("; ")}.`
      : "The year's gain is not available, so no share of it is shown.";
  }
  if (g.gainUsd <= 0) {
    return "The year's gain so far is zero or negative, so no share of it given back is shown.";
  }
  const r = g.reconciliation;
  if (r.status === "differs") {
    return r.reason === "flows-disagree"
      ? "The ledger and a statement's own flow figure disagree, so the year's gain is not confirmed by the statements and no share of it given back is shown."
      : "The year's gain differs from the statements' own figures, so no share of it given back is shown.";
  }
  if (r.status === "not-checked") {
    // The reason is on the statements-check line already; say it once.
    return "The year's gain is not checked against the statements, so the share given back is shown unconfirmed.";
  }
  return null;
}

// ─── Words ──────────────────────────────────────────────────────

/**
 * The route's 400 sentence names request fields (`gainsAtRiskBodyProblem`);
 * the page names the control instead. A sentence it does not know passes
 * through unchanged.
 */
export function domainProblemText(message: string): string {
  const overrides = /^priceOverrides can hold at most (\d+) entries\.$/.exec(message);
  if (overrides) return `At most ${overrides[1]} typed prices can be sent at once.`;
  if (message === "priceOverrides values must be numbers.") return "Typed prices must be numbers.";
  if (message.startsWith("priceOverrides keys")) return "A typed price is not tied to a position on this page.";
  if (message.startsWith("priceOverrides must be")) return "The typed prices could not be read.";
  const fields: [string, string][] = [
    ["valuationDate ", "The date "],
    ["volChangePoints ", "The volatility change "],
    ["driverSymbol ", "The index "],
    ["moves ", "The moves "],
    ["scope ", "The stress scope "],
  ];
  for (const [field, words] of fields) {
    if (message.startsWith(field)) return words + message.slice(field.length);
  }
  return message;
}

export const COLUMN_LABELS = {
  move: "move",
  losers: "Positions that lose",
  // In a fall these positions gain, so the heading says what they are.
  offsets: "Offsetting positions",
  book: "Book",
  givenBack: "Gain given back",
} as const;

export const LINE_LABELS = { book: "book", without: "without the offsetting positions" } as const;

/** The 0% row at a later date is not zero: options lose time value by then. */
export const ZERO_ROW_NOTE = "With no move, this is what time alone does to the options by that date.";

export const DOWN_ONLY_NOTE =
  "This page shows a fall in the index. The split into losing and offsetting positions is worked out for a fall.";

export const NOT_MODELLED_LABELS: Record<GainsAtRiskUnmodelled, string> = {
  "leveraged-no-factor": "leveraged or inverse fund with no stored leverage factor",
  "leveraged-no-tracked-index": "leveraged or inverse fund whose tracked index is not known",
  "tracked-index-not-measured": "the fund's tracked index has too little price history against this index",
  "no-driver-conversion": "no beta to this index, and the index's own market beta could not be measured to convert one",
  "no-heuristic-beta": "no measured beta and no estimate could be made",
  "no-option-terms": "option terms (strike, expiry or type) are missing",
  expired: "the option has expired",
  "no-option-price": "the option has no price",
  "no-underlying-price": "the option's underlying has no price",
  "no-volatility": "no volatility source for the option",
  "no-price": "no price",
  "no-fx-rate": "no exchange rate to dollars",
};

export type BetaSourceKey = GainsAtRiskPosition["betaSource"];

export const BETA_SOURCE_LABELS: Record<BetaSourceKey, string> = {
  driver: "the index itself",
  measured: "measured against the index",
  "market-converted": "measured against SPY, converted (estimated)",
  estimated: "estimated, not measured",
  fixed: "set by type (cash or bonds)",
  leveraged: "leverage times its tracked index",
  "not-modelled": "not modelled",
};

export const OVERRIDE_REFUSAL_LABELS: Record<GainsAtRiskOverrideRefusal, string> = {
  "not-positive": "A price must be above zero. The model price is kept.",
  "below-intrinsic": "That price is below what the option is worth if exercised now. The model price is kept.",
  "row-has-price": "This option already has a price of its own, so your price is not used.",
  "not-solvable": "No volatility fits that price. The model price is kept.",
  "not-an-option": "Only an option can take a typed price.",
};

export const PRICE_SOURCE_LABELS: Record<NonNullable<GainsAtRiskPosition["priceSource"]>, string> = {
  "own-price": "own price",
  model: "priced from model",
  override: "your price",
};

// ─── Disclosures ────────────────────────────────────────────────

type DisclosureKey = keyof GainsAtRiskResult["disclosures"];

const DISCLOSURE_TEXT: Record<DisclosureKey, string> = {
  notModelled: "Not modelled",
  betaEstimated: "Beta estimated, not measured",
  pricedFromModel: "Options priced from model",
  expiresBeforeDate: "Options that expire before the date",
};

const DISCLOSURE_ORDER: DisclosureKey[] = ["notModelled", "betaEstimated", "pricedFromModel", "expiresBeforeDate"];

export function disclosureSentences(
  d: GainsAtRiskResult["disclosures"],
): { key: string; text: string; count: number; shareOfBook: number | null; unknownValueCount: number; symbols: string[] }[] {
  return DISCLOSURE_ORDER.map((key) => ({
    key,
    text: DISCLOSURE_TEXT[key],
    count: d[key].count,
    shareOfBook: d[key].shareOfBook,
    unknownValueCount: d[key].unknownValueCount,
    symbols: d[key].symbols,
  }));
}

/**
 * How a disclosure's share prints (F12): a null share reads "share not
 * known"; a zero share beside unknown values is left out (the unknown count
 * is shown instead), never a bare 0%.
 */
export function disclosureShare(
  d: Pick<GainsAtRiskDisclosure, "shareOfBook" | "unknownValueCount">,
): { kind: "pct"; value: number } | { kind: "not-known" } | { kind: "omit" } {
  if (d.shareOfBook === null || !Number.isFinite(d.shareOfBook)) return { kind: "not-known" };
  if (d.shareOfBook === 0 && d.unknownValueCount > 0) return { kind: "omit" };
  return { kind: "pct", value: d.shareOfBook };
}

// ─── Freshness ──────────────────────────────────────────────────

/** The stress scope's freshness; a scope with no accounts never reads as fresh. */
export function scopeFreshnessCell(f: PositionsFreshness, scopeHasAccounts: boolean): PositionsFreshnessCell {
  if (!scopeHasAccounts) {
    return {
      dateText: "No accounts in this scope",
      countText: null,
      tone: "neutral",
      hint: "No account matches this scope, so nothing is stressed.",
    };
  }
  return positionsFreshnessCell(f);
}

// ─── The share column ───────────────────────────────────────────

/**
 * One cell of the "Gain given back" column. A row where the book gains reads
 * "none: the book gains", never a negative percent. A positive share that
 * would print 0.0% reads "under 0.1%". A share above 100% prints as it is.
 */
export type GivenBackCell =
  | { kind: "hidden" }
  | { kind: "book-gains" }
  | { kind: "under-tenth" }
  | { kind: "pct"; percent: number };

export const BOOK_GAINS_TEXT = "none: the book gains";
export const UNDER_TENTH_TEXT = "under 0.1%";

export function givenBackCell(bookPnlUsd: number, yearGain: YearGainResult): GivenBackCell {
  const share = gainGivenBackShare(bookPnlUsd, yearGain);
  if (share === null) return { kind: "hidden" };
  if (bookPnlUsd > 0) return { kind: "book-gains" };
  const percent = share * 100;
  if (percent > 0 && percent < 0.05) return { kind: "under-tenth" };
  return { kind: "pct", percent };
}

// ─── The chart ──────────────────────────────────────────────────

export interface GainsChartRow {
  move: number;
  book: number;
  without: number;
}

/**
 * The chart's points: only the default sweep's moves, in move order, so the
 * table's custom row never adds an extra point (on a numeric axis the
 * spacing is then true to the move). The second line is the book without its
 * offsetting positions: the engine's `losersPnlUsd`.
 */
export function chartRows(moves: GainsAtRiskResult["moves"]): GainsChartRow[] {
  const sweep = defaultSweep();
  return moves
    .filter((r) => sweep.some((m) => sameMove(m, r.move)))
    .sort((a, b) => a.move - b.move)
    .map((r) => ({ move: r.move, book: r.bookPnlUsd, without: r.losersPnlUsd }));
}

/** The dollar axis: every plotted value and zero, padded 5%. */
export function chartDollarDomain(rows: GainsChartRow[]): [number, number] {
  const values = rows.flatMap((r) => [r.book, r.without, 0]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.05 || 1;
  return [lo - pad, hi + pad];
}

const KEPT_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5];

/**
 * The right-hand "gain kept" axis, or null when no share can be stated. Its
 * domain is the dollar domain rescaled (kept = 1 + dollars / gain), so a
 * reading on it lines up with the book line; its TICKS are kept within
 * -100%..100% so the axis stays readable when a fall would take more than
 * the year's gain.
 */
export function keptAxis(
  dollarDomain: [number, number],
  yearGain: YearGainResult,
): { domain: [number, number]; ticks: number[] } | null {
  const lo = gainKeptShare(dollarDomain[0], yearGain);
  const hi = gainKeptShare(dollarDomain[1], yearGain);
  if (lo === null || hi === null) return null;
  const tickLo = Math.max(-1, lo);
  const tickHi = Math.min(1, hi);
  const ticks: number[] = [];
  if (tickLo <= tickHi) {
    const step = KEPT_STEPS.find((st) => (tickHi - tickLo) / st <= 6) ?? 0.5;
    for (let k = Math.ceil(tickLo / step - 1e-9); k * step <= tickHi + 1e-9; k++) {
      ticks.push(Math.round(k * step * 1000) / 1000);
    }
  }
  return { domain: [lo, hi], ticks };
}

// ─── Price boxes ────────────────────────────────────────────────

/**
 * A typed price is one price per security (the contract), so when one option
 * is held in two accounts only the first row shown gets the box; the others
 * read "same price as above". Returns the row keys (`account:security`)
 * that own a box, given the rows in display order.
 */
export function priceBoxOwners(
  rows: Pick<GainsAtRiskPosition, "accountId" | "securityId" | "priceSource">[],
): Set<string> {
  const seen = new Set<number>();
  const owners = new Set<string>();
  for (const r of rows) {
    if (r.priceSource !== "model" && r.priceSource !== "override") continue;
    if (seen.has(r.securityId)) continue;
    seen.add(r.securityId);
    owners.add(`${r.accountId}:${r.securityId}`);
  }
  return owners;
}

export const SAME_PRICE_TEXT = "same price as above";

// ─── Failures ───────────────────────────────────────────────────

export const COMPUTE_FAILED_TEXT = "Could not compute gains at risk.";

/** A server error reads once; a refused input names the control. */
export function requestFailureText(status: number, message: string): string {
  if (status >= 500 || message.trim() === COMPUTE_FAILED_TEXT) return COMPUTE_FAILED_TEXT;
  return `${COMPUTE_FAILED_TEXT} ${domainProblemText(message)}`;
}

// ─── Controls ───────────────────────────────────────────────────

export interface GainsControls {
  driverSymbol: GainsAtRiskDriver;
  valuationDate: string;
  volChangePoints: number;
  /** The committed custom move (a decimal), or none. */
  custom: number | null;
  /** Owner-typed option prices per share, by security id. Page state only. */
  priceOverrides: Record<number, number>;
}

/**
 * Whether fresh server props (computed with the default controls) answer the
 * controls on screen. When they do the page takes them as they are; when they
 * do not, the page keeps its controls and asks again with them, so a refresh
 * never drops what the owner set.
 */
export function serverPropsAnswerControls(
  controls: GainsControls,
  server: { driverSymbol: GainsAtRiskDriver; valuationDate: string; volChangePoints: number },
): boolean {
  return (
    controls.driverSymbol === server.driverSymbol &&
    controls.valuationDate === server.valuationDate &&
    controls.volChangePoints === server.volChangePoints &&
    controls.custom === null &&
    Object.keys(controls.priceOverrides).length === 0
  );
}

// ─── Requests: a response for an older request is never shown (F19) ──

export type GainsRequestState = {
  latestSeq: number;
  /** The answer to the latest request; null while it runs or after it failed. */
  result: GainsAtRiskResponse | null;
  /**
   * The last answer shown, kept only so the page's layout (the tables and
   * their input boxes) stays mounted while a request runs or after one
   * failed. Never presented as the answer to the current controls.
   */
  previous: GainsAtRiskResponse | null;
  error: string | null;
  loading: boolean;
};

export type GainsRequestAction =
  | { type: "start"; seq: number }
  | { type: "success"; seq: number; data: GainsAtRiskResponse }
  | { type: "failure"; seq: number; message: string }
  | { type: "reset"; data: GainsAtRiskResponse };

export function initialGainsRequestState(data: GainsAtRiskResponse): GainsRequestState {
  return { latestSeq: 0, result: data, previous: data, error: null, loading: false };
}

export function gainsRequestReducer(state: GainsRequestState, action: GainsRequestAction): GainsRequestState {
  switch (action.type) {
    case "start":
      // The shown result is cleared at once: it answered other controls.
      return {
        latestSeq: action.seq,
        result: null,
        previous: state.result ?? state.previous,
        error: null,
        loading: true,
      };
    case "success":
      if (action.seq !== state.latestSeq) return state;
      return { ...state, result: action.data, previous: action.data, error: null, loading: false };
    case "failure":
      if (action.seq !== state.latestSeq) return state;
      return { ...state, result: null, error: action.message, loading: false };
    case "reset":
      // Server props that answer the controls on screen; anything in flight is now older.
      return { latestSeq: state.latestSeq + 1, result: action.data, previous: action.data, error: null, loading: false };
  }
}

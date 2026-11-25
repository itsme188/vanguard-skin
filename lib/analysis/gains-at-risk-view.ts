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
 *
 * Two cases (addendum rulings B4, B6, C5, C6, C13): "Measured" (each name at
 * its beta measured from daily closes; a name with no measured link held
 * unchanged) and "Selloff case" (an ASSUMPTION: every stock and fund falls at
 * least one-for-one). The owner's own figure per name wins in both. A row's
 * `unmodelledReason` is read BEFORE its `betaSource` everywhere here.
 *
 * Client boundary (C12): this module and the client files value-import
 * nothing from lib/compute, lib/queries, lib/db or lib/tws (the engine pulls a
 * broker SDK through a type map). Engine types come in as `import type` only.
 */

import {
  GAINS_AT_RISK_BOUNDS,
  type GainsAtRiskBody,
  type GainsAtRiskDriver,
  type GainsAtRiskResponse,
} from "@/lib/analysis/gains-at-risk-input";
import {
  BETA_OVERRIDE_BOUNDS,
  SINGLE_NAME_DEFAULT_SWEEP,
  SINGLE_NAME_MOVE_BOUNDS,
} from "@/lib/analysis/gains-at-risk-constants";
import {
  formatPositionsDate,
  positionsFreshnessCell,
  type PositionsFreshnessCell,
} from "@/lib/ui/positions-freshness-label";
// Type only: erased at build, so no engine or query code reaches the client bundle.
import type {
  GainsAtRiskBetaOverrideRefusal,
  GainsAtRiskBetaSource,
  GainsAtRiskCase,
  GainsAtRiskCaseKey,
  GainsAtRiskDisclosure,
  GainsAtRiskMoveRow,
  GainsAtRiskOverrideRefusal,
  GainsAtRiskPosition,
  GainsAtRiskPositionCase,
  GainsAtRiskResult,
  GainsAtRiskTrialCase,
  GainsAtRiskTrialRow,
  GainsAtRiskUnmodelled,
  TrialPositionInput,
  TrialRefusal,
} from "@/lib/compute/gains-at-risk";
import type { DriverBetaRefusal } from "@/lib/compute/driver-beta";
import type { SingleNameDriverEntry } from "@/lib/compute/gains-at-risk-drivers";
import type { NoMeasuredLinkReason } from "@/lib/compute/security-regression";
import type { SortDir } from "@/lib/hooks/useSortParam";
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
export function requestMoves(sweep: number[], custom: number | null, tableMoves: readonly number[] = TABLE_MOVES): number[] {
  const all = [...sweep, ...tableMoves, ...(custom === null ? [] : [custom])];
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

// ─── The driver: an index, or one stock or fund (step 3) ────────

/**
 * What the sweep moves. The index variant carries no symbol: the index pick
 * stays in `GainsControls.driverSymbol` (a required body field, and kept
 * while the owner tries a single name so switching back restores it).
 */
export type DriverChoice = { kind: "index" } | { kind: "single-name"; entry: SingleNameDriverEntry };

/** The single-name table rows: falls and rises, in move order. */
export const SINGLE_NAME_TABLE_MOVES = [-0.4, -0.2, 0, 0.2, 0.4] as const;

/** The row selected when the owner switches to one stock or fund. */
export const DEFAULT_SINGLE_NAME_SELECTED_MOVE = -0.2;

/** Under the controls in single-name mode (P2). */
export const HELD_UNCHANGED_NOTE = "Other positions held unchanged. Their options still lose time value to the date.";

/** Under the volatility box in single-name mode (P4): the change reaches only the names that move. */
export function singleNameVolNote(symbol: string): string {
  return `In this mode the volatility change applies only to options on ${symbol}, on its other share classes, and on leveraged funds that track it.`;
}

/** Above the per-name table in single-name mode. */
export function singleNameMovesNote(symbol: string): string {
  return `${symbol} and its other share classes move by the full move, and so does every option on them. A leveraged fund that tracks it moves by its leverage. Every other name is held unchanged.`;
}

/** The radio labels. */
export const DRIVER_KIND_LABELS = { index: "Index", "single-name": "One stock or fund" } as const;

/** When the drivers list is empty. */
export const NO_SINGLE_NAME_TEXT = "No stock or fund with a price is held, so there is nothing to choose here.";

/** When the chosen name dropped off the list (a trial on it was removed). */
export function driverDroppedText(symbol: string): string {
  return `${symbol} is no longer on the list of names, so the page went back to the index.`;
}

export const DRIVERS_REFRESH_FAILED_TEXT = "Could not refresh the list of names. The list shown may be out of date.";

/** "ZZA (ZZA Holdings)" for the select; the symbol alone with no name. */
export function driverOptionLabel(e: Pick<SingleNameDriverEntry, "symbol" | "name">): string {
  return e.name ? `${e.symbol} (${e.name})` : e.symbol;
}

/** The select's value for an entry: its id, or its symbol for a name with no row. */
export function driverOptionValue(e: Pick<SingleNameDriverEntry, "symbol" | "securityId">): string {
  return e.securityId !== null ? `id:${e.securityId}` : `sym:${e.symbol}`;
}

/** The entry of the list a select value names; null when the list has none. */
export function driverFromOptionValue(list: readonly SingleNameDriverEntry[], value: string): SingleNameDriverEntry | null {
  return list.find((e) => driverOptionValue(e) === value) ?? null;
}

/** The same entry again in a fresh list (by id, or by symbol for a name with no row); null when it is gone. */
export function sameDriverIn(
  list: readonly SingleNameDriverEntry[],
  e: Pick<SingleNameDriverEntry, "symbol" | "securityId">,
): SingleNameDriverEntry | null {
  return driverFromOptionValue(list, driverOptionValue(e));
}

/** The default single-name sweep, -40% to +40% in 5% steps, written as exact decimals. */
export function singleNameSweep(): number[] {
  const { from, to, step } = SINGLE_NAME_DEFAULT_SWEEP;
  const n = Math.round((to - from) / step) + 1;
  return Array.from({ length: n }, (_, i) => Math.round((from + i * step) * 1000) / 1000);
}

/** The chart sweep for a driver kind. */
export function sweepFor(kind: DriverChoice["kind"]): number[] {
  return kind === "single-name" ? singleNameSweep() : defaultSweep();
}

/** The table rows for a driver kind. */
export function tableMovesFor(kind: DriverChoice["kind"]): readonly number[] {
  return kind === "single-name" ? SINGLE_NAME_TABLE_MOVES : TABLE_MOVES;
}

/** The row selected by default for a driver kind. */
export function defaultSelectedMoveFor(kind: DriverChoice["kind"]): number {
  return kind === "single-name" ? DEFAULT_SINGLE_NAME_SELECTED_MOVE : DEFAULT_SELECTED_MOVE;
}

/** The custom move box's bounds, in percent, for a driver kind. */
export function customMoveBoundsPct(kind: DriverChoice["kind"]): { min: number; max: number } {
  if (kind === "single-name") {
    return { min: Math.round(SINGLE_NAME_MOVE_BOUNDS.min * 100), max: Math.round(SINGLE_NAME_MOVE_BOUNDS.max * 100) };
  }
  return { min: -Math.round(GAINS_AT_RISK_BOUNDS.moveAbsMax * 100), max: 0 };
}

/** null for a usable custom move (a decimal) for the driver kind; otherwise one plain sentence. */
export function customMoveProblemFor(kind: DriverChoice["kind"], move: number): string | null {
  if (kind === "index") return customMoveProblem(move);
  if (!Number.isFinite(move)) return "Type the move as a number of percent, for example -7 or 12.";
  const { min, max } = customMoveBoundsPct("single-name");
  if (move < SINGLE_NAME_MOVE_BOUNDS.min - 1e-12) return `The move cannot be below ${min}%.`;
  if (move > SINGLE_NAME_MOVE_BOUNDS.max + 1e-12) return `The move cannot be above +${max}%.`;
  return null;
}

/** The body's `driver` field: nothing for the index (P8: today's body), else the name on the server's list. */
export function driverRequestFields(choice: DriverChoice): Pick<GainsAtRiskBody, "driver"> {
  if (choice.kind === "index") return {};
  const e = choice.entry;
  return { driver: e.securityId !== null ? { kind: "single-name", securityId: e.securityId } : { kind: "single-name", symbol: e.symbol } };
}

/** Which way a selected move reads (D5): a rise when positive, else a fall (zero reads falls). */
export function moveDirection(move: number): "fall" | "rise" {
  return move > 0 ? "rise" : "fall";
}

/**
 * A single-name table row's cells (P6): the split of that row's own direction,
 * and none on the zero row (no move, so no side loses or offsets).
 */
export function singleNameRowCells(row: Pick<GainsAtRiskMoveRow, "bookPnlUsd" | "losersPnlUsd" | "offsetsPnlUsd" | "split">): {
  loses: number | null;
  offsets: number | null;
  book: number;
} {
  if (row.split === "none") return { loses: null, offsets: null, book: row.bookPnlUsd };
  return { loses: row.losersPnlUsd, offsets: row.offsetsPnlUsd, book: row.bookPnlUsd };
}

/** One figure of the single-name headline: its words, then the amount, then (a loss only) its share. */
export interface HeadlineFigure {
  text: string;
  usd: number;
  /** Share of the year's gain given back; null unless a loss with a positive, uncontradicted gain. */
  share: number | null;
}

/**
 * The sentence under the single-name table: the book's change at the selected
 * move. The figure and the share come back apart (the page prints them
 * through <Money> and <Pct>); the share only on a loss, and only when the
 * year's gain is positive and not contradicted by the statements (P6).
 *
 * With trial positions (`withTrialUsd` a number) both figures are given, each
 * labelled: the book as it is, then with the trial positions, each with its
 * own share under the same rule.
 */
export function singleNameHeadline(
  row: Pick<GainsAtRiskMoveRow, "move" | "bookPnlUsd">,
  symbol: string,
  yearGain: YearGainResult,
  withTrialUsd: number | null = null,
): HeadlineFigure & { withTrial: HeadlineFigure | null } {
  const shareOf = (usd: number) => (usd < 0 ? gainGivenBackShare(usd, yearGain) : null);
  const lead = `If ${symbol} moves ${formatDriverMove(row.move)}, the book`;
  if (withTrialUsd === null || !Number.isFinite(withTrialUsd)) {
    return { usd: row.bookPnlUsd, share: shareOf(row.bookPnlUsd), text: `${lead} changes by`, withTrial: null };
  }
  return {
    usd: row.bookPnlUsd,
    share: shareOf(row.bookPnlUsd),
    text: `${lead} as it is changes by`,
    withTrial: { usd: withTrialUsd, share: shareOf(withTrialUsd), text: "with trial positions," },
  };
}

/** The single-name chart: one book line, and the book with trial positions when there are any. */
export interface SingleNameChartRow {
  move: number;
  book: number;
  /** null when there are no trial positions. */
  withTrial: number | null;
}

/**
 * The single-name chart's points, on the single-name sweep only. In this
 * mode the engine returns the same figures under both cases (P20), so the
 * measured case is read. No line without the offsetting positions: one line
 * cannot follow two splits (P6). A move missing from either side is left out.
 */
export function singleNameChartRows(
  book: Pick<GainsAtRiskCase, "moves">,
  trial: { moves: GainsAtRiskTrialCase["moves"] } | null,
): SingleNameChartRow[] {
  const out: SingleNameChartRow[] = [];
  for (const move of singleNameSweep()) {
    const b = book.moves.find((r) => sameMove(r.move, move));
    if (!b) continue;
    if (trial) {
      const t = trial.moves.find((r) => sameMove(r.move, move));
      if (!t) continue;
      out.push({ move: b.move, book: b.bookPnlUsd, withTrial: t.bookWithTrialPnlUsd });
    } else {
      out.push({ move: b.move, book: b.bookPnlUsd, withTrial: null });
    }
  }
  return out;
}

/** The single-name chart's dollar axis: every plotted value and zero, padded 5%. */
export function singleNameChartDollarDomain(rows: SingleNameChartRow[]): [number, number] {
  const values = rows.flatMap((r) => [r.book, ...(r.withTrial === null ? [] : [r.withTrial]), 0]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.05 || 1;
  return [lo - pad, hi + pad];
}

/** The single-name chart's x ticks: every 10%. */
export const SINGLE_NAME_X_TICKS = [-0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4] as const;

/** The single-name legend. */
export function singleNameChartLineLabels(hasTrial: boolean): { book: string; withTrial: string } {
  return { book: hasTrial ? "book as it is" : "book", withTrial: "book with your trial positions" };
}

/**
 * The case the page reads. Single-name mode has one case, returned under both
 * keys (P20): the page reads "measured" and hides the switch.
 */
export function caseOnScreen(kind: DriverChoice["kind"], picked: GainsAtRiskCaseKey): GainsAtRiskCaseKey {
  return kind === "single-name" ? DEFAULT_CASE : picked;
}

/**
 * The owner's figures sent with a request: none in single-name mode (P2;
 * they stay in page state for the index), else every one typed.
 */
export function betaOverridesToSend(kind: DriverChoice["kind"], figures: Record<number, number>): Record<number, number> {
  return kind === "single-name" ? {} : figures;
}

/**
 * Switching the driver kind (or the name). A new kind resets the sweep's
 * custom row and the selected row to that kind's defaults; the date, the
 * volatility change, typed prices and the owner's figures are kept (the trial
 * list lives in its provider and is never touched here). Choosing another
 * name of the same kind keeps the custom row and the selected row.
 */
export function switchDriver(
  controls: GainsControls,
  selectedMove: number,
  next: DriverChoice,
): { controls: GainsControls; selectedMove: number } {
  if (controls.driver.kind === next.kind) return { controls: { ...controls, driver: next }, selectedMove };
  return { controls: { ...controls, driver: next, custom: null }, selectedMove: defaultSelectedMoveFor(next.kind) };
}

/** Under the single-name chart: why there is one book line. */
export const SINGLE_NAME_CHART_NOTE =
  "The chart shows the whole book only, because which positions lose depends on whether the stock falls or rises.";

/** In single-name mode, when the owner has typed figures for the index. */
export const FIGURES_KEPT_NOTE = "Your own per-name figures are kept and not used in this mode.";

/** When the driver list could not be loaded. */
export const DRIVERS_LOAD_FAILED_TEXT = "The list of stocks and funds could not be loaded. The index still works.";

/** The page's one-line description, by driver kind. */
export function pageDescription(kind: DriverChoice["kind"]): string {
  return kind === "single-name"
    ? "If one stock or fund falls or rises by a date, how much the book gains or gives back."
    : "If an index falls by a date, how much of the year's gain the book gives back.";
}

/**
 * A row's side at the selected move: in single-name mode the side of that
 * move's own direction (P6), else the row's one side.
 */
export function rowSideAt(
  pc: Pick<GainsAtRiskPositionCase, "side" | "sideDown" | "sideUp">,
  kind: DriverChoice["kind"],
  selectedMove: number,
): GainsAtRiskPositionCase["side"] {
  if (kind !== "single-name") return pc.side;
  // No move, no split (P6): no side either.
  if (sameMove(selectedMove, 0)) return "flat";
  return (moveDirection(selectedMove) === "rise" ? pc.sideUp : pc.sideDown) ?? pc.side;
}

/** The table's rows for a driver kind: the fixed rows, plus the custom one; single-name rows in move order. */
export function tableRowMoves(kind: DriverChoice["kind"], custom: number | null): number[] {
  const fixed = [...tableMovesFor(kind)];
  const extra = custom !== null && !fixed.some((m) => sameMove(m, custom)) ? [custom] : [];
  const rows = [...fixed, ...extra];
  return kind === "single-name" ? rows.sort((a, b) => a - b) : rows;
}

/**
 * What a result was computed for: its own driver kind and symbol. Everything
 * drawn about a result (layout, headings, table and chart shape, headline)
 * reads this, never the controls.
 */
export function resultDriver(result: Pick<GainsAtRiskResult, "driverKind" | "driverSymbol">): {
  kind: DriverChoice["kind"];
  symbol: string;
} {
  return { kind: result.driverKind === "single-name" ? "single-name" : "index", symbol: result.driverSymbol };
}

/** Whether a result was computed for the driver the controls show (kind and name). */
export function resultAnswersDriver(
  result: Pick<GainsAtRiskResult, "driverKind" | "driverSymbol">,
  controls: Pick<GainsControls, "driver" | "driverSymbol">,
): boolean {
  const r = resultDriver(result);
  if (r.kind !== controls.driver.kind) return false;
  if (controls.driver.kind === "single-name") return r.symbol === controls.driver.entry.symbol.trim().toUpperCase();
  return r.symbol === controls.driverSymbol;
}

/**
 * The layout for the result on screen. It is the RESULT's layout, never a
 * mix with the controls. When the result does not answer the controls'
 * driver (a switch in flight, or a failure after one), the headline is not
 * shown and the figures are dimmed as "updating" (or blank after a failure,
 * as the page already does).
 */
export function resultLayout(
  result: Pick<GainsAtRiskResult, "driverKind" | "driverSymbol">,
  controls: Pick<GainsControls, "driver" | "driverSymbol">,
  mode: "fresh" | "stale" | "failed",
): { kind: DriverChoice["kind"]; symbol: string; answersDriver: boolean; showHeadline: boolean; dim: boolean } {
  const { kind, symbol } = resultDriver(result);
  const answersDriver = resultAnswersDriver(result, controls);
  return {
    kind,
    symbol,
    answersDriver,
    showHeadline: kind === "single-name" && answersDriver && mode !== "failed",
    dim: mode === "stale" || (!answersDriver && mode !== "failed"),
  };
}

/**
 * The driver the view opens with: the one remembered across a scope change,
 * else the index. A remembered name the list no longer carries goes back to
 * the index with a notice; with trial positions on, or with no list loaded,
 * the server's own list decides (it is built with the trial positions).
 */
export function mountDriver(
  remembered: Pick<GainsControls, "driver" | "driverSymbol"> | null,
  fallbackIndex: GainsAtRiskDriver,
  list: readonly SingleNameDriverEntry[] | null,
  hasTrials: boolean,
): { driver: DriverChoice; driverSymbol: GainsAtRiskDriver; notice: string | null } {
  if (remembered === null) return { driver: { kind: "index" }, driverSymbol: fallbackIndex, notice: null };
  const d = remembered.driver;
  if (d.kind === "single-name" && list !== null && !hasTrials) {
    const still = sameDriverIn(list, d.entry);
    if (!still) return { driver: { kind: "index" }, driverSymbol: remembered.driverSymbol, notice: driverDroppedText(d.entry.symbol) };
    return { driver: { kind: "single-name", entry: still }, driverSymbol: remembered.driverSymbol, notice: null };
  }
  return { driver: d, driverSymbol: remembered.driverSymbol, notice: null };
}

/**
 * A single-name result in which nothing moves with the driver: no book row
 * moves with it (every row held unchanged, not modelled, or a leveraged fund
 * not linked to it) and no trial position does. The figures are then only
 * time decay on options, so the page says so above the table. null otherwise,
 * and always null for an index result.
 */
export function nothingMovesNote(
  result: Pick<GainsAtRiskResult, "driverKind" | "driverSymbol" | "positions"> & {
    trial?: { rows: Pick<GainsAtRiskTrialRow, "refusal" | "cases">[] };
  },
): string | null {
  if (result.driverKind !== "single-name") return null;
  const moves = (beta: number | null | undefined) => beta !== null && beta !== undefined && Number.isFinite(beta) && beta !== 0;
  const bookMoves = result.positions.some((p) => p.unmodelledReason === undefined && moves(p.cases.measured.beta));
  const trialMoves = (result.trial?.rows ?? []).some((r) => r.refusal === undefined && moves(r.cases.measured.beta));
  if (bookMoves || trialMoves) return null;
  return `Nothing in this scope moves with ${result.driverSymbol}. The figures below are what time alone does to the options by that date.`;
}

/** The trial positions' underlying ids, unique and in order: the drivers route's body (P1). */
export function uniqueSortedIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** The leveraged-not-linked disclosure line's words (single-name mode, P3). */
export function leveragedNotLinkedText(symbol: string): string {
  return `Leveraged or inverse funds not linked to ${symbol}, and options on them, held unchanged`;
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
  const betaMax = /^betaOverrides can hold at most (\d+) entries\.$/.exec(message);
  if (betaMax) return `At most ${betaMax[1]} of your figures can be sent at once.`;
  if (message.startsWith("betaOverrides values must each be ")) {
    return `Your figures must each be ${message.slice("betaOverrides values must each be ".length)}`;
  }
  if (message.startsWith("betaOverrides keys")) return "A figure you typed is not tied to a name on this page.";
  if (message.startsWith("betaOverrides must be")) return "Your figures could not be read.";
  const overrides = /^priceOverrides can hold at most (\d+) entries\.$/.exec(message);
  if (overrides) return `At most ${overrides[1]} typed prices can be sent at once.`;
  if (message === "priceOverrides values must be numbers.") return "Typed prices must be numbers.";
  if (message.startsWith("priceOverrides keys")) return "A typed price is not tied to a position on this page.";
  if (message.startsWith("priceOverrides must be")) return "The typed prices could not be read.";
  const trialMax = /^trialPositions can hold at most (\d+) positions\.$/.exec(message);
  if (trialMax) return `At most ${trialMax[1]} trial positions can be sent at once.`;
  if (message.startsWith("trialPositions")) return "A trial position could not be read. Remove it and add it again.";
  if (message === "driver is not one of the names this page can stress.") {
    return "That name is not on the list of names this page can stress. Pick another.";
  }
  if (message.startsWith("driver ") || message.startsWith("driver.")) {
    return "The stock or fund chosen could not be read. Pick it again.";
  }
  if (message === "selectedMove must be one of moves.") return "The selected row is not one of the moves. Pick a row again.";
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

// ─── The two cases ──────────────────────────────────────────────

/** The two cases, in display order; Measured is the default (B6). */
export const CASE_KEYS: readonly GainsAtRiskCaseKey[] = Object.freeze(["measured", "selloff"]);
export const DEFAULT_CASE: GainsAtRiskCaseKey = "measured";
export const CASE_LABELS = { measured: "Measured", selloff: "Selloff case" } as const;

export const MEASURED_NOTE =
  "Each name moves by its measured link to the index. A name with no measured link is held unchanged and listed below.";
/** The selloff case is an assumption on every surface (addendum constraint). */
export const SELLOFF_NOTE =
  "An assumption, not a measurement: every stock and fund falls at least one-for-one with the index.";
export const CASE_NOTES: Record<GainsAtRiskCaseKey, string> = { measured: MEASURED_NOTE, selloff: SELLOFF_NOTE };

/** Under the chart: the gap between the two book lines is the point of the page. */
export const CHART_GAP_NOTE = "The gap between the two lines is how much of the result rests on names falling together.";

/** The legend: both book lines, and the line without offsetting positions for the selected case. */
export function chartLineLabels(selected: GainsAtRiskCaseKey): { measured: string; selloff: string; without: string } {
  return {
    measured: "book, measured",
    selloff: "book, selloff case (an assumption)",
    without: `without the offsetting positions, ${selected === "measured" ? "measured" : "selloff case"}`,
  };
}

/** The 0% row at a later date is not zero: options lose time value by then. */
export const ZERO_ROW_NOTE = "With no move, this is what time alone does to the options by that date.";

export const DOWN_ONLY_NOTE =
  "This page shows a fall in the index. The split into losing and offsetting positions is worked out for a fall.";

export const NOT_MODELLED_LABELS: Record<GainsAtRiskUnmodelled, string> = {
  "leveraged-no-factor": "leveraged or inverse fund with no stored leverage factor",
  "leveraged-no-tracked-index": "leveraged or inverse fund whose tracked index is not known",
  "tracked-index-not-measured": "the fund's tracked index has no measured link to this index",
  "no-option-terms": "option terms (strike, expiry or type) are missing",
  expired: "the option has expired",
  "no-option-price": "the option has no price",
  "no-underlying-price": "the option's underlying has no price",
  "no-volatility": "no volatility source for the option",
  "no-price": "no price",
  "no-fx-rate": "no exchange rate to dollars",
};

export const BETA_SOURCE_LABELS: Record<GainsAtRiskBetaSource, string> = {
  driver: "the index itself",
  fixed: "set by type (cash or bonds)",
  leveraged: "leverage times its tracked index",
  measured: "measured from daily closes",
  owner: "your figure",
  "no-measured-link": "no measured link",
  "not-modelled": "not modelled",
  "held-unchanged": "held unchanged",
  "leveraged-not-linked": "leveraged fund, not linked to the driver",
};

/** Why a name has no measured link (C13), in plain words. */
export const NO_MEASURED_LINK_REASON_LABELS: Record<NoMeasuredLinkReason, string> = {
  "no-daily-bars": "no daily prices yet",
  "short-history": "too few days of daily prices",
  "low-fit": "its link to the index cannot be told apart from zero",
  "foreign-session": "not traded on the US session",
  "driver-bars-missing": "the index's own daily prices are missing",
  "flat-driver": "the index did not move",
};

/** Display order of the reasons on the disclosure line. */
const NO_MEASURED_LINK_REASON_ORDER: NoMeasuredLinkReason[] = [
  "no-daily-bars",
  "short-history",
  "low-fit",
  "foreign-session",
  "driver-bars-missing",
  "flat-driver",
];

/** Added to a row's source when the selloff case raised its beta to one-for-one. */
export const SELLOFF_RAISED_TEXT = "The selloff case uses at least one-for-one.";
/**
 * The same note for a leveraged or inverse fund: the selloff case floors the
 * tracked INDEX's link at one and keeps the fund's factor, so an inverse fund
 * still offsets. "The fund uses at least one-for-one" would be wrong there.
 */
export const LEVERAGED_SELLOFF_TEXT = "Its index is taken at least one-for-one.";

/** A beta to two places. Not a portfolio figure, so plain text. */
export function formatBeta(beta: number | null): string {
  return beta === null || !Number.isFinite(beta) ? "—" : beta.toFixed(2);
}

function isOptionRow(p: Pick<GainsAtRiskPosition, "expiry">): boolean {
  return p.expiry !== undefined;
}

function evidenceText(e: NonNullable<GainsAtRiskPosition["evidence"]>): string {
  return e.lastDate ? `${e.pairs} daily pairs through ${formatPositionsDate(e.lastDate)}` : `${e.pairs} daily pairs`;
}

export interface BetaSourceLine {
  /** Where the selected case's beta comes from. */
  text: string;
  /** Short plain notes under it (evidence, what the case does). */
  details: string[];
}

/**
 * Where a row's beta comes from in the selected case. The not-modelled
 * reason is checked FIRST: such a row may still carry evidence or a
 * no-measured-link reason from its underlying, and none of it is a beta.
 */
export function betaSourceLine(
  p: GainsAtRiskPosition,
  caseKey: GainsAtRiskCaseKey,
  /** Step 3: the single-name driver's symbol; the words then name it, never "the index". */
  singleNameSymbol?: string,
): BetaSourceLine {
  if (p.unmodelledReason !== undefined) {
    return { text: BETA_SOURCE_LABELS["not-modelled"], details: [NOT_MODELLED_LABELS[p.unmodelledReason]] };
  }
  if (singleNameSymbol !== undefined) {
    const option = isOptionRow(p);
    switch (p.betaSource) {
      case "driver":
        return { text: `moves one-for-one with ${singleNameSymbol}`, details: [] };
      case "leveraged":
        return { text: `leverage times ${singleNameSymbol}`, details: [] };
      case "held-unchanged":
        return {
          text: BETA_SOURCE_LABELS["held-unchanged"],
          details: option ? ["The underlying is held unchanged; the option still loses or gains time value."] : [],
        };
      case "leveraged-not-linked":
        return {
          text: `leveraged fund, not linked to ${singleNameSymbol}`,
          details: [option ? "Held unchanged; the option still loses or gains time value." : "Held unchanged."],
        };
      default:
        break;
    }
  }
  const caseBeta = p.cases[caseKey].beta;
  const raised =
    caseKey === "selloff" && p.measuredBeta !== null && caseBeta !== null && Math.abs(caseBeta - p.measuredBeta) > 1e-12;
  switch (p.betaSource) {
    case "owner": {
      if (p.ladderRefusal !== undefined) {
        return { text: `Your figure. The app could not model this fund: ${NOT_MODELLED_LABELS[p.ladderRefusal]}.`, details: [] };
      }
      const details: string[] = [];
      if (p.evidence?.outcome === "measured" && p.measuredBeta !== null) {
        details.push(`Measured ${formatBeta(p.measuredBeta)} from ${evidenceText(p.evidence)}.`);
      } else if (p.noMeasuredLinkReason !== undefined) {
        details.push(`No measured link: ${NO_MEASURED_LINK_REASON_LABELS[p.noMeasuredLinkReason]}.`);
      }
      return { text: BETA_SOURCE_LABELS.owner, details };
    }
    case "measured":
      return {
        text: BETA_SOURCE_LABELS.measured,
        details: [...(p.evidence ? [evidenceText(p.evidence)] : []), ...(raised ? [SELLOFF_RAISED_TEXT] : [])],
      };
    case "leveraged":
      return { text: BETA_SOURCE_LABELS.leveraged, details: raised ? [LEVERAGED_SELLOFF_TEXT] : [] };
    case "no-measured-link": {
      const reason = p.noMeasuredLinkReason;
      const text = reason
        ? `${BETA_SOURCE_LABELS["no-measured-link"]}: ${NO_MEASURED_LINK_REASON_LABELS[reason]}`
        : BETA_SOURCE_LABELS["no-measured-link"];
      const held = caseBeta === 0;
      const detail = held
        ? isOptionRow(p)
          ? "The underlying is held unchanged; the option still loses or gains time value."
          : "Held unchanged."
        : caseBeta === null
          ? null
          : "Taken one-for-one.";
      return { text, details: detail ? [detail] : [] };
    }
    case "driver":
    case "fixed":
    case "not-modelled":
    case "held-unchanged":
    case "leveraged-not-linked":
      return { text: BETA_SOURCE_LABELS[p.betaSource], details: [] };
  }
}

// ─── The owner's figure ─────────────────────────────────────────

/** null for a usable figure (finite, within the bounds); otherwise one plain sentence. Blank is the caller's Clear. */
export function betaOverrideProblem(raw: string): string | null {
  const text = raw.trim();
  const v = Number(text);
  if (text === "" || !Number.isFinite(v)) {
    return "Type how much the name moves per 1% of the index, as a number, for example 0.8.";
  }
  if (v < BETA_OVERRIDE_BOUNDS.min || v > BETA_OVERRIDE_BOUNDS.max) {
    return `Your figure must be between ${BETA_OVERRIDE_BOUNDS.min} and ${BETA_OVERRIDE_BOUNDS.max}.`;
  }
  return null;
}

export const BETA_OVERRIDE_REFUSAL_LABELS: Record<GainsAtRiskBetaOverrideRefusal, string> = {
  "fixed-row": "This is cash or a bond, so its move is set by type and your figure is not used.",
  "is-driver": "This is the index itself, so it moves one-for-one and your figure is not used.",
  "out-of-bounds": `Your figure must be between ${BETA_OVERRIDE_BOUNDS.min} and ${BETA_OVERRIDE_BOUNDS.max}, so it is not used.`,
};

export const SAME_FIGURE_TEXT = "same figure as above";

export const LEVERAGED_FIGURE_HINT = "Type how the fund itself moves per 1% of the index, not its index's link.";

const LEVERAGED_REFUSALS: readonly DriverBetaRefusal[] = [
  "leveraged-no-factor",
  "leveraged-no-tracked-index",
  "tracked-index-not-measured",
];

/** A leveraged or inverse fund (or an option on one): modelled by its rule, or refused by it. */
export function isLeveragedFundRow(
  p: Pick<GainsAtRiskPosition, "betaSource" | "ladderRefusal" | "unmodelledReason">,
): boolean {
  // The not-modelled reason first: a refused leveraged fund says so there.
  if (p.unmodelledReason !== undefined) return (LEVERAGED_REFUSALS as readonly string[]).includes(p.unmodelledReason);
  return p.betaSource === "leveraged" || p.ladderRefusal !== undefined;
}

/**
 * One editor per name (C6): the figure is keyed by `identitySecurityId`, so
 * the first displayed row of each identity owns the box and every other row
 * of it (another account, an option on it) reads "same figure as above". A
 * row with no identity has no box. Returns the owning row keys
 * (`account:security`), given the rows in display order.
 */
export function betaEditorOwners(
  rows: Pick<GainsAtRiskPosition, "accountId" | "securityId" | "identitySecurityId" | "betaSource">[],
): Set<string> {
  const seen = new Set<number>();
  const owners = new Set<string>();
  for (const r of rows) {
    if (r.identitySecurityId === null || seen.has(r.identitySecurityId)) continue;
    // The index itself and a fixed row take no figure: no box (betaEditorNote says why).
    if (r.betaSource === "driver" || r.betaSource === "fixed") continue;
    seen.add(r.identitySecurityId);
    owners.add(`${r.accountId}:${r.securityId}`);
  }
  return owners;
}

/**
 * In place of the figure box on a row that takes no figure: the index itself
 * and a fixed row (cash-like, bond, bond fund). The not-modelled reason is
 * read first: such a row keeps its box.
 */
export function betaEditorNote(p: Pick<GainsAtRiskPosition, "betaSource" | "unmodelledReason">): string | null {
  if (p.unmodelledReason !== undefined) return null;
  if (p.betaSource === "driver") return "moves with the index by definition";
  if (p.betaSource === "fixed") return "held at a fixed link";
  return null;
}

/**
 * Who holds the figure box for each row, in the order given (the table's
 * sorted order): the first row of each name owns it; every later row of that
 * name points back up to it. Keyed by `account:security`; a row that takes no
 * box (no identity, the index itself, a fixed row) has no entry.
 */
export function betaEditorOwnership(
  rows: Pick<GainsAtRiskPosition, "accountId" | "securityId" | "identitySecurityId" | "betaSource" | "symbol">[],
): Map<string, { owner: true } | { owner: false; ownerSymbol: string }> {
  const owners = betaEditorOwners(rows);
  const ownerSymbol = new Map<number, string>();
  const out = new Map<string, { owner: true } | { owner: false; ownerSymbol: string }>();
  for (const r of rows) {
    const key = `${r.accountId}:${r.securityId}`;
    if (r.identitySecurityId === null) continue;
    if (owners.has(key)) {
      ownerSymbol.set(r.identitySecurityId, r.symbol);
      out.set(key, { owner: true });
      continue;
    }
    const sym = ownerSymbol.get(r.identitySecurityId);
    if (sym !== undefined) out.set(key, { owner: false, ownerSymbol: sym });
  }
  return out;
}

/** The pointer on a row whose name's box sits higher up: names that row when it is another symbol. */
export function sameFigureText(ownerSymbol: string, rowSymbol: string): string {
  return ownerSymbol === rowSymbol ? SAME_FIGURE_TEXT : `same figure as ${ownerSymbol}, above`;
}

// ─── Sorting the per-name table ─────────────────────────────────

/**
 * The sortable columns. "loss" is the result at the selected move read as a
 * loss (minus the profit or loss), so its descending order, the default, puts
 * the largest loss first and one click flips it to the largest gain first:
 * the hook's click cycle (new field → desc → asc → default) then reads right.
 */
export type GainsSortKey = "symbol" | "account" | "beta" | "value" | "loss";
const GAINS_SORT_KEYS: readonly GainsSortKey[] = ["symbol", "account", "beta", "value", "loss"];
export const DEFAULT_POSITION_SORT: { field: GainsSortKey; dir: SortDir } = { field: "loss", dir: "desc" };
/** URL params `garNamesSort` / `garNamesDir`: no other Analysis table uses them. */
export const GAINS_SORT_SCOPE = "garNames";

export function isGainsSortKey(v: unknown): v is GainsSortKey {
  return typeof v === "string" && (GAINS_SORT_KEYS as readonly string[]).includes(v);
}

/** The short line under the heading when sorted by the result. */
export function positionSortNote(key: GainsSortKey, dir: SortDir): string | null {
  if (key !== "loss") return null;
  return dir === "desc" ? "Largest loss first." : "Largest gain first.";
}

/**
 * The fields the sort reads. A book row has them all; a trial row (adapted by
 * `nameTableRows`) carries `trialRefusal` / `trialId` too.
 */
export type SortableNameRow = Pick<GainsAtRiskPosition, "symbol" | "accountName" | "securityId" | "valueUsd" | "cases"> &
  Partial<Pick<GainsAtRiskPosition, "unmodelledReason">> & { trialRefusal?: TrialRefusal; trialId?: string };

function sortValue(
  p: SortableNameRow,
  key: GainsSortKey,
  caseKey: GainsAtRiskCaseKey,
  moveIndex: number,
): number | string | null {
  // A not-modelled or refused row carries zeros, not a figure: no beta and no result.
  const noFigure = p.unmodelledReason !== undefined || p.trialRefusal !== undefined;
  switch (key) {
    case "symbol":
      return p.symbol;
    case "account":
      return p.accountName;
    case "value":
      return p.valueUsd !== null && Number.isFinite(p.valueUsd) ? p.valueUsd : null;
    case "beta": {
      if (noFigure) return null;
      const b = p.cases[caseKey].beta;
      return b !== null && Number.isFinite(b) ? b : null;
    }
    case "loss": {
      if (noFigure || moveIndex < 0) return null;
      const v = p.cases[caseKey].pnlByMove[moveIndex];
      return v !== undefined && Number.isFinite(v) ? -v : null;
    }
  }
}

/**
 * The per-name table's order: by one column of the SELECTED case at the
 * SELECTED move (index into the case's moves; -1 for none). Rows with no
 * figure sort last in both directions. Stable: ties go to symbol, then
 * account, then security id, then trial id. Returns a new array; the input is
 * unchanged. Generic, so trial rows sort with the book.
 */
export function sortPositions<T extends SortableNameRow>(
  rows: T[],
  key: GainsSortKey,
  direction: SortDir,
  caseKey: GainsAtRiskCaseKey,
  moveIndex: number,
): T[] {
  const sign = direction === "asc" ? 1 : -1;
  const cmp = (a: number | string, b: number | string): number =>
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return rows
    .map((p) => ({ p, v: sortValue(p, key, caseKey, moveIndex) }))
    .sort((x, y) => {
      if (x.v === null && y.v !== null) return 1;
      if (y.v === null && x.v !== null) return -1;
      const primary = x.v !== null && y.v !== null ? sign * cmp(x.v, y.v) : 0;
      return (
        primary ||
        x.p.symbol.localeCompare(y.p.symbol) ||
        x.p.accountName.localeCompare(y.p.accountName) ||
        x.p.securityId - y.p.securityId ||
        (x.p.trialId ?? "").localeCompare(y.p.trialId ?? "")
      );
    })
    .map((x) => x.p);
}

// ─── Trial positions in the per-name table ──────────────────────

/** The account cell of a trial row. */
export const TRIAL_ACCOUNT_NAME = "trial";

/** A row of the per-name table: a book row, or a trial row adapted to the same fields. */
export type NameTableRow = GainsAtRiskPosition & {
  trialId?: string;
  trialRefusal?: TrialRefusal;
  /** The engine's own trial row, for the notes the page prints beside it. */
  trialRow?: GainsAtRiskTrialRow;
};

/**
 * The book rows, then each trial row marked "trial" (R6: trial rows are
 * listed apart from the book's own figures). `labels` gives a trial option its
 * contract label and expiry; the price box never opens on a trial row (its
 * price is fixed at the click: `priceSource` null). A refused trial keeps its
 * identity only when the owner's figure could still price it ("not-modelled").
 */
export function nameTableRows(
  result: { positions: GainsAtRiskPosition[]; trial?: { rows: GainsAtRiskTrialRow[] } },
  labels?: ReadonlyMap<string, { symbol: string; expiry?: string }>,
): NameTableRow[] {
  if (!result.trial || result.trial.rows.length === 0) return result.positions;
  const trialRows: NameTableRow[] = result.trial.rows.map((r) => {
    const label = labels?.get(r.id);
    const keepsIdentity = r.refusal === undefined || r.refusal === "not-modelled";
    return {
      accountId: 0,
      accountName: TRIAL_ACCOUNT_NAME,
      securityId: r.identitySecurityId,
      symbol: label?.symbol ?? r.symbol,
      name: r.name,
      identitySecurityId: keepsIdentity ? r.identitySecurityId : null,
      betaSource: r.betaSource,
      measuredBeta: r.measuredBeta,
      ...(r.evidence ? { evidence: r.evidence } : {}),
      ...(r.noMeasuredLinkReason ? { noMeasuredLinkReason: r.noMeasuredLinkReason } : {}),
      ...(r.ladderRefusal ? { ladderRefusal: r.ladderRefusal } : {}),
      priceSource: null,
      ...(r.expiresBeforeDate ? { expiresBeforeDate: true as const } : {}),
      ...(r.kind === "option" && label?.expiry ? { expiry: label.expiry } : {}),
      valueUsd: r.valueUsd,
      cases: r.cases,
      trialId: r.id,
      ...(r.refusal ? { trialRefusal: r.refusal } : {}),
      trialRow: r,
    };
  });
  return [...result.positions, ...trialRows];
}

/** A row's key in the per-name table: `account:security` for the book, `trial:id` for a trial. */
export function nameRowKey(r: Pick<NameTableRow, "accountId" | "securityId" | "trialId">): string {
  return r.trialId !== undefined ? `trial:${r.trialId}` : `${r.accountId}:${r.securityId}`;
}

export type NameEditorOwnership = { owner: true } | { owner: false; ownerSymbol: string; where: "above" | "below" };

/**
 * Who holds the figure box per row of the per-name table, given the rows in
 * display order. A book row of a name always holds it (the first in display
 * order, step 1's rule); a trial row holds it only for a name no book row has.
 * Every other row of the name points to the holder, above or below it.
 */
export function nameTableEditorOwnership(
  rows: Pick<NameTableRow, "accountId" | "securityId" | "identitySecurityId" | "betaSource" | "symbol" | "trialId">[],
): Map<string, NameEditorOwnership> {
  const takesBox = (r: (typeof rows)[number]) =>
    r.identitySecurityId !== null && r.betaSource !== "driver" && r.betaSource !== "fixed";
  const holder = new Map<number, number>(); // identity → index in rows
  rows.forEach((r, i) => {
    if (!takesBox(r) || r.trialId !== undefined) return;
    if (!holder.has(r.identitySecurityId as number)) holder.set(r.identitySecurityId as number, i);
  });
  rows.forEach((r, i) => {
    if (!takesBox(r) || r.trialId === undefined) return;
    if (!holder.has(r.identitySecurityId as number)) holder.set(r.identitySecurityId as number, i);
  });
  const out = new Map<string, NameEditorOwnership>();
  rows.forEach((r, i) => {
    if (r.identitySecurityId === null) return;
    const h = holder.get(r.identitySecurityId);
    if (h === undefined) return;
    const key = nameRowKey(r);
    if (h === i) out.set(key, { owner: true });
    else out.set(key, { owner: false, ownerSymbol: rows[h].symbol, where: h < i ? "above" : "below" });
  });
  return out;
}

/** The pointer to the row that holds the box, above or below. */
export function sameFigureTextAt(ownerSymbol: string, rowSymbol: string, where: "above" | "below"): string {
  return ownerSymbol === rowSymbol ? `same figure as ${where}` : `same figure as ${ownerSymbol}, ${where}`;
}

/**
 * One line when the engine used none of some typed figures; null when it used
 * them all. The count comes back apart so the page prints it through <Count>.
 */
export function overridesIgnoredLine(count: number): { count: number; text: string } | null {
  if (!(count > 0)) return null;
  return {
    count,
    text:
      count === 1
        ? "figure you typed was not used: no name on this page takes it."
        : "figures you typed were not used: no name on this page takes them.",
  };
}

// ─── The evidence caption ───────────────────────────────────────

/**
 * Which closes the betas come from and through what date (C13). The count
 * of names waiting is a portfolio count, so it comes back apart from the
 * text and the page prints it through <Count>.
 */
export function betaEvidenceCaption(
  // `namesNotCaptured` is read defensively: an older answer without it reads as zero.
  e: Omit<GainsAtRiskResult["betaEvidence"], "namesNotCaptured"> & { namesNotCaptured?: number },
  driver: string,
): {
  text: string;
  waiting: { count: number; text: string } | null;
  notCaptured: { count: number; text: string } | null;
} {
  const m = typeof e.namesNotCaptured === "number" && Number.isFinite(e.namesNotCaptured) ? e.namesNotCaptured : 0;
  const notCaptured =
    m > 0
      ? {
          count: m,
          text:
            m === 1
              ? "name has no daily prices from the broker (a fund, or no contract on file). Type your own figure for it."
              : "names have no daily prices from the broker (funds, or no contract on file). Type your own figure for them.",
        }
      : null;
  if (e.driverBarsMissing) {
    return {
      text: `Daily prices for ${driver} are not on file yet, so no name has a measured link. The selloff case still applies.`,
      waiting: null,
      notCaptured,
    };
  }
  const text = e.driverBarsThrough
    ? `Betas are measured from daily closing prices through ${formatPositionsDate(e.driverBarsThrough)}.`
    : "Betas are measured from daily closing prices.";
  const n = e.namesWaitingForBars;
  return {
    text,
    waiting:
      n > 0 ? { count: n, text: n === 1 ? "name is waiting for daily prices." : "names are waiting for daily prices." } : null,
    notCaptured,
  };
}

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

type CaseDisclosures = GainsAtRiskCase["disclosures"];
type DisclosureKey = Exclude<keyof CaseDisclosures, "leveragedNotLinked">;

const DISCLOSURE_TEXT: Record<DisclosureKey, string> = {
  notModelled: "Not modelled",
  noMeasuredLink: "No measured link",
  ownerFigure: "At your figure",
  pricedFromModel: "Options priced from model",
  expiresBeforeDate: "Options that expire before the date",
};

const DISCLOSURE_ORDER: DisclosureKey[] = [
  "notModelled",
  "noMeasuredLink",
  "ownerFigure",
  "pricedFromModel",
  "expiresBeforeDate",
];

/** The selected case's disclosure lines, in a fixed order; "At your figure" only when the owner typed some. */
export function disclosureSentences(
  d: CaseDisclosures,
): { key: DisclosureKey; text: string; count: number; shareOfBook: number | null; unknownValueCount: number; symbols: string[] }[] {
  return DISCLOSURE_ORDER.filter((key) => key !== "ownerFigure" || d.ownerFigure.count > 0).map((key) => ({
    key,
    text: DISCLOSURE_TEXT[key],
    count: d[key].count,
    shareOfBook: d[key].shareOfBook,
    unknownValueCount: d[key].unknownValueCount,
    symbols: d[key].symbols,
  }));
}

/**
 * The extra words on the "No measured link" line: what the case does with
 * those names, then each reason that applies with its count (the page prints
 * the count through <Count>).
 */
export function noMeasuredLinkSentence(
  d: CaseDisclosures["noMeasuredLink"],
  caseKey: GainsAtRiskCaseKey,
): { treatment: string; reasons: { key: NoMeasuredLinkReason; text: string; count: number }[] } {
  return {
    treatment:
      caseKey === "measured"
        ? "held unchanged (options on them still lose or gain time value)"
        : "stocks and funds taken one-for-one",
    reasons: NO_MEASURED_LINK_REASON_ORDER.filter((k) => (d.reasons[k] ?? 0) > 0).map((k) => ({
      key: k,
      text: NO_MEASURED_LINK_REASON_LABELS[k],
      count: d.reasons[k],
    })),
  };
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
  /** The book in the measured case. */
  measured: number;
  /** The book in the selloff case. */
  selloff: number;
  /** The selected case's book without its offsetting positions. */
  without: number;
}

/**
 * The chart's points: only the default sweep's moves, in move order, so the
 * table's custom row never adds an extra point (on a numeric axis the
 * spacing is then true to the move). Both book lines, and the selected
 * case's book without its offsetting positions: that case's `losersPnlUsd`.
 * A move missing from either case is left out rather than drawn as zero.
 */
export function chartRows(
  cases: Record<GainsAtRiskCaseKey, Pick<GainsAtRiskCase, "moves">>,
  selected: GainsAtRiskCaseKey,
): GainsChartRow[] {
  const sweep = defaultSweep();
  const at = (k: GainsAtRiskCaseKey, move: number) => cases[k].moves.find((r) => sameMove(r.move, move));
  const out: GainsChartRow[] = [];
  for (const move of sweep) {
    const m = at("measured", move);
    const s = at("selloff", move);
    const sel = selected === "measured" ? m : s;
    if (!m || !s || !sel) continue;
    out.push({ move: m.move, measured: m.bookPnlUsd, selloff: s.bookPnlUsd, without: sel.losersPnlUsd });
  }
  return out;
}

/** The dollar axis: every plotted value and zero, padded 5%. */
export function chartDollarDomain(rows: GainsChartRow[]): [number, number] {
  const values = rows.flatMap((r) => [r.measured, r.selloff, r.without, 0]);
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
  rows: (Pick<GainsAtRiskPosition, "accountId" | "securityId" | "priceSource"> &
    Partial<Pick<GainsAtRiskPosition, "unmodelledReason" | "expiry">>)[],
): Set<string> {
  const seen = new Set<number>();
  const owners = new Set<string>();
  for (const r of rows) {
    if (!isPriceEditable(r)) continue;
    if (seen.has(r.securityId)) continue;
    seen.add(r.securityId);
    owners.add(`${r.accountId}:${r.securityId}`);
  }
  return owners;
}

/**
 * Whether a row takes the owner's price: a model-priced or owner-priced
 * option, or an UNPRICED option left out only for want of a volatility (the
 * engine solves the volatility from a typed price and then models it).
 */
export function isPriceEditable(
  p: Pick<GainsAtRiskPosition, "priceSource"> & Partial<Pick<GainsAtRiskPosition, "unmodelledReason" | "expiry">>,
): boolean {
  if (p.priceSource === "model" || p.priceSource === "override") return true;
  return p.priceSource === null && p.expiry !== undefined && p.unmodelledReason === "no-volatility";
}

export const NO_VOLATILITY_PRICE_TEXT = "No volatility on file. Type its price to include it.";

export const SAME_PRICE_TEXT = "same price as above";

/**
 * A dollar cell's value: null after a failure or when there is none;
 * otherwise the figure, with anything under half a cent read as zero so a
 * signed <Money> never prints a negative zero.
 */
export function moneyCell(v: number | null | undefined, failed: boolean): number | null {
  if (failed || v === undefined || v === null || !Number.isFinite(v)) return null;
  return Math.abs(v) < 0.005 ? 0 : v;
}

// ─── Failures ───────────────────────────────────────────────────

export const COMPUTE_FAILED_TEXT = "Could not compute gains at risk.";

/** A server error reads once; a refused input names the control. */
export function requestFailureText(status: number, message: string): string {
  if (status >= 500 || message.trim() === COMPUTE_FAILED_TEXT) return COMPUTE_FAILED_TEXT;
  return `${COMPUTE_FAILED_TEXT} ${domainProblemText(message)}`;
}

// ─── Controls ───────────────────────────────────────────────────

export interface GainsControls {
  /** The index pick: always sent as `driverSymbol`, and kept while a single name is tried. */
  driverSymbol: GainsAtRiskDriver;
  /** Step 3: what the sweep moves (an index, or one stock or fund). */
  driver: DriverChoice;
  valuationDate: string;
  volChangePoints: number;
  /** The committed custom move (a decimal), or none. */
  custom: number | null;
  /** Owner-typed option prices per share, by security id. Page state only. */
  priceOverrides: Record<number, number>;
  /** The owner's own figure per name, by `identitySecurityId` (C6). Page state only. */
  betaOverrides: Record<number, number>;
}

/**
 * THE request body for the controls on screen: the one builder the view's
 * run() and the candidate table both call (one copy of the rules). The sweep
 * and the custom row by driver kind; the date inside today..latestDate; the
 * owner's figures left out in single-name mode (P2); the driver fields (index
 * mode sends exactly the step 2 body, P8); the selected move only in
 * single-name mode and only when it is one of the moves (D5); each trial
 * position exactly as its entry fixed it. Empty maps and lists are left out
 * (the route refuses an explicit null).
 */
export function gainsAtRiskRequestBody(args: {
  scope: GainsAtRiskBody["scope"];
  controls: GainsControls;
  selectedMove: number;
  trialPositions: readonly TrialPositionInput[];
  today: string;
  latestDate: string;
}): { ok: true; body: GainsAtRiskBody } | { ok: false; message: string } {
  const { controls: c, today, latestDate } = args;
  if (!(c.valuationDate >= today && c.valuationDate <= latestDate)) {
    return { ok: false, message: `Pick a date from ${today} to ${latestDate}.` };
  }
  const kind = c.driver.kind;
  const moves = requestMoves(sweepFor(kind), c.custom, tableMovesFor(kind));
  const figures = betaOverridesToSend(kind, c.betaOverrides);
  const selectedInMoves = moves.find((m) => sameMove(m, args.selectedMove));
  return {
    ok: true,
    body: {
      scope: args.scope,
      driverSymbol: c.driverSymbol,
      valuationDate: c.valuationDate,
      moves,
      volChangePoints: c.volChangePoints,
      ...(Object.keys(c.priceOverrides).length > 0 ? { priceOverrides: c.priceOverrides } : {}),
      ...(Object.keys(figures).length > 0 ? { betaOverrides: figures } : {}),
      ...driverRequestFields(c.driver),
      ...(kind === "single-name" && selectedInMoves !== undefined ? { selectedMove: selectedInMoves } : {}),
      ...(args.trialPositions.length > 0 ? { trialPositions: [...args.trialPositions] } : {}),
    },
  };
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
    controls.driver.kind === "index" &&
    controls.driverSymbol === server.driverSymbol &&
    controls.valuationDate === server.valuationDate &&
    controls.volChangePoints === server.volChangePoints &&
    controls.custom === null &&
    Object.keys(controls.priceOverrides).length === 0 &&
    Object.keys(controls.betaOverrides).length === 0
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
  /** The trial-position set the latest request carried (the provider's version). */
  trialVersion: number;
};

export type GainsRequestAction =
  | { type: "start"; seq: number; trialVersion?: number }
  | { type: "success"; seq: number; data: GainsAtRiskResponse; trialVersion?: number }
  | { type: "failure"; seq: number; message: string }
  | { type: "reset"; data: GainsAtRiskResponse; hasTrials?: boolean };

/**
 * P7: a view that mounts with trial positions starts pending (the server's
 * trial-free first paint is kept for layout only) and asks at once.
 */
export function initialGainsRequestState(
  data: GainsAtRiskResponse,
  opts: { hasTrials?: boolean; trialVersion?: number } = {},
): GainsRequestState {
  const trialVersion = opts.trialVersion ?? 0;
  if (opts.hasTrials) return { latestSeq: 0, result: null, previous: data, error: null, loading: true, trialVersion };
  return { latestSeq: 0, result: data, previous: data, error: null, loading: false, trialVersion };
}

/**
 * What the view does with fresh server props: take them ("reset") only when
 * they answer the controls on screen and no trial position exists (the
 * server never computes trial positions); otherwise ask again ("ask").
 */
export function serverPropsAction(
  controls: GainsControls,
  server: { driverSymbol: GainsAtRiskDriver; valuationDate: string; volChangePoints: number },
  hasTrials: boolean,
): "reset" | "ask" {
  return !hasTrials && serverPropsAnswerControls(controls, server) ? "reset" : "ask";
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
        trialVersion: action.trialVersion ?? state.trialVersion,
      };
    case "success":
      if (action.seq !== state.latestSeq) return state;
      // A reply for an older set of trial positions is never shown.
      if (action.trialVersion !== undefined && action.trialVersion !== state.trialVersion) return state;
      return { ...state, result: action.data, previous: action.data, error: null, loading: false };
    case "failure":
      if (action.seq !== state.latestSeq) return state;
      return { ...state, result: null, error: action.message, loading: false };
    case "reset":
      // Server props carry no trial positions: never the answer while some exist.
      if (action.hasTrials) return state;
      // Server props that answer the controls on screen; anything in flight is now older.
      return {
        latestSeq: state.latestSeq + 1,
        result: action.data,
        previous: action.data,
        error: null,
        loading: false,
        trialVersion: state.trialVersion,
      };
  }
}

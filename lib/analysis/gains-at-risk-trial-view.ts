/**
 * Gains at risk, trial positions: the page's plain rules and words.
 *
 * A plain module (no React, no database or broker code at run time), shared
 * by the client form, list, view and chart. Everything that prices, solves or
 * reads holdings happens on the server through the routes; this module only
 * shapes what the routes return into sentences, and keeps the form's request
 * state (P6) and the list's state (R5) as pure reducers.
 *
 * Client boundary (C12): value imports are limited to the import-free
 * constants module, the view helpers and the date label. Engine, broker and
 * calendar types come in as `import type` only.
 *
 * Privacy: contracts, quantities, costs, cash and holdings are the owner's.
 * A helper that would put one inside a sentence returns it apart, so the page
 * prints it through <Count> / <Money>. Quote prices, strikes, expiries and the
 * index's move are market data and are written plainly.
 */

import { TRIAL_POSITION_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import {
  NOT_MODELLED_LABELS,
  NO_MEASURED_LINK_REASON_LABELS,
  TABLE_MOVES,
  defaultSweep,
  gainGivenBackShare,
  sameMove,
} from "@/lib/analysis/gains-at-risk-view";
import { formatPositionsDate } from "@/lib/ui/positions-freshness-label";
// Types only: erased at build.
import type { TrialEntryResponse, TrialLookup } from "@/lib/analysis/gains-at-risk-input";
import type {
  GainsAtRiskCaseKey,
  GainsAtRiskMoveRow,
  GainsAtRiskTrialCase,
  GainsAtRiskTrialResult,
  GainsAtRiskTrialRow,
  TrialPositionInput,
} from "@/lib/compute/gains-at-risk";
import type { TrialEntryRequest } from "@/lib/compute/gains-at-risk-trial";
import type { QuoteTickKind } from "@/lib/tws/option-quote";
import type { QuoteSessionLabel } from "@/lib/calendar/market-session";
import type { YearGainResult } from "@/lib/compute/year-gain";

const B = TRIAL_POSITION_BOUNDS;

// ─── Fixed words ────────────────────────────────────────────────

export const TRIAL_NOT_STORED_NOTE = "Not stored. Nothing is traded from this page.";
export const TRIAL_CHART_NOTE = "With trial positions on, the line without the offsetting positions is hidden.";
export const TRIAL_MULTIPLIER_NOTE = "Options with 100 shares per contract only.";
export const TRIAL_EXPIRED_NOTE = "This contract has expired. Remove it.";
/** The mark is relative to the app's own price series (controller ruling): said once on the page. */
export const TRIAL_ZERO_START_NOTE =
  "An option trial starts at zero and then moves with the app's own price for that name, which updates with each sync. Shares are marked from the price you typed.";
/** Under the strike select: the chain route merges strikes across expiries. */
export const TRIAL_STRIKES_NOTE = "Strikes are listed across all expiries; not every strike trades on every expiry.";
/** A scope with no positions but with trial positions. */
export const TRIAL_EMPTY_BOOK_NOTE =
  "No positions are held in this scope, so the book as it is stays at zero; the lines show the trial positions alone.";
export const TRIAL_CONNECT_FOR_QUOTES = "Connect the broker to fetch quotes.";
export const TRIAL_SECTION_TITLE = "Trial positions";
export const TRIAL_TRY_BUTTON = "Try a position";
export const TRIAL_LIMIT_TEXT = `At most ${B.maxPositions} trial positions. Remove one first.`;

/** The moves table's columns while trial positions are on. */
export const TRIAL_TABLE_LABELS = {
  asIs: "Book as it is",
  withTrial: "With trial positions",
  difference: "Difference",
  givenBack: "Gain given back, before and after",
} as const;
/** Between the two given-back values. */
export const TRIAL_GIVEN_BACK_ARROW = "→";

/** The chart legend while trial positions are on: the selected case only. */
export function trialChartLineLabels(selected: GainsAtRiskCaseKey): { asIs: string; withTrial: string } {
  const c = selected === "measured" ? "measured" : "selloff case (an assumption)";
  return { asIs: `book as it is, ${c}`, withTrial: `book with your trial positions, ${c}` };
}

// ─── The state the page keeps for one trial position ────────────

/** The quote at the click, as the quote route answered it. Market data. */
export interface TrialQuote {
  tickKind: QuoteTickKind;
  /** From the route's session label; the page never works out market hours itself. */
  session: QuoteSessionLabel;
  bid: number;
  ask: number;
  mid: number;
  underlyingLast: number | null;
  /** The instant of the click, never presented as the quote's own time. */
  fetchedAt: string;
}

export interface TrialPositionState {
  /** What the engine receives, fixed at the click by the entry route; sent back untouched. */
  position: TrialPositionInput;
  symbol: string;
  name: string | null;
  /** R4/P3: every account's holding of the exact security or contract at the click; kept through a resize (P1). */
  holdingsAtAddByAccount: Record<number, number>;
  priceSource: "typed" | "quote-mid";
  quote?: TrialQuote;
  /** R2: set by the entry when the price used is more than one trading day old and no quote was used. */
  staleCloseDate: string | null;
  /** The underlying's price at the click, and where it came from (the route's top-level field). */
  underlyingPrice: number;
  underlyingPriceDate: string;
  underlyingPriceSource: "client-quote" | "book" | "daily-bar" | "stored-price";
  /** The app's own price for the name at the click. */
  appValuation: { price: number; date: string; source: "book" | "daily-bar" | "stored-price" } | null;
}

/** What the engine receives: each position as it was fixed, untouched. */
export function trialRequestPositions(list: readonly TrialPositionState[]): TrialPositionInput[] {
  return list.map((t) => t.position);
}

// ─── Plain market-data formatting ───────────────────────────────

/** A per-share price (market data): two places, up to four when the mid needs them. */
export function formatMarketPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const two = v.toFixed(2);
  if (Math.abs(Number(two) - v) < 1e-9) return two;
  return String(Number(v.toFixed(4)));
}

/** A strike as listed: 500, 2.5. Market data. */
export function formatStrike(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toFixed(4))) : "—";
}

/** A fall as a plain percent of the index: -0.014 → "1.4%". */
function fallPct(move: number): string {
  return `${Number((Math.abs(move) * 100).toFixed(1))}%`;
}

/** 1000000 → "1,000,000" (a bound, not a portfolio figure). */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const FETCHED_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "2026-11-24T19:32:00Z" → "14:32" on the Eastern clock. */
function fetchedTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : FETCHED_TIME.format(d);
}

// ─── Labels and notes on a list row ─────────────────────────────

function optionContractText(p: Extract<TrialPositionInput, { kind: "option" }>, symbol: string): string {
  return `${symbol} ${p.expiry} ${formatStrike(p.strike)} ${p.right}`;
}

/**
 * The row's label, with the count apart so the page prints it masked:
 * "Buy" <10> "ZZQ 2027-03-20 500 put"; "Sell" <200> <shares> "of ZZA".
 */
export function trialPositionLabel(t: TrialPositionState): {
  verb: string;
  count: number;
  unit: "shares" | null;
  text: string;
} {
  const p = t.position;
  if (p.kind === "option") {
    return { verb: p.side === "buy" ? "Buy" : "Write", count: p.contracts, unit: null, text: optionContractText(p, t.symbol) };
  }
  return { verb: p.side === "buy" ? "Buy" : "Sell", count: p.quantity, unit: "shares", text: `of ${t.symbol}` };
}

/** The contract or the name, for sentences and the per-name table. */
export function trialName(t: TrialPositionState): string {
  return t.position.kind === "option" ? optionContractText(t.position, t.symbol) : t.symbol;
}

/** The per-share price the position was entered at (market data, plain). */
export function trialEntryPrice(t: TrialPositionState): number {
  return t.position.kind === "option" ? t.position.pricePaid : t.position.price;
}

/** R7: what the position costs or raises. null for a refused row: a refused row never shows a cost. */
export function trialCostLine(row: GainsAtRiskTrialRow): { verb: string; usd: number; note: string | null } | null {
  if (row.refusal !== undefined || row.cost === null) return null;
  switch (row.cost.kind) {
    case "premium-paid":
      return { verb: "costs", usd: row.cost.usd, note: null };
    case "premium-received":
      return { verb: "premium received", usd: row.cost.usd, note: "(an obligation, not a gain)" };
    case "cash-used":
      return { verb: "uses", usd: row.cost.usd, note: "of cash" };
    case "cash-raised":
      return { verb: "raises", usd: row.cost.usd, note: null };
  }
}

/** R7: the premium paid on a bought option as a share of the year's gain, by step 1's ratio rule; else null. */
export function trialCostShareOfGain(row: GainsAtRiskTrialRow, yearGain: YearGainResult): number | null {
  if (row.refusal !== undefined || row.cost === null || row.cost.kind !== "premium-paid") return null;
  return gainGivenBackShare(-row.cost.usd, yearGain);
}

/**
 * The share cell for premium paid, by step 1's rule: a share that would print
 * 0.0% reads "under 0.1%". null when no share is shown.
 */
export function trialCostShareCell(
  row: GainsAtRiskTrialRow,
  yearGain: YearGainResult,
): { kind: "pct"; percent: number } | { kind: "under-tenth" } | null {
  const share = trialCostShareOfGain(row, yearGain);
  if (share === null || !Number.isFinite(share)) return null;
  const percent = share * 100;
  if (percent > 0 && percent < 0.05) return { kind: "under-tenth" };
  return { kind: "pct", percent: Number(percent.toFixed(10)) };
}

/** The net cash line: positive raises, negative uses. */
export function netCashLine(netCashUsd: number): { verb: "raises" | "uses" | "none"; usd: number } {
  if (!Number.isFinite(netCashUsd) || Math.abs(netCashUsd) < 0.005) return { verb: "none", usd: 0 };
  return netCashUsd > 0 ? { verb: "raises", usd: netCashUsd } : { verb: "uses", usd: -netCashUsd };
}

/** P3: any account's figure differs from the click's (an account left out counts as zero). */
export function holdingsChanged(atAdd: Record<number, number>, now: Record<number, number>): boolean {
  const keys = new Set([...Object.keys(atAdd), ...Object.keys(now)]);
  for (const k of keys) {
    const a = atAdd[Number(k)] ?? 0;
    const b = now[Number(k)] ?? 0;
    if (a !== b) return true;
  }
  return false;
}

/** R4: the flag when the real trade may have arrived. Never removes anything. */
export function holdingsChangedNote(t: TrialPositionState, row: GainsAtRiskTrialRow): string | null {
  if (!holdingsChanged(t.holdingsAtAddByAccount, row.holdingsNowByAccount)) return null;
  return `Your holdings of ${trialName(t)} changed since you added this. Remove it if this trade is now in your book.`;
}

/** P4: the part of a sale the holdings cannot cover; the count comes back apart. */
export function leavesShortNote(row: GainsAtRiskTrialRow): { before: string; count: number; after: string } | null {
  if (row.leavesShortBy === null || !(row.leavesShortBy > 0)) return null;
  return {
    before: "This sale leaves you short",
    count: row.leavesShortBy,
    after: `${row.symbol}, counted across every account.`,
  };
}

/** P4/R5: one line per name the trial positions leave short. Counts come back apart. */
export function shortByNameLines(trial: Pick<GainsAtRiskTrialResult, "shortByName">): {
  securityId: number;
  symbol: string;
  shortBy: number;
  heldShortBefore: number;
  before: string;
  after: string;
  alreadyShort: { before: string; count: number; after: string } | null;
}[] {
  return trial.shortByName
    .filter((s) => s.shortBy > 0)
    .map((s) => ({
      securityId: s.securityId,
      symbol: s.symbol,
      shortBy: s.shortBy,
      heldShortBefore: s.heldShortBefore,
      before: "Your trial positions leave you short",
      after: `${s.symbol}, counted across every account.`,
      alreadyShort:
        s.heldShortBefore > 0 ? { before: "You were already short", count: s.heldShortBefore, after: "before them." } : null,
    }));
}

/**
 * Where the per-name table is, for a sentence that points to the owner's
 * figure box: below (the list), on this row (the table itself), or not on
 * screen (no pointer at all).
 */
export type FigureBoxPointer = { tableBelow?: true | false | "this-row" };

/** A trial option with no measured link (anti-goal: protection shown that is not real). */
export function noLinkWarningNote(row: GainsAtRiskTrialRow, at: FigureBoxPointer = {}): string | null {
  if (!row.noLinkWarning) return null;
  const where = at.tableBelow ?? true;
  const reason = row.noMeasuredLinkReason ? ` (${NO_MEASURED_LINK_REASON_LABELS[row.noMeasuredLinkReason]})` : "";
  const pointer =
    where === true
      ? `See the selloff case, or type your own figure for ${row.symbol} in the table below.`
      : where === "this-row"
        ? `See the selloff case, or type your own figure for ${row.symbol} in Your figure.`
        : "See the selloff case.";
  return (
    `${row.symbol} has no measured link to the index${reason}. In the measured case it is held unchanged, ` +
    "so this option shows only what time and the volatility change do to it there, and its move with the index is not counted. " +
    pointer
  );
}

/** Plain words for every refusal; a refused row adds nothing and shows no cost. */
export function trialRefusalNote(row: GainsAtRiskTrialRow, at: FigureBoxPointer = {}): string | null {
  const name = row.symbol || "This security";
  const where = at.tableBelow ?? true;
  switch (row.refusal) {
    case undefined:
      return null;
    case "expired":
      return TRIAL_EXPIRED_NOTE;
    case "not-modelled": {
      const first = row.ladderRefusal
        ? `The app cannot model this fund: ${NOT_MODELLED_LABELS[row.ladderRefusal]}.`
        : "The app cannot model this fund.";
      if (where === false) return first;
      return `${first} Type your own figure for it ${where === "this-row" ? "in Your figure" : "in the table below"}.`;
    }
    case "unknown-security":
      return "The app no longer knows this security, so it adds nothing. Remove it.";
    case "is-an-option":
      return `${name} is now listed as an option, so it adds nothing. Remove it.`;
    case "foreign-currency":
      return `${name} is not priced in US dollars, so it adds nothing. Remove it.`;
    case "no-fx-rate":
      return `${name} has no exchange rate to dollars, so it adds nothing.`;
    case "no-underlying-price":
      return `${name} is not a security the app holds a price for. It adds nothing.`;
    case "no-option-terms":
      return "The contract's terms cannot be priced, so it adds nothing. Remove it.";
  }
}

/**
 * R8: a quote's sides, its kind and the time of the click. Outside the
 * regular session (the route's label) it says the market is closed, whatever
 * ticks arrived.
 */
export function quoteText(q: TrialQuote): string {
  const kind = q.session === "market-closed" ? "market closed: the last quote" : q.tickKind;
  const at = fetchedTime(q.fetchedAt);
  return `mid of ${formatMarketPrice(q.bid)} / ${formatMarketPrice(q.ask)}, ${kind}${at ? `, fetched ${at}` : ""}`;
}

/** The list row's quote label; null for a typed price. */
export function quoteLabel(t: TrialPositionState): string | null {
  if (t.priceSource !== "quote-mid" || !t.quote) return null;
  return quoteText(t.quote);
}

/** When a quote's underlying price was used: both it and the app's own last stored price. */
export function underlyingPriceNote(t: TrialPositionState): string | null {
  if (t.underlyingPriceSource !== "client-quote") return null;
  const stored = t.appValuation
    ? `last stored ${formatMarketPrice(t.appValuation.price)}, ${formatPositionsDate(t.appValuation.date)}`
    : "no stored price";
  return `Underlying quoted ${formatMarketPrice(t.underlyingPrice)}; ${stored}.`;
}

/** R2: only when no quote was used and the price is more than one trading day old (the entry decides). */
export function staleCloseNote(t: TrialPositionState): string | null {
  if (t.underlyingPriceSource === "client-quote" || !t.staleCloseDate) return null;
  return `Priced against the ${formatPositionsDate(t.staleCloseDate)} close.`;
}

// ─── The two sentences under the table ──────────────────────────

/** What the trial positions cost by the date with no move; the amount comes back apart. */
export function noMoveCostSentence(c: Pick<GainsAtRiskTrialCase, "noMoveCostUsd">): {
  before: string;
  /** null when there is no amount to print (the sentence is whole). */
  usd: number | null;
  after: string;
} | null {
  const v = c.noMoveCostUsd;
  if (v === null || !Number.isFinite(v)) return null;
  if (Math.abs(v) < 0.005) return { before: "With no move, the trial positions add nothing by that date.", usd: null, after: "" };
  return v > 0
    ? { before: "With no move, the trial positions cost", usd: v, after: "by that date." }
    : { before: "With no move, the trial positions gain", usd: -v, after: "by that date." };
}

/** A crossing this close to zero is at the first fall shown. */
const AT_FIRST_FALL = 0.0005;

/**
 * P5: one sentence per pattern of the difference across the falls shown.
 * `tableMoves` are the table's rows: a crossing deeper than every row is on
 * the chart only, so the sentence points there instead.
 */
export function crossingSentence(
  c: Pick<GainsAtRiskTrialCase, "crossing">,
  driver: string,
  tableMoves: readonly number[] = TABLE_MOVES,
): string | null {
  const x = c.crossing;
  const nearZero = (m: number) => Math.abs(m) < AT_FIRST_FALL;
  switch (x.kind) {
    case "better-at-every-move":
      return "They do better at every fall shown.";
    case "worse-at-every-move":
      return "They cost more than they return at every fall shown.";
    case "pays-beyond":
      return nearZero(x.move)
        ? "They pay for themselves from the first fall shown."
        : `They pay for themselves once ${driver} falls more than ${fallPct(x.move)}.`;
    case "helps-until":
      return nearZero(x.move)
        ? "They cost more than they return from the first fall shown."
        : `They help in a small fall and cost more beyond ${fallPct(x.move)}.`;
    case "changes-more-than-once": {
      const [a, b] = [Math.abs(x.firstHelpFrom), Math.abs(x.firstHelpTo)].sort((p, q) => p - q);
      const deepestRow = Math.max(0, ...tableMoves.map((m) => Math.abs(m)));
      const look = b > deepestRow + 1e-9 ? "see the chart" : "read the table";
      const span = nearZero(a) ? `from the first fall shown to ${fallPct(b)}` : `between ${fallPct(a)} and ${fallPct(b)}`;
      return `They help ${span}. The picture changes more than once; ${look}.`;
    }
    case "no-trial-effect":
      return null;
  }
}

// ─── The chart and the moves table ──────────────────────────────

export interface TrialChartRow {
  move: number;
  asIs: number;
  withTrial: number;
}

/**
 * The selected case only (two lines): the book as it is and the book with the
 * trial positions, on the default sweep's moves. A move missing from either
 * side is left out, never drawn as zero.
 */
export function trialChartRows(
  base: Record<GainsAtRiskCaseKey, { moves: GainsAtRiskMoveRow[] }>,
  trial: Record<GainsAtRiskCaseKey, { moves: GainsAtRiskTrialCase["moves"] }>,
  selected: GainsAtRiskCaseKey,
): TrialChartRow[] {
  const out: TrialChartRow[] = [];
  for (const move of defaultSweep()) {
    const b = base[selected].moves.find((r) => sameMove(r.move, move));
    const t = trial[selected].moves.find((r) => sameMove(r.move, move));
    if (!b || !t) continue;
    out.push({ move: b.move, asIs: b.bookPnlUsd, withTrial: t.bookWithTrialPnlUsd });
  }
  return out;
}

/** The dollar axis over both lines and zero, padded 5%. */
export function trialChartDollarDomain(rows: TrialChartRow[]): [number, number] {
  const values = rows.flatMap((r) => [r.asIs, r.withTrial, 0]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.05 || 1;
  return [lo - pad, hi + pad];
}

/** One row of the moves table while trial positions are on. */
export function trialTableRow(
  base: { moves: GainsAtRiskMoveRow[] },
  trial: { moves: GainsAtRiskTrialCase["moves"] },
  move: number,
): { asIs: number; withTrial: number; difference: number } | null {
  const b = base.moves.find((r) => sameMove(r.move, move));
  const t = trial.moves.find((r) => sameMove(r.move, move));
  if (!b || !t) return null;
  return { asIs: b.bookPnlUsd, withTrial: t.bookWithTrialPnlUsd, difference: t.trialPnlUsd };
}

// ─── The list (R5: page state only, never stored) ───────────────

export interface TrialListState {
  list: TrialPositionState[];
  /** Bumped by every add, edit and remove: the view asks again on each. */
  version: number;
}

export type TrialListAction =
  | { type: "add"; trial: TrialPositionState }
  | { type: "replace"; id: string; trial: TrialPositionState }
  | { type: "remove"; id: string };

export function emptyTrialList(): TrialListState {
  return { list: [], version: 0 };
}

export function trialListReducer(state: TrialListState, action: TrialListAction): TrialListState {
  switch (action.type) {
    case "add":
      if (state.list.length >= B.maxPositions) return state;
      return { list: [...state.list, action.trial], version: state.version + 1 };
    case "replace": {
      const at = state.list.findIndex((t) => t.position.id === action.id);
      if (at < 0) return state;
      const list = [...state.list];
      list[at] = action.trial;
      return { list, version: state.version + 1 };
    }
    case "remove": {
      if (!state.list.some((t) => t.position.id === action.id)) return state;
      return { list: state.list.filter((t) => t.position.id !== action.id), version: state.version + 1 };
    }
  }
}

let idCounter = 0;
/** A page-local id of at most 40 characters. */
export function newTrialId(now = Date.now()): string {
  idCounter += 1;
  return `t${now.toString(36)}${idCounter.toString(36)}`;
}

// ─── The form ───────────────────────────────────────────────────

/**
 * The lookup line's words about daily prices. It promises a fetch only when
 * one will happen (connected and a broker contract on file); null while the
 * connection status is still loading and the name has no daily prices.
 */
export function lookupBarsLine(security: TrialLookup, connected: boolean | null): string | null {
  if (security.dailyBars.count > 0 && security.dailyBars.through) {
    return `Daily prices through ${formatPositionsDate(security.dailyBars.through)}.`;
  }
  if (connected === null) return null;
  if (!connected) return "No daily prices yet. Connect the broker to fetch them.";
  if (!security.hasContractId) {
    return "No daily prices, and no broker contract on file, so its link to the index cannot be measured. Type your own figure for it after adding.";
  }
  return "No daily prices yet: they are fetched from the broker when you add it.";
}

/** A strike written the one way: "480.0" and "480" are the same strike. */
function canonicalStrike(text: string): string {
  const t = text.trim();
  const v = Number(t);
  return t !== "" && Number.isFinite(v) && v > 0 ? String(v) : t;
}

/**
 * How the expiry and strike fields stand against the broker's chain: a value
 * in the chain is shown selected (a typed strike matched by value), anything
 * else is kept exactly as typed. An empty field picks from the list.
 */
export function chainFieldState(
  draft: Pick<TrialDraft, "expiry" | "strike">,
  chain: { expirations: string[]; strikes: number[] },
): { expiry: { inChain: boolean; value: string }; strike: { inChain: boolean; value: string } } {
  const expiry = draft.expiry;
  const strikeText = draft.strike.trim();
  const match = strikeText === "" ? null : chain.strikes.find((k) => k === Number(strikeText));
  return {
    expiry: { inChain: expiry === "" || chain.expirations.includes(expiry), value: expiry },
    strike:
      strikeText === ""
        ? { inChain: true, value: "" }
        : match !== undefined && match !== null
          ? { inChain: true, value: String(match) }
          : { inChain: false, value: draft.strike },
  };
}

/** What the owner has typed. `side` "sell" on an option means write. */
export interface TrialDraft {
  kind: "option" | "shares";
  symbol: string;
  right: "put" | "call";
  side: "buy" | "sell";
  expiry: string;
  strike: string;
  count: string;
  price: string;
  /** The trial being edited, or null for a new one. */
  editingId: string | null;
}

export function emptyTrialDraft(): TrialDraft {
  return { kind: "option", symbol: "", right: "put", side: "buy", expiry: "", strike: "", count: "", price: "", editingId: null };
}

/** The form opened for an edit, filled exactly from the position. */
export function draftFromTrial(t: TrialPositionState): TrialDraft {
  const p = t.position;
  if (p.kind === "option") {
    return {
      kind: "option",
      symbol: t.symbol,
      right: p.right,
      side: p.side === "buy" ? "buy" : "sell",
      expiry: p.expiry,
      strike: String(p.strike),
      count: String(p.contracts),
      price: String(p.pricePaid),
      editingId: p.id,
    };
  }
  return {
    kind: "shares",
    symbol: t.symbol,
    right: "put",
    side: p.side,
    expiry: "",
    strike: "",
    count: String(p.quantity),
    price: String(p.price),
    editingId: p.id,
  };
}

function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function wholeNumber(text: string): number | null {
  const t = text.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

function positiveNumber(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) && v > 0 ? v : null;
}

const normSymbol = (s: string) => s.trim().toUpperCase();

/**
 * The form's own check before any request: null, or one plain sentence.
 * `count` is how many trial positions the list holds now.
 */
export function trialFormProblem(
  draft: TrialDraft,
  count: number,
  today: string,
  opts: { keptExpiry?: string } = {},
): string | null {
  if (draft.editingId === null && count >= B.maxPositions) return TRIAL_LIMIT_TEXT;
  if (normSymbol(draft.symbol) === "") return "Type a symbol.";
  const n = wholeNumber(draft.count);
  const max = draft.kind === "option" ? B.maxContracts : B.maxShares;
  if (n === null || n < 1 || n > max) {
    return `Type the number of ${draft.kind === "option" ? "contracts" : "shares"} as a whole number from 1 to ${grouped(max)}.`;
  }
  if (draft.kind === "option") {
    if (!isCalendarDay(draft.expiry)) return "Pick an expiry date.";
    // An edit that keeps the trial's own expiry may resize an expired one (it adds nothing either way).
    if (draft.expiry < today && draft.expiry !== opts.keptExpiry) return "That expiry is before today. Pick a later one.";
    const strike = positiveNumber(draft.strike);
    if (strike === null) return "Type the strike as a number above 0.";
    if (strike > B.maxStrike) return `The strike cannot be above ${grouped(B.maxStrike)}.`;
  }
  const price = positiveNumber(draft.price);
  if (price === null) return "Type the price per share as a number above 0.";
  if (price > B.maxPrice) return `The price cannot be above ${grouped(B.maxPrice)}.`;
  return null;
}

/** "quote-mid" when the price is the fetched quote's mid; otherwise "typed". */
export function trialPriceSource(price: string, quote: TrialQuote | null): "typed" | "quote-mid" {
  if (!quote) return "typed";
  const v = Number(price.trim());
  return Number.isFinite(v) && Math.abs(v - quote.mid) < 1e-9 ? "quote-mid" : "typed";
}

/**
 * The entry route's request from a draft that passed trialFormProblem. With a
 * quote fetched for this contract, its underlying price goes with it (R2).
 */
export function trialEntryRequest(draft: TrialDraft, quote: TrialQuote | null): TrialEntryRequest {
  const symbol = normSymbol(draft.symbol);
  if (draft.kind === "option") {
    return {
      kind: "option",
      symbol,
      right: draft.right,
      side: draft.side === "buy" ? "buy" : "write",
      expiry: draft.expiry,
      strike: Number(draft.strike.trim()),
      contracts: Number(draft.count.trim()),
      price: Number(draft.price.trim()),
      ...(quote && quote.underlyingLast !== null ? { quotedUnderlyingPrice: quote.underlyingLast } : {}),
    };
  }
  return {
    kind: "shares",
    symbol,
    side: draft.side,
    quantity: Number(draft.count.trim()),
    price: Number(draft.price.trim()),
  };
}

/** The page's record of a trial from the entry route's answer. `position` is the route's, untouched, plus the id. */
export function trialStateFromEntry(
  resp: Extract<TrialEntryResponse, { action: "entry" }>,
  id: string,
  draft: TrialDraft,
  quote: TrialQuote | null,
): TrialPositionState {
  const e = resp.entry;
  const position = { ...e.position, id } as TrialPositionInput;
  const priceSource = position.kind === "option" ? trialPriceSource(draft.price, quote) : "typed";
  return {
    position,
    symbol: e.symbol,
    name: e.name,
    holdingsAtAddByAccount: e.holdingsAtAddByAccount,
    priceSource,
    ...(position.kind === "option" && quote ? { quote } : {}),
    staleCloseDate: e.staleCloseDate,
    underlyingPrice: e.underlyingPrice,
    underlyingPriceDate: e.underlyingPriceDate,
    underlyingPriceSource: resp.underlyingPriceSource,
    appValuation: resp.appValuation,
  };
}

/**
 * P1: a size-only change keeps the entry and the snapshot (no server call);
 * a change of terms, side or price needs a new entry.
 */
export function applyTrialEdit(
  prev: TrialPositionState,
  draft: TrialDraft,
): { kind: "resize"; next: TrialPositionState } | { kind: "new-entry" } {
  const p = prev.position;
  const n = wholeNumber(draft.count);
  if (draft.kind !== p.kind || normSymbol(draft.symbol) !== normSymbol(prev.symbol) || n === null || n < 1) {
    return { kind: "new-entry" };
  }
  const price = Number(draft.price.trim());
  if (p.kind === "option") {
    const side = draft.side === "buy" ? "buy" : "write";
    if (
      side !== p.side ||
      draft.right !== p.right ||
      draft.expiry !== p.expiry ||
      Number(draft.strike.trim()) !== p.strike ||
      price !== p.pricePaid
    ) {
      return { kind: "new-entry" };
    }
    return { kind: "resize", next: { ...prev, position: { ...p, contracts: n } } };
  }
  if (draft.side !== p.side || price !== p.price) return { kind: "new-entry" };
  return { kind: "resize", next: { ...prev, position: { ...p, quantity: n } } };
}

// ─── P6: the form's requests ────────────────────────────────────

export type TrialFormRequestKind = "lookup" | "chain" | "quote" | "ensure" | "entry";

/**
 * Requests that depend on the symbol only (the name's lookup, the broker's
 * chain, the daily-price fetch): an edit to anything else neither drops nor
 * re-asks them. A quote and an entry depend on the whole draft.
 */
const SYMBOL_KEYED: readonly TrialFormRequestKind[] = ["lookup", "chain", "ensure"];
const isSymbolKeyed = (k: TrialFormRequestKind) => SYMBOL_KEYED.includes(k);

export interface TrialFormPayloads {
  lookup: { ok: true; security: TrialLookup } | { ok: false; message: string };
  chain: { ok: true; expirations: string[]; strikes: number[] } | { ok: false; message: string };
  quote: { ok: true; quote: TrialQuote } | { ok: false; message: string };
  ensure: { ok: true; message: string | null } | { ok: false; message: string };
  entry: { ok: true; entry: Extract<TrialEntryResponse, { action: "entry" }> } | { ok: false; message: string };
}

export interface TrialFormState {
  open: boolean;
  revision: number;
  contractKey: string;
  draft: TrialDraft;
  quote: TrialQuote | null;
  /** The id of the latest request of each kind still on the way. */
  pending: Partial<Record<TrialFormRequestKind, number>>;
  /** The name's lookup for the draft's symbol. */
  security: TrialLookup | null;
  /** The broker's expiries and strikes for the symbol (merged across expiries). */
  chain: { expirations: string[]; strikes: number[] } | null;
  /** The daily-price fetch for this symbol succeeded. */
  ensureDone: boolean;
  /** The daily-price fetch for this symbol failed: Add waits for the owner's choice. */
  ensureFailed: boolean;
  /** The owner chose to add without daily prices. */
  skipBars: boolean;
  /** The last sentence each kind of request answered with. */
  messages: Partial<Record<TrialFormRequestKind, string>>;
  entry: Extract<TrialEntryResponse, { action: "entry" }> | null;
}

type ReplyAction = {
  [K in TrialFormRequestKind]: {
    type: "reply";
    kind: K;
    id: number;
    revision: number;
    contractKey: string;
    /** The symbol the request was sent for (lookup, chain and fetch are keyed by it). */
    symbol?: string;
    payload: TrialFormPayloads[K];
  };
}[TrialFormRequestKind];

export type TrialFormAction =
  | { type: "open"; draft: TrialDraft; quote?: TrialQuote | null }
  | { type: "edit"; patch: Partial<TrialDraft> }
  | { type: "cancel" }
  | { type: "request"; kind: TrialFormRequestKind; id: number }
  | { type: "retry-bars" }
  | { type: "skip-bars" }
  | ReplyAction;

/** kind|symbol|right|strike|expiry: what a quote and a contract depend on ("480.0" is 480). */
export function trialContractKey(d: TrialDraft): string {
  return [d.kind, normSymbol(d.symbol), d.right, canonicalStrike(d.strike), d.expiry].join("|");
}

/** The symbol as a request key. */
export function trialSymbolKey(d: Pick<TrialDraft, "symbol">): string {
  return normSymbol(d.symbol);
}

export function initialTrialFormState(): TrialFormState {
  const draft = emptyTrialDraft();
  return {
    open: false,
    revision: 0,
    contractKey: trialContractKey(draft),
    draft,
    quote: null,
    pending: {},
    security: null,
    chain: null,
    ensureDone: false,
    ensureFailed: false,
    skipBars: false,
    messages: {},
    entry: null,
  };
}

/**
 * Whether a reply still answers the form as it stands (the reducer's own
 * test). Every reply needs the form open and its request to be the latest of
 * its kind. A lookup, chain or fetch reply sent with its symbol needs the same
 * symbol; any other reply needs the same revision and contract key.
 */
export function isCurrentTrialReply(
  state: TrialFormState,
  kind: TrialFormRequestKind,
  id: number,
  revision: number,
  contractKey: string,
  symbol?: string,
): boolean {
  if (!state.open || state.pending[kind] !== id) return false;
  if (isSymbolKeyed(kind) && symbol !== undefined) return trialSymbolKey(state.draft) === symbol;
  return state.revision === revision && state.contractKey === contractKey;
}

/** A request that holds up Add: a quote, a daily-price fetch or an entry on the way (never a lookup or the chain). */
export function addBlockedBy(state: Pick<TrialFormState, "pending">): boolean {
  return state.pending.quote !== undefined || state.pending.ensure !== undefined || state.pending.entry !== undefined;
}

/**
 * P8: what Add does about daily prices for the name. "fetch" once when the
 * broker is connected, a contract is on file and there are none; "blocked"
 * after a failed fetch until the owner tries again or chooses to add without
 * them; "none" otherwise.
 */
export function barsStep(
  state: Pick<TrialFormState, "ensureDone" | "ensureFailed" | "skipBars">,
  security: TrialLookup,
  connected: boolean,
): "fetch" | "blocked" | "none" {
  if (!connected || !security.hasContractId || security.dailyBars.count > 0) return "none";
  if (state.ensureDone || state.skipBars) return "none";
  return state.ensureFailed ? "blocked" : "fetch";
}

function without<T extends object>(obj: T, key: keyof T): T {
  const rest = { ...obj };
  delete rest[key];
  return rest;
}

/** Only the symbol-keyed requests survive a change that is not to the symbol. */
function symbolKeyedOnly(pending: TrialFormState["pending"]): TrialFormState["pending"] {
  const out: TrialFormState["pending"] = {};
  for (const k of SYMBOL_KEYED) if (pending[k] !== undefined) out[k] = pending[k];
  return out;
}

/**
 * P6. Every edit bumps the revision. A quote or an entry on the way is then
 * no longer pending (its reply answers an older draft); a lookup, chain or
 * fetch stays pending unless the symbol changed. An edit that changes the
 * contract key clears the quote, and clears the price too when the box still
 * holds that quote's mid. A symbol change forgets the lookup, the chain and
 * the fetch. A reply that no longer answers the form, or arrives after cancel,
 * is dropped (the same state is returned).
 */
export function trialFormReducer(state: TrialFormState, action: TrialFormAction): TrialFormState {
  switch (action.type) {
    case "open": {
      const draft = action.draft;
      return {
        ...initialTrialFormState(),
        open: true,
        revision: state.revision + 1,
        contractKey: trialContractKey(draft),
        draft,
        quote: action.quote ?? null,
      };
    }
    case "cancel":
      return { ...state, open: false, revision: state.revision + 1, pending: {} };
    case "retry-bars":
      return state.open ? { ...state, ensureFailed: false, skipBars: false, messages: without(state.messages, "ensure") } : state;
    case "skip-bars":
      return state.open ? { ...state, skipBars: true } : state;
    case "edit": {
      if (!state.open) return state;
      let draft = { ...state.draft, ...action.patch };
      const contractKey = trialContractKey(draft);
      const keyChanged = contractKey !== state.contractKey;
      const symbolChanged = trialSymbolKey(draft) !== trialSymbolKey(state.draft);
      // The quote's mid belonged to the other contract: it goes with the quote. A typed price stays.
      if (keyChanged && state.quote && action.patch.price === undefined && Number(draft.price.trim()) === state.quote.mid) {
        draft = { ...draft, price: "" };
      }
      let messages = without(state.messages, "entry");
      if (keyChanged) messages = without(messages, "quote");
      if (symbolChanged) messages = without(without(without(messages, "lookup"), "chain"), "ensure");
      return {
        ...state,
        draft,
        revision: state.revision + 1,
        contractKey,
        pending: symbolChanged ? {} : symbolKeyedOnly(state.pending),
        quote: keyChanged ? null : state.quote,
        security: symbolChanged ? null : state.security,
        chain: symbolChanged ? null : state.chain,
        ensureDone: symbolChanged ? false : state.ensureDone,
        ensureFailed: symbolChanged ? false : state.ensureFailed,
        skipBars: symbolChanged ? false : state.skipBars,
        messages,
        entry: null,
      };
    }
    case "request":
      if (!state.open) return state;
      return { ...state, pending: { ...state.pending, [action.kind]: action.id }, messages: without(state.messages, action.kind) };
    case "reply": {
      if (!isCurrentTrialReply(state, action.kind, action.id, action.revision, action.contractKey, action.symbol)) return state;
      const base = { ...state, pending: without(state.pending, action.kind) };
      switch (action.kind) {
        case "lookup": {
          const p = action.payload;
          if (!p.ok) return { ...base, security: null, messages: { ...base.messages, lookup: p.message } };
          // Shares: the price starts at the app's own price for the name, editable.
          const fill = base.draft.kind === "shares" && base.draft.price.trim() === "" && p.security.price !== null;
          return fill
            ? {
                ...base,
                security: p.security,
                draft: { ...base.draft, price: String(p.security.price) },
                revision: base.revision + 1,
                pending: symbolKeyedOnly(base.pending),
              }
            : { ...base, security: p.security };
        }
        case "chain": {
          // The chain never touches the draft: a typed expiry or strike stays as typed.
          const p = action.payload;
          return p.ok
            ? { ...base, chain: { expirations: p.expirations, strikes: p.strikes } }
            : { ...base, chain: null, messages: { ...base.messages, chain: p.message } };
        }
        case "quote": {
          const p = action.payload;
          if (!p.ok) return { ...base, messages: { ...base.messages, quote: p.message } };
          // The price takes the mid; the draft changed, so the revision moves on.
          return {
            ...base,
            quote: p.quote,
            draft: { ...base.draft, price: String(p.quote.mid) },
            revision: base.revision + 1,
            pending: symbolKeyedOnly(base.pending),
          };
        }
        case "ensure": {
          const p = action.payload;
          return p.ok
            ? { ...base, ensureDone: true, ensureFailed: false, messages: without(base.messages, "ensure") }
            : { ...base, ensureFailed: true, messages: { ...base.messages, ensure: p.message } };
        }
        case "entry": {
          const p = action.payload;
          return p.ok ? { ...base, entry: p.entry } : { ...base, messages: { ...base.messages, entry: p.message } };
        }
      }
    }
  }
}

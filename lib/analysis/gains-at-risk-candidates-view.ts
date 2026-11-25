/**
 * Gains at risk, step 3: the candidate table's plain rules and words.
 *
 * A plain module (no React, no database or broker code at run time), read by
 * the candidate provider, section, picker and table. Every price, entry and
 * figure comes from the routes; this module keeps the section's state as one
 * pure reducer and shapes replies into cells and sentences.
 *
 * Client boundary (P18): value imports are limited to other plain
 * `lib/analysis` modules. Engine, query and broker names are `import type`
 * only, erased at build.
 *
 * Privacy (P17): quote prices, strikes, expiries and the driver's move are
 * market data and are written plainly. Contracts, cost and every book figure
 * are the owner's: a helper never puts one inside a sentence, it returns the
 * number apart so the page prints it through <Count> / <Money> / <Pct>.
 */

import { CANDIDATE_BOUNDS, CANDIDATE_QUOTE_OLD_AFTER_MINUTES, TRIAL_POSITION_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import { budgetToUnits, toMoneyUnits, unitsToUsd } from "@/lib/analysis/gains-at-risk-candidate-money";
import { gainGivenBackShare, moveDirection, sameMove, type DriverChoice } from "@/lib/analysis/gains-at-risk-view";
import { TRIAL_LIMIT_TEXT, formatMarketPrice, formatStrike } from "@/lib/analysis/gains-at-risk-trial-view";
// Types only: erased at build.
import type { TrialPositionState, TrialQuote } from "@/lib/analysis/gains-at-risk-trial-view";
import type { GainsAtRiskBody } from "@/lib/analysis/gains-at-risk-input";
import type {
  BatchContractRequest,
  CandidateEntryRecord,
  CandidateQuoteFields,
  CandidateRequestItem,
  CandidateRow,
  CandidatesBody,
  CandidatesResponse,
  ChainContract,
  ChainResponse,
  QuotesResponse,
} from "@/lib/analysis/gains-at-risk-candidates-input";
import type {
  GainsAtRiskCandidateCase,
  GainsAtRiskCaseKey,
  GainsAtRiskTrialCrossing,
  TrialRefusal,
} from "@/lib/compute/gains-at-risk";
import type { CandidateUnderlyingEntry } from "@/lib/compute/gains-at-risk-drivers";
import type { YearGainResult } from "@/lib/compute/year-gain";

// ─── Fixed words ────────────────────────────────────────────────

export const CANDIDATES_SECTION_TITLE = "Compare options";
export const CANDIDATES_NOT_STORED_NOTE = "Quotes come from the broker. Nothing is stored. Nothing is traded from this page.";
/** P16: the step 2 sentence. */
export const CANDIDATES_CONNECT_TEXT = "Connect the broker to fetch quotes.";
export const CANDIDATES_DISCONNECTED_NOTE =
  "Rows already quoted stay and still recompute. A price can also be typed in the trial position form.";
export const CANDIDATES_BUYING_ONLY_NOTE = "Bought options only. A written option goes in the trial position form.";
export const ZERO_CONTRACTS_TEXT = "One contract costs more than the budget.";
export const CAPPED_TEXT = `Capped at ${TRIAL_POSITION_BOUNDS.maxContracts} contracts.`;
export const NO_FIGURES_TEXT = "does not pay within the moves shown";
export const OLD_QUOTE_TEXT = "old quote";
export const BUDGET_PENDING_TEXT = "Press Enter to apply the new budget.";
export const IN_TRIALS_TEXT = "Already in the trial positions. Change its size there.";
export const IN_TRIALS_MARK = "In trial positions";
export const IN_TRIALS_NOTE =
  "A row marked In trial positions shows its effect on top of everything already on the page, its own trial position included.";
export const ROWS_LIMIT_TEXT = `At most ${CANDIDATE_BOUNDS.maxCandidates} rows in the table. Remove some first.`;

// ─── State ──────────────────────────────────────────────────────

export interface CandidateContract {
  right: "put" | "call";
  expiry: string;
  strike: number;
  tradingClass: string;
  multiplier: 100;
}

export interface CandidateRowState {
  /** The broker's contract id: the row's identity everywhere (D1). */
  conId: number;
  underlyingSecurityId: number;
  symbol: string;
  contract: CandidateContract;
  /** The last quote the broker gave; kept when a later pull refuses it (D4). */
  quote: CandidateQuoteFields | null;
  /** F2: the complete solved entry from call 1, kept untouched; null when the row has no entry. */
  record: CandidateEntryRecord | null;
  /** No quote / not quoted / no entry: the sentence. */
  quoteProblem: string | null;
  /** Only from an answer to the inputs on screen (P15): set together with `figuresSeq`. */
  figures: CandidateRow | null;
}

export type StrikesReply = Extract<ChainResponse, { kind: "strikes" }>;

export interface CandidatesState {
  open: boolean;
  underlyingSecurityId: number | null;
  right: "put" | "call";
  /** The id of the one chain request whose reply is wanted; 0 when none (D8). Ids come from the provider, never reused. */
  chainRevision: number;
  chainPending: boolean;
  chainProblem: string | null;
  /** The expiries the broker lists for the underlying and right. */
  expiries: string[] | null;
  /** At most CANDIDATE_BOUNDS.maxExpiriesPerPull. */
  chosenExpiries: string[];
  /** Each chosen expiry's own strikes (P11). */
  strikes: StrikesReply | null;
  /** At most CANDIDATE_BOUNDS.maxContractsPerPull (D4). */
  chosenConIds: number[];
  /** Keyed by conId; request order. */
  rows: CandidateRowState[];
  /** conId → the id of the newest pull asked for it (D8). */
  pulls: Record<number, number>;
  /** The pull ids sent from the picker (not a Refresh): a picker change drops only these (D8). */
  pickerPullIds: number[];
  pullProblem: string | null;
  /** Bumped by every compute-input revision (P15, F6); a compute reply is shown only for the current value. */
  computeSeq: number;
  /** The inputs the current `computeSeq` answers to (scope, driver, date, moves, volatility, figures, trial list, selected move). */
  inputsKey: string;
  /** The seq the rows' figures answer; null when no row has figures. */
  figuresSeq: number | null;
  computingSeq: number | null;
  computeProblem: string | null;
  budgetUsdText: string;
}

export type CandidatesAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "clear" }
  | { type: "set-underlying"; securityId: number }
  | { type: "set-right"; right: "put" | "call" }
  | { type: "chain-request"; revision: number; expiries?: string[] }
  | { type: "chain-reply"; revision: number; underlyingSecurityId: number; right: "put" | "call"; reply: ChainResponse }
  | { type: "chain-failure"; revision: number; message: string }
  | { type: "choose-expiries"; expiries: string[] }
  | { type: "choose"; conIds: number[] }
  /** "pull": from the picker, may add rows. "refresh": the table's own rows only, never adds one (D8). */
  | {
      type: "quotes-request";
      mode: "pull" | "refresh";
      pullId: number;
      underlyingSecurityId: number;
      symbol: string;
      contracts: BatchContractRequest[];
    }
  | { type: "quotes-reply"; pullId: number; underlyingSecurityId: number; reply: QuotesResponse }
  | { type: "quotes-failure"; pullId: number; conIds: number[]; message: string }
  | { type: "remove"; conId: number }
  /** Scope (F1), driver, date, moves, volatility, overrides, trial list, selected move: `key` names them. */
  | { type: "inputs-changed"; key: string }
  | { type: "compute-request"; seq: number }
  | { type: "compute-reply"; seq: number; reply: CandidatesResponse }
  | { type: "compute-failure"; seq: number; message: string }
  /** A failed compute, asked again by the owner: a new sequence. */
  | { type: "compute-retry" }
  | { type: "budget"; text: string };

export const DEFAULT_BUDGET_TEXT = "10000";

export function initialCandidatesState(): CandidatesState {
  return {
    open: false,
    underlyingSecurityId: null,
    right: "put",
    chainRevision: 0,
    chainPending: false,
    chainProblem: null,
    expiries: null,
    chosenExpiries: [],
    strikes: null,
    chosenConIds: [],
    rows: [],
    pulls: {},
    pickerPullIds: [],
    pullProblem: null,
    computeSeq: 0,
    inputsKey: "",
    figuresSeq: null,
    computingSeq: null,
    computeProblem: null,
    budgetUsdText: DEFAULT_BUDGET_TEXT,
  };
}

/** Every row's book figures cleared and the compute sequence moved on (P15, F6). */
function revise(state: CandidatesState): CandidatesState {
  return {
    ...state,
    rows: state.rows.map((r) => (r.figures === null ? r : { ...r, figures: null })),
    computeSeq: state.computeSeq + 1,
    figuresSeq: null,
    computingSeq: null,
    computeProblem: null,
  };
}

/** A row asked for but never answered: it exists only for a pull in flight. */
function isPlaceholder(r: CandidateRowState): boolean {
  return r.quote === null && r.record === null && r.quoteProblem === null;
}

/** The chain picker starts again (a new underlying or right); every pull in flight is dropped (D8). */
function resetPicker(state: CandidatesState): CandidatesState {
  return {
    ...state,
    chainRevision: 0,
    chainPending: false,
    chainProblem: null,
    expiries: null,
    chosenExpiries: [],
    strikes: null,
    chosenConIds: [],
    ...dropPulls(state, new Set(state.pickerPullIds)),
  };
}

/**
 * Pulls in flight are dropped (every one, or only `only`): their replies will
 * be ignored, and rows that existed only for them go. A Refresh in flight for
 * rows already in the table survives a picker change (S6 fix 1, item 6).
 */
function dropPulls(
  state: CandidatesState,
  only?: ReadonlySet<number>,
): Pick<CandidatesState, "rows" | "pulls" | "pickerPullIds"> {
  const dropped = (conId: number) => state.pulls[conId] !== undefined && (only === undefined || only.has(state.pulls[conId]));
  const pulls: Record<number, number> = {};
  for (const [id, pullId] of Object.entries(state.pulls)) if (!dropped(Number(id))) pulls[Number(id)] = pullId;
  return {
    rows: state.rows.filter((r) => !(dropped(r.conId) && isPlaceholder(r))),
    pulls,
    pickerPullIds: only === undefined ? [] : state.pickerPullIds.filter((id) => !only.has(id)),
  };
}

/** P11 defaults across the chosen expiries, in expiry then strike order, at most 15 in all. */
export function defaultChosenConIds(reply: StrikesReply): number[] {
  const out: number[] = [];
  for (const e of reply.byExpiry) {
    const defaults = new Set(e.defaultConIds);
    for (const c of [...e.contracts].sort((a, b) => a.strike - b.strike)) {
      if (defaults.has(c.conId) && out.length < CANDIDATE_BOUNDS.maxContractsPerPull) out.push(c.conId);
    }
  }
  return out;
}

export function candidatesReducer(state: CandidatesState, action: CandidatesAction): CandidatesState {
  switch (action.type) {
    case "open":
      return state.open ? state : { ...state, open: true };
    case "close":
      // D8: a chain or quote reply after the section was closed is dropped. Rows stay.
      if (!state.open) return state;
      return { ...state, open: false, chainRevision: 0, chainPending: false, ...dropPulls(state) };
    case "clear":
      // A compute in flight answered the old rows: the sequence moves on (S6 fix 1, item 5).
      return { ...revise(state), rows: [], pulls: {}, pickerPullIds: [], pullProblem: null, chainRevision: 0, chainPending: false };
    case "set-underlying":
      if (state.underlyingSecurityId === action.securityId) return state;
      return { ...resetPicker(state), underlyingSecurityId: action.securityId, pullProblem: null };
    case "set-right":
      if (state.right === action.right) return state;
      return { ...resetPicker(state), right: action.right, pullProblem: null };
    case "chain-request":
      if (!state.open || action.revision <= 0) return state;
      return {
        ...state,
        chainRevision: action.revision,
        chainPending: true,
        chainProblem: null,
        // Asking for strikes keeps the expiries; asking for expiries starts again.
        ...(action.expiries === undefined
          ? { expiries: null, chosenExpiries: [], strikes: null, chosenConIds: [] }
          : { strikes: null, chosenConIds: [] }),
      };
    case "chain-reply": {
      if (!state.open || action.revision === 0 || action.revision !== state.chainRevision) return state;
      if (action.underlyingSecurityId !== state.underlyingSecurityId || action.right !== state.right) return state;
      const reply = action.reply;
      if (reply.underlyingSecurityId !== state.underlyingSecurityId || reply.right !== state.right) return state;
      if (reply.kind === "expiries") {
        return { ...state, chainRevision: 0, chainPending: false, expiries: reply.expiries, chosenExpiries: [], strikes: null, chosenConIds: [] };
      }
      return { ...state, chainRevision: 0, chainPending: false, strikes: reply, chosenConIds: defaultChosenConIds(reply) };
    }
    case "chain-failure":
      if (action.revision === 0 || action.revision !== state.chainRevision) return state;
      return { ...state, chainRevision: 0, chainPending: false, chainProblem: action.message };
    case "choose-expiries": {
      const listed = new Set(state.expiries ?? []);
      const next = [...new Set(action.expiries)].filter((e) => listed.has(e)).slice(0, CANDIDATE_BOUNDS.maxExpiriesPerPull);
      return { ...state, chosenExpiries: next, strikes: null, chosenConIds: [], chainRevision: 0, chainPending: false };
    }
    case "choose": {
      const offered = new Set((state.strikes?.byExpiry ?? []).flatMap((e) => e.contracts.map((c) => c.conId)));
      const next = [...new Set(action.conIds)].filter((id) => offered.has(id)).slice(0, CANDIDATE_BOUNDS.maxContractsPerPull);
      return { ...state, chosenConIds: next };
    }
    case "quotes-request": {
      const cs = action.contracts;
      // D8: nothing is asked for a closed section.
      if (!state.open) return state;
      if (cs.length === 0 || cs.length > CANDIDATE_BOUNDS.maxContractsPerPull) return state;
      const existing = new Set(state.rows.map((r) => r.conId));
      // A refresh names only rows still in the table: a removed row is never asked again or recreated.
      if (action.mode === "refresh" && cs.some((c) => !existing.has(c.conId))) return state;
      const added = cs.filter((c) => !existing.has(c.conId));
      if (state.rows.length + added.length > CANDIDATE_BOUNDS.maxCandidates) return state;
      const pulls = { ...state.pulls };
      for (const c of cs) pulls[c.conId] = action.pullId;
      const newRows: CandidateRowState[] = added.map((c) => ({
        conId: c.conId,
        underlyingSecurityId: action.underlyingSecurityId,
        symbol: action.symbol,
        contract: { right: c.right, expiry: c.expiry, strike: c.strike, tradingClass: c.tradingClass, multiplier: 100 },
        quote: null,
        record: null,
        quoteProblem: null,
        figures: null,
      }));
      const pickerPullIds = action.mode === "pull" ? [...state.pickerPullIds, action.pullId] : state.pickerPullIds;
      return { ...state, rows: [...state.rows, ...newRows], pulls, pickerPullIds, pullProblem: null };
    }
    case "quotes-reply": {
      const byConId = new Map(action.reply.rows.map((q) => [q.conId, q]));
      let replaced = false;
      let touched = false;
      const pulls = { ...state.pulls };
      const rows = state.rows.map((r) => {
        // D8: only rows still waiting on THIS pull, for this underlying.
        if (state.pulls[r.conId] !== action.pullId || r.underlyingSecurityId !== action.underlyingSecurityId) return r;
        const q = byConId.get(r.conId);
        if (q === undefined) return r;
        touched = true;
        delete pulls[r.conId];
        switch (q.status) {
          case "quoted":
            replaced = true;
            return { ...r, quote: q.quote, record: q.record, quoteProblem: null };
          case "no-entry":
            replaced = true;
            return { ...r, quote: q.quote, record: null, quoteProblem: q.sentence };
          case "not-quoted":
            // D4: a refused contract keeps its old quote and entry, flagged by age.
            return { ...r, quoteProblem: q.sentence };
        }
      });
      if (!touched) return state;
      const next = { ...state, rows, pulls };
      // F6: an accepted quote or entry replacement is a compute-input revision.
      return replaced ? revise(next) : next;
    }
    case "quotes-failure": {
      const mine = new Set(action.conIds.filter((id) => state.pulls[id] === action.pullId));
      if (mine.size === 0) return state;
      const pulls = { ...state.pulls };
      for (const id of mine) delete pulls[id];
      // Rows that existed only for this pull go; the rest keep their old quote.
      const rows = state.rows.filter((r) => !(mine.has(r.conId) && isPlaceholder(r)));
      return { ...state, rows, pulls, pullProblem: action.message };
    }
    case "remove": {
      if (!state.rows.some((r) => r.conId === action.conId)) return state;
      const pulls = { ...state.pulls };
      delete pulls[action.conId];
      return { ...state, rows: state.rows.filter((r) => r.conId !== action.conId), pulls };
    }
    case "inputs-changed":
      if (action.key === state.inputsKey) return state;
      return { ...revise(state), inputsKey: action.key };
    case "compute-request":
      if (action.seq !== state.computeSeq) return state;
      return { ...state, computingSeq: action.seq, computeProblem: null };
    case "compute-reply": {
      // T18: only an answer to the inputs on screen.
      if (action.seq !== state.computeSeq) return state;
      const byConId = new Map(action.reply.rows.map((r) => [r.conId, r]));
      return {
        ...state,
        // Only rows that were computed (a quote and an entry) take figures (S6 fix 1, item 5).
        rows: state.rows.map((r) => ({ ...r, figures: r.quote !== null && r.record !== null ? (byConId.get(r.conId) ?? null) : null })),
        figuresSeq: action.seq,
        computingSeq: null,
        computeProblem: null,
      };
    }
    case "compute-failure":
      if (action.seq !== state.computeSeq) return state;
      return { ...state, computingSeq: null, computeProblem: action.message };
    case "compute-retry":
      return revise(state);
    case "budget":
      if (action.text === state.budgetUsdText) return state;
      return { ...revise(state), budgetUsdText: action.text };
  }
}

// ─── Requests ───────────────────────────────────────────────────

/** D4: the table's rows by underlying, in calls of at most 15, in row order. */
export function refreshBatches(rows: readonly CandidateRowState[]): { underlyingSecurityId: number; conIds: number[] }[] {
  const byUnderlying = new Map<number, number[]>();
  for (const r of rows) {
    const list = byUnderlying.get(r.underlyingSecurityId) ?? [];
    list.push(r.conId);
    byUnderlying.set(r.underlyingSecurityId, list);
  }
  const out: { underlyingSecurityId: number; conIds: number[] }[] = [];
  const max = CANDIDATE_BOUNDS.maxContractsPerPull;
  for (const [underlyingSecurityId, ids] of byUnderlying) {
    for (let i = 0; i < ids.length; i += max) out.push({ underlyingSecurityId, conIds: ids.slice(i, i + max) });
  }
  return out;
}

/** A row's contract as the quotes body names it (D1). */
export function rowBatchContract(r: Pick<CandidateRowState, "conId" | "contract">): BatchContractRequest {
  return { conId: r.conId, ...r.contract };
}

/** A chain contract as the quotes body names it (D1). */
export function chainBatchContract(c: ChainContract, right: "put" | "call", expiry: string): BatchContractRequest {
  return { conId: c.conId, right, expiry, strike: c.strike, multiplier: 100, tradingClass: c.tradingClass };
}

/** The chosen strikes as quote-body contracts, in expiry then strike order. */
export function chosenBatchContracts(state: Pick<CandidatesState, "strikes" | "chosenConIds" | "right">): BatchContractRequest[] {
  if (!state.strikes) return [];
  const chosen = new Set(state.chosenConIds);
  return state.strikes.byExpiry.flatMap((e) =>
    [...e.contracts].sort((a, b) => a.strike - b.strike).filter((c) => chosen.has(c.conId)).map((c) => chainBatchContract(c, state.right, e.expiry)),
  );
}

/** Null, or why a pull of these contracts would overfill the table. */
export function pullProblem(rows: readonly CandidateRowState[], conIds: readonly number[]): string | null {
  const have = new Set(rows.map((r) => r.conId));
  const added = conIds.filter((id) => !have.has(id)).length;
  return rows.length + added > CANDIDATE_BOUNDS.maxCandidates ? ROWS_LIMIT_TEXT : null;
}

/** The budget box: whole cents above 0, at most the bound (D9). */
const BUDGET_TEXT = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{0,2})?$/;

/** Digits, optional commas grouping thousands, an optional point with at most two places; nothing else. */
export function parseBudgetText(text: string): { usd: number } | { problem: string } {
  const t = text.trim();
  const v = BUDGET_TEXT.test(t) ? Number(t.replace(/,/g, "")) : NaN;
  if (!Number.isFinite(v) || budgetToUnits(v) === null) {
    return { problem: `Type a budget in dollars and cents, above $0 and at most $${grouped(CANDIDATE_BOUNDS.maxBudgetUsd)}.` };
  }
  return { usd: v };
}

/**
 * What the rows' figures answer (P15): the page's body (or why there is
 * none), the selected move, and the book revision (a sync with the same
 * controls answers a new book, S6 fix 1).
 */
export function candidatesInputsKey(
  built: { ok: true; body: GainsAtRiskBody } | { ok: false; message: string },
  selectedMove: number,
  bookRevision: number,
): string {
  return JSON.stringify({ built, selectedMove, bookRevision });
}

/**
 * The candidates body: the page's ONE gains-at-risk body
 * (`gainsAtRiskRequestBody`, the view's own) plus exactly three fields: the
 * budget, the selected move (written as the moves write it) and the
 * candidates. Null when the selected move is not one of the moves.
 */
export function candidatesComputeBody(
  base: GainsAtRiskBody,
  selectedMove: number,
  budgetUsd: number,
  candidates: CandidateRequestItem[],
): CandidatesBody | null {
  const selected = base.moves.find((m) => sameMove(m, selectedMove));
  if (selected === undefined) return null;
  return { ...base, selectedMove: selected, budgetUsd, candidates };
}

/** The rows that can be computed: a quote with a solved entry (in row order, at most 30 by construction). */
export function candidateRequestItems(rows: readonly CandidateRowState[]): CandidateRequestItem[] {
  const out: CandidateRequestItem[] = [];
  for (const r of rows) {
    if (r.quote === null || r.record === null) continue;
    const p = r.record.entry.position;
    if (p.kind !== "option" || p.side !== "buy" || p.brokerContractId === undefined) continue;
    out.push({
      conId: r.conId,
      underlyingSecurityId: r.underlyingSecurityId,
      right: r.contract.right,
      expiry: r.contract.expiry,
      strike: r.contract.strike,
      multiplier: 100,
      tradingClass: r.contract.tradingClass,
      quote: r.quote,
      entry: {
        kind: "option",
        underlyingSecurityId: p.underlyingSecurityId,
        right: p.right,
        side: "buy",
        expiry: p.expiry,
        strike: p.strike,
        contracts: p.contracts,
        pricePaid: p.pricePaid,
        entryUnderlyingPrice: p.entryUnderlyingPrice,
        valuationPriceAtEntry: p.valuationPriceAtEntry,
        entryVolatility: p.entryVolatility,
        brokerContractId: p.brokerContractId,
      },
    });
  }
  return out;
}

// ─── Defaults and words ─────────────────────────────────────────

/** F8: the driver's own row when the server listed it, else null. */
export function defaultCandidateUnderlying(
  list: readonly CandidateUnderlyingEntry[],
  driver: DriverChoice,
  indexSymbol: string,
): number | null {
  if (driver.kind === "single-name") {
    const id = driver.entry.securityId;
    return id !== null && list.some((e) => e.securityId === id) ? id : null;
  }
  return list.find((e) => e.symbol === indexSymbol)?.securityId ?? null;
}

/** Review focus 2: a single-name driver with no contract on file cannot have candidates. */
export function driverNotListedNote(list: readonly CandidateUnderlyingEntry[], driver: DriverChoice): string | null {
  if (driver.kind !== "single-name") return null;
  const id = driver.entry.securityId;
  if (id !== null && list.some((e) => e.securityId === id)) return null;
  return `${driver.entry.symbol} has no broker contract on file, so options on it cannot be pulled here.`;
}

/** The underlying select's label: "ZZA — Name". */
export function underlyingOptionLabel(e: Pick<CandidateUnderlyingEntry, "symbol" | "name">): string {
  return e.name ? `${e.symbol} — ${e.name}` : e.symbol;
}

/** A move with its sign, as a plain percent: -0.061 → "-6.1%". The driver's move is market data. */
export function signedMovePct(move: number): string {
  const pct = Number((Math.abs(move) * 100).toFixed(1));
  return `${move > 0 ? "+" : move < 0 ? "-" : ""}${pct}%`;
}

/** D5: the crossing column's heading names the direction. */
export function crossingHeading(direction: "fall" | "rise", symbol: string): string {
  return direction === "rise" ? `Pays once ${symbol} rises past` : `Pays once ${symbol} falls past`;
}

/** D5: the heading's direction: index mode falls; single-name mode by the selected move's sign. */
export function headingDirection(driver: DriverChoice, selectedMove: number): "fall" | "rise" {
  return driver.kind === "single-name" ? moveDirection(selectedMove) : "fall";
}

/** One row's crossing cell, read in the driver's direction (D5). */
export function candidateCrossingText(c: Pick<GainsAtRiskCandidateCase, "crossing" | "crossingDirection">, symbol: string): string {
  const x: GainsAtRiskTrialCrossing = c.crossing;
  const noun = c.crossingDirection === "rise" ? "rise" : "fall";
  switch (x.kind) {
    case "pays-beyond":
      return Math.abs(x.move) < 0.0005 ? `from the first ${noun} shown` : `${symbol} ${signedMovePct(x.move)}`;
    case "better-at-every-move":
      return `at every ${noun} shown`;
    case "helps-until":
      return `only to ${symbol} ${signedMovePct(x.move)}`;
    case "changes-more-than-once":
      return `between ${symbol} ${signedMovePct(x.firstHelpFrom)} and ${signedMovePct(x.firstHelpTo)}, then changes again`;
    case "worse-at-every-move":
    case "no-trial-effect":
      return NO_FIGURES_TEXT;
  }
}

/** P13a: the run does not move this name. */
export function heldUnchangedNote(symbol: string): string {
  return `${symbol} is held unchanged in this run, so this row shows cost only.`;
}

/** The row's cost as a share of the year's gain, by step 1's ratio rule; else null. */
export function candidateCostShareOfGain(costUsd: number, yearGain: YearGainResult): number | null {
  return gainGivenBackShare(-costUsd, yearGain);
}

/** The share cell: a share that would print 0.0% reads "under 0.1%". */
export function candidateCostShareCell(
  costUsd: number,
  yearGain: YearGainResult,
): { kind: "pct"; percent: number } | { kind: "under-tenth" } | null {
  const share = candidateCostShareOfGain(costUsd, yearGain);
  if (share === null || !Number.isFinite(share)) return null;
  const percent = share * 100;
  if (percent > 0 && percent < 0.05) return { kind: "under-tenth" };
  return { kind: "pct", percent: Number(percent.toFixed(10)) };
}

/** "ZZA 2027-03-20 95 put": the contract, market data. */
export function candidateContractText(r: Pick<CandidateRowState, "symbol" | "contract">): string {
  return `${r.symbol} ${r.contract.expiry} ${formatStrike(r.contract.strike)} ${r.contract.right}`;
}

const EASTERN_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "2026-11-24T19:32:00Z" → "14:32" on the Eastern clock; "" when not a time. */
export function easternTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : EASTERN_TIME.format(d);
}

/** T19: a quote this old is flagged (14:59 not, 15:00 yes). */
export function isOldQuote(optionObservedAt: string, now: Date): boolean {
  const t = Date.parse(optionObservedAt);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t >= CANDIDATE_QUOTE_OLD_AFTER_MINUTES * 60_000;
}

/** P15: the quote's kind: live, delayed, or (outside the session) the last quote. */
export function quoteKindText(q: Pick<CandidateQuoteFields, "tickKind" | "session">): string {
  return q.session === "market-closed" ? "market closed: last quote" : q.tickKind;
}

/** The line under a row's quote: time, kind, and "old quote" from 15 minutes. */
export function quoteAgeLine(q: CandidateQuoteFields, now: Date): string {
  const at = easternTime(q.optionObservedAt);
  return `${at ? `${at}, ` : ""}${quoteKindText(q)}${isOldQuote(q.optionObservedAt, now) ? `, ${OLD_QUOTE_TEXT}` : ""}`;
}

/** D6: the two arrival times, shown in the row's expanded line. */
export function observationTimesLine(q: CandidateQuoteFields): string {
  return (
    `Option quote arrived ${easternTime(q.optionObservedAt) || "at an unknown time"}; ` +
    `underlying ${formatMarketPrice(q.underlyingPrice)} arrived ${easternTime(q.underlyingObservedAt) || "at an unknown time"} (Eastern).`
  );
}

/** A refused row's sentence (the engine's refusal). */
export function candidateRefusalText(refusal: TrialRefusal, symbol: string): string {
  const name = symbol || "This name";
  switch (refusal) {
    case "expired":
      return "This contract has expired by the date. Remove it.";
    case "not-modelled":
      return `The app cannot model ${name} in this run, so this row adds nothing.`;
    case "unknown-security":
      return "The app no longer knows this underlying, so this row adds nothing. Remove it.";
    case "is-an-option":
      return `${name} is now listed as an option, so this row adds nothing. Remove it.`;
    case "foreign-currency":
      return `${name} is not priced in US dollars, so this row adds nothing.`;
    case "no-fx-rate":
      return `${name} has no exchange rate to dollars, so this row adds nothing.`;
    case "no-underlying-price":
      return `The app holds no price for ${name}, so this row adds nothing.`;
    case "no-option-terms":
      return "The contract's terms cannot be priced, so this row adds nothing.";
  }
}

// ─── Add (P14, F10) ─────────────────────────────────────────────

export type AddBlocked = "no-entry" | "in-trials" | "refused" | "zero-contracts" | "figures-not-current" | "trial-limit";

const ADD_BLOCKED_TEXT: Record<AddBlocked, string> = {
  "no-entry": "No quote with a solved entry, so there is nothing to add.",
  "in-trials": IN_TRIALS_TEXT,
  refused: "This row adds nothing in this run, so it cannot be added.",
  "zero-contracts": ZERO_CONTRACTS_TEXT,
  "figures-not-current": "Wait for the figures for the settings on screen.",
  "trial-limit": TRIAL_LIMIT_TEXT,
};

/** F10: null when Add is allowed; else why not. */
export function candidateAddBlocked(
  row: CandidateRowState,
  state: Pick<CandidatesState, "computeSeq">,
  figuresSeq: number | null,
  trialCount: number,
  /** The broker contract ids already in the trial list (`trialBrokerContractIds`). */
  inTrials: ReadonlySet<number> = new Set(),
): { reason: AddBlocked; text: string } | null {
  const blocked = (reason: AddBlocked) => ({ reason, text: ADD_BLOCKED_TEXT[reason] });
  // Ruling (S6 fix 1): one contract is one trial position; its size is changed there.
  if (inTrials.has(row.conId)) return blocked("in-trials");
  if (row.record === null || row.quote === null) return blocked("no-entry");
  if (row.figures === null || figuresSeq === null || figuresSeq !== state.computeSeq) return blocked("figures-not-current");
  if (row.figures.status === "refused") return blocked("refused");
  if (row.figures.status === "zero-contracts" || row.figures.contracts <= 0) return blocked("zero-contracts");
  if (trialCount >= TRIAL_POSITION_BOUNDS.maxPositions) return blocked("trial-limit");
  return null;
}

/** The broker contract ids of the trial list's options (F3). */
export function trialBrokerContractIds(list: readonly Pick<TrialPositionState, "position">[]): Set<number> {
  const out = new Set<number>();
  for (const t of list) if (t.position.kind === "option" && t.position.brokerContractId !== undefined) out.add(t.position.brokerContractId);
  return out;
}

export type PricedCandidateRow = Extract<CandidateRow, { status: "priced" }>;

/** P14, F2: the trial is the row's own record at the row's size; nothing looked up or solved again. */
export function candidateToTrial(
  row: CandidateRowState & { record: CandidateEntryRecord; quote: CandidateQuoteFields; figures: PricedCandidateRow },
  id: string,
): TrialPositionState {
  const e = row.record.entry;
  if (e.position.kind !== "option") throw new Error("a candidate entry is always an option");
  const q = row.quote;
  const quote: TrialQuote = {
    tickKind: q.tickKind,
    session: q.session,
    bid: q.bid,
    ask: q.ask,
    mid: q.mid,
    underlyingLast: q.underlyingPrice,
    fetchedAt: q.optionObservedAt,
  };
  return {
    position: { ...e.position, id, contracts: row.figures.contracts },
    symbol: e.symbol,
    name: e.name,
    holdingsAtAddByAccount: e.holdingsAtAddByAccount,
    priceSource: "quote-mid",
    quote,
    staleCloseDate: e.staleCloseDate,
    underlyingPrice: e.underlyingPrice,
    underlyingPriceDate: e.underlyingPriceDate,
    underlyingPriceSource: "client-quote",
    appValuation: row.record.appValuation,
  };
}

// ─── Sorting (P22: no default order, no ranking) ────────────────

export type CandidateSortKey = "none" | "cost" | "contracts" | "atSelected" | "atZero" | "crossing" | "costShare";

/** The sort select, "none" first. Every option is low to high: a column, never a verdict. */
export const CANDIDATE_SORT_OPTIONS: readonly { key: CandidateSortKey; label: string }[] = Object.freeze([
  { key: "none", label: "none (as pulled)" },
  { key: "cost", label: "Cost, low to high" },
  { key: "contracts", label: "Contracts, low to high" },
  { key: "atSelected", label: "At the selected move, low to high" },
  { key: "atZero", label: "At 0%, low to high" },
  { key: "crossing", label: "Pays once, nearest first" },
  { key: "costShare", label: "Cost share of the gain, low to high" },
]);

export function isCandidateSortKey(x: string): x is CandidateSortKey {
  return CANDIDATE_SORT_OPTIONS.some((o) => o.key === x);
}

/** A row's figures count only when it was computed from a quote and an entry. */
function pricedFigures(r: CandidateRowState): PricedCandidateRow | null {
  const f = r.figures;
  return f !== null && f.status === "priced" && r.quote !== null && r.record !== null ? f : null;
}

/**
 * [group, value]: group 0 sorts by value; group 1 has figures but no number
 * for this column (a worded crossing, a blank share) and keeps its tie order
 * by the change at the selected move; group 2 has no figures (always last).
 */
function sortKeyOf(
  r: CandidateRowState,
  key: Exclude<CandidateSortKey, "none">,
  caseKey: GainsAtRiskCaseKey,
  yearGain: YearGainResult | null,
): [0 | 1 | 2, number] {
  const f = pricedFigures(r);
  if (f === null) return [2, 0];
  const c = f.engine.cases?.[caseKey] ?? null;
  const atSelected = c ? c.atSelectedMoveUsd : 0;
  switch (key) {
    case "cost":
      return [0, f.costUsd];
    case "contracts":
      return [0, f.contracts];
    case "atSelected":
      return c ? [0, c.atSelectedMoveUsd] : [1, 0];
    case "atZero":
      return c ? [0, c.atZeroMoveUsd] : [1, atSelected];
    case "crossing":
      if (c === null) return [1, 0];
      if (c.crossing.kind === "better-at-every-move") return [0, 0];
      if (c.crossing.kind === "pays-beyond") return [0, Math.abs(c.crossing.move)];
      return [1, atSelected];
    case "costShare": {
      const share = yearGain ? candidateCostShareOfGain(f.costUsd, yearGain) : null;
      return share === null || !Number.isFinite(share) ? [1, 0] : [0, share];
    }
  }
}

/**
 * P22: request order until a column is picked ("none" returns the rows as
 * they are). Under a picked column, rows with no figures sort last; rows with
 * figures but no number for that column come after the numbered ones; ties
 * keep request order. Stable; the input is untouched.
 */
export function sortCandidateRows(
  rows: readonly CandidateRowState[],
  key: CandidateSortKey,
  caseKey: GainsAtRiskCaseKey,
  yearGain: YearGainResult | null = null,
): CandidateRowState[] {
  if (key === "none") return [...rows];
  const indexed = rows.map((r, i) => ({ r, i, k: sortKeyOf(r, key, caseKey, yearGain) }));
  indexed.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i);
  return indexed.map((x) => x.r);
}

// ─── One row's cells ────────────────────────────────────────────

export type CandidateCells =
  | { kind: "no-quote"; text: string }
  | { kind: "waiting"; perContractUsd: number | null }
  | { kind: "zero-contracts"; perContractUsd: number; text: string }
  | { kind: "refused"; perContractUsd: number; contracts: number; text: string }
  | {
      kind: "priced";
      perContractUsd: number;
      contracts: number;
      capped: boolean;
      costUsd: number;
      atSelectedUsd: number | null;
      atZeroUsd: number | null;
      crossingText: string | null;
      costShare: ReturnType<typeof candidateCostShareCell>;
      heldUnchangedText: string | null;
    };

/** The quote's price per contract (mid x 100) in exact units (D9); null when off the grid. */
export function perContractUsdOf(q: Pick<CandidateQuoteFields, "bid" | "ask">): number | null {
  const bid = toMoneyUnits(q.bid);
  const ask = toMoneyUnits(q.ask);
  return bid === null || ask === null ? null : unitsToUsd((bid + ask) * 50);
}

/** What a row's figure cells hold, for the case on screen. */
export function candidateCells(
  r: CandidateRowState,
  caseKey: GainsAtRiskCaseKey,
  yearGain: YearGainResult,
  driverSymbol: string,
): CandidateCells {
  if (r.quote === null) return { kind: "no-quote", text: r.quoteProblem ?? "Quoting…" };
  const f = r.record === null ? null : r.figures;
  if (f === null) return { kind: "waiting", perContractUsd: r.record ? perContractUsdOf(r.quote) : null };
  if (f.status === "zero-contracts") return { kind: "zero-contracts", perContractUsd: f.perContractUsd, text: ZERO_CONTRACTS_TEXT };
  if (f.status === "refused") {
    return { kind: "refused", perContractUsd: f.perContractUsd, contracts: f.contracts, text: candidateRefusalText(f.refusal, r.symbol) };
  }
  const c = f.engine.cases?.[caseKey] ?? null;
  return {
    kind: "priced",
    perContractUsd: f.perContractUsd,
    contracts: f.contracts,
    capped: f.capped,
    costUsd: f.costUsd,
    atSelectedUsd: c ? c.atSelectedMoveUsd : null,
    atZeroUsd: c ? c.atZeroMoveUsd : null,
    crossingText: c ? candidateCrossingText(c, driverSymbol) : null,
    costShare: candidateCostShareCell(f.costUsd, yearGain),
    heldUnchangedText: c && c.heldUnchanged ? heldUnchangedNote(f.engine.symbol || r.symbol) : null,
  };
}

/** "10,000,000" (a bound, not a portfolio figure). */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** How many contracts are chosen, out of the bound. */
export function chosenCountText(n: number): string {
  return `${n} of at most ${CANDIDATE_BOUNDS.maxContractsPerPull} contracts selected.`;
}

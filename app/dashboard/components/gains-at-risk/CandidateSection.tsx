"use client";

import { useEffect, useRef, useState } from "react";
import apiFetch from "@/lib/http/apiFetch";
import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import {
  CANDIDATES_BUYING_ONLY_NOTE,
  CANDIDATES_CONNECT_TEXT,
  CANDIDATES_DISCONNECTED_NOTE,
  CANDIDATES_NOT_STORED_NOTE,
  CANDIDATES_SECTION_TITLE,
  candidateAddBlocked,
  candidateRequestItems,
  candidateToTrial,
  candidatesBaseBody,
  chosenBatchContracts,
  crossingHeading,
  defaultCandidateUnderlying,
  driverNotListedNote,
  headingDirection,
  parseBudgetText,
  pullProblem,
  refreshBatches,
  rowBatchContract,
  type CandidateRowState,
} from "@/lib/analysis/gains-at-risk-candidates-view";
import { newTrialId, trialRequestPositions } from "@/lib/analysis/gains-at-risk-trial-view";
// Types only: no engine, query or broker code reaches the browser.
import type {
  BatchContractRequest,
  CandidatesBody,
  CandidatesResponse,
  ChainBody,
  ChainResponse,
  QuotesBody,
  QuotesResponse,
} from "@/lib/analysis/gains-at-risk-candidates-input";
import type { GainsControls } from "@/lib/analysis/gains-at-risk-view";
import type { AnalysisScope } from "@/lib/analysis/view-param";
import type { GainsAtRiskCaseKey } from "@/lib/compute/gains-at-risk";
import type { CandidateUnderlyingEntry } from "@/lib/compute/gains-at-risk-drivers";
import type { YearGainResult } from "@/lib/compute/year-gain";
import { CHIP_TONE_TEXT } from "../chip-tone-text";
import { useCandidates } from "./CandidatesProvider";
import { CandidatePicker } from "./CandidatePicker";
import { CandidateTable } from "./CandidateTable";
import { useTrialPositions } from "./TrialPositionsProvider";

const CHAIN_ROUTE = "/api/tws/option-candidates/chain";
const QUOTES_ROUTE = "/api/tws/option-candidates/quotes";
const COMPUTE_ROUTE = "/api/compute/gains-at-risk/candidates";

const buttonClass =
  "px-2 py-1 rounded-md border border-edge text-xs text-ink-dim hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Compare options (step 3): the candidate section below the trial list,
 * collapsed by default. State lives in the unkeyed CandidatesProvider (F1);
 * this component is inside the scope-keyed view, so a scope change remounts
 * it and its first effect clears the figures and asks again for the new
 * scope. It sends the four requests (chain expiries, chain strikes, quotes,
 * compute) and hands every reply to the reducer, which drops what is no
 * longer wanted (D8, P15). Nothing is stored; nothing is retried by itself.
 */
export function CandidateSection({
  scope,
  controls,
  selectedMove,
  caseKey,
  yearGain,
  underlyings,
}: {
  scope: AnalysisScope;
  controls: GainsControls;
  selectedMove: number;
  /** The case on screen (index mode: the switch; single-name mode: the one case). */
  caseKey: GainsAtRiskCaseKey;
  yearGain: YearGainResult;
  /** F8: the server-built list of names with a broker contract on file. */
  underlyings: CandidateUnderlyingEntry[];
}) {
  const { available, state, dispatch, nextId } = useCandidates();
  const trials = useTrialPositions();
  // The latest state, for a refresh that runs across several replies.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState(state.budgetUsdText);
  // The clock for "old quote" (P15): ticks while the section is open.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!state.open) return;
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, [state.open]);

  // ── P15 / F1: the inputs on screen. A change (a scope remount included) clears every row's figures. ──
  const base = candidatesBaseBody({ scope, controls, selectedMove, trialPositions: trialRequestPositions(trials.list) });
  const inputsKey = JSON.stringify(base);
  useEffect(() => {
    dispatch({ type: "inputs-changed", key: inputsKey });
  }, [inputsKey, dispatch]);

  const budget = parseBudgetText(state.budgetUsdText);

  // ── The compute (call 2): one request per compute-input revision, only while open. ──
  useEffect(() => {
    if (!state.open || base === null || !("usd" in budget)) return;
    if (state.figuresSeq === state.computeSeq) return;
    const candidates = candidateRequestItems(state.rows);
    if (candidates.length === 0) return;
    const seq = state.computeSeq;
    const body: CandidatesBody = { ...base, budgetUsd: budget.usd, candidates };
    dispatch({ type: "compute-request", seq });
    void (async () => {
      try {
        const res = await apiFetch(COMPUTE_ROUTE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const r = await readMutationResult<{ data: CandidatesResponse }>(res);
        if (!r.ok) {
          dispatch({ type: "compute-failure", seq, message: r.message });
          return;
        }
        dispatch({ type: "compute-reply", seq, reply: r.data.data });
      } catch {
        dispatch({ type: "compute-failure", seq, message: networkFailureMessage("compute the candidates") });
      }
    })();
    // The seq names every input: the body above is the one for this render's seq.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.computeSeq, state.open]);

  if (!available) return null;

  const driverSymbol = controls.driver.kind === "single-name" ? controls.driver.entry.symbol : controls.driverSymbol;
  const listed = state.underlyingSecurityId !== null && underlyings.some((u) => u.securityId === state.underlyingSecurityId);
  const pickerUnderlying = listed ? state.underlyingSecurityId : null;
  const symbolOf = (id: number) => underlyings.find((u) => u.securityId === id)?.symbol ?? "";
  const canAskBroker = connected === true && !busy;

  async function checkConnected(): Promise<boolean> {
    try {
      const r = await readMutationResult<{ data: { state?: string } }>(await apiFetch("/api/tws/status"));
      const ok = r.ok && r.data.data?.state === "connected";
      setConnected(ok);
      return ok;
    } catch {
      setConnected(false);
      return false;
    }
  }

  async function fetchChain(underlyingSecurityId: number, right: "put" | "call", expiries?: string[]) {
    const revision = nextId();
    dispatch({ type: "chain-request", revision, ...(expiries ? { expiries } : {}) });
    const body: ChainBody = { underlyingSecurityId, right, ...(expiries ? { expiries } : {}) };
    try {
      const res = await apiFetch(CHAIN_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const r = await readMutationResult<{ data: ChainResponse }>(res);
      if (!r.ok) {
        dispatch({ type: "chain-failure", revision, message: r.message });
        return;
      }
      dispatch({ type: "chain-reply", revision, underlyingSecurityId, right, reply: r.data.data });
    } catch {
      dispatch({ type: "chain-failure", revision, message: networkFailureMessage("fetch the option chain") });
    }
  }

  async function openSection() {
    dispatch({ type: "open" });
    let u = pickerUnderlying;
    if (u === null) {
      u = defaultCandidateUnderlying(underlyings, controls.driver, controls.driverSymbol);
      if (u !== null) dispatch({ type: "set-underlying", securityId: u });
    }
    const ok = await checkConnected();
    if (ok && u !== null && (stateRef.current.expiries === null || u !== state.underlyingSecurityId)) {
      void fetchChain(u, stateRef.current.right);
    }
  }

  function pickUnderlying(id: number) {
    dispatch({ type: "set-underlying", securityId: id });
    if (connected) void fetchChain(id, state.right);
  }

  function pickRight(right: "put" | "call") {
    dispatch({ type: "set-right", right });
    if (connected && pickerUnderlying !== null) void fetchChain(pickerUnderlying, right);
  }

  function showStrikes() {
    if (pickerUnderlying === null || state.chosenExpiries.length === 0) return;
    void fetchChain(pickerUnderlying, state.right, state.chosenExpiries);
  }

  /** One quotes call (call 1). True when the pull was answered; false on a whole-pull refusal. */
  async function runPull(
    mode: "pull" | "refresh",
    underlyingSecurityId: number,
    symbol: string,
    contracts: BatchContractRequest[],
  ): Promise<boolean> {
    const pullId = nextId();
    dispatch({ type: "quotes-request", mode, pullId, underlyingSecurityId, symbol, contracts });
    const conIds = contracts.map((c) => c.conId);
    const body: QuotesBody = { underlyingSecurityId, contracts };
    try {
      const res = await apiFetch(QUOTES_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const r = await readMutationResult<{ data: QuotesResponse }>(res);
      if (!r.ok) {
        // P16: whole-pull refusals carry their own sentence (sync running, broker busy, rate limit).
        if (r.status === 503 && r.message === CANDIDATES_CONNECT_TEXT) setConnected(false);
        dispatch({ type: "quotes-failure", pullId, conIds, message: r.message });
        return false;
      }
      dispatch({ type: "quotes-reply", pullId, underlyingSecurityId, reply: r.data.data });
      return true;
    } catch {
      dispatch({ type: "quotes-failure", pullId, conIds, message: networkFailureMessage("fetch the quotes") });
      return false;
    }
  }

  async function getQuotes() {
    if (pickerUnderlying === null) return;
    const contracts = chosenBatchContracts(state);
    if (contracts.length === 0 || pullProblem(state.rows, contracts.map((c) => c.conId)) !== null) return;
    setBusy(true);
    try {
      await runPull("pull", pickerUnderlying, symbolOf(pickerUnderlying), contracts);
    } finally {
      setBusy(false);
    }
  }

  /** D4: the table's rows by underlying, at most 15 per call, one call after another. */
  async function refreshQuotes() {
    const batches = refreshBatches(stateRef.current.rows);
    setBusy(true);
    try {
      for (const b of batches) {
        // Closed or cleared meanwhile: stop; nothing more is asked.
        if (!stateRef.current.open) break;
        // Built from the rows as they stand now: a row removed meanwhile is not asked again.
        const rows = stateRef.current.rows.filter((r) => b.conIds.includes(r.conId));
        if (rows.length === 0) continue;
        const ok = await runPull("refresh", b.underlyingSecurityId, rows[0].symbol, rows.map(rowBatchContract));
        if (!ok) break;
      }
    } finally {
      setBusy(false);
    }
  }

  function commitBudget() {
    if (budgetDraft === state.budgetUsdText) return;
    dispatch({ type: "budget", text: budgetDraft });
  }

  function addRow(row: CandidateRowState) {
    if (candidateAddBlocked(row, state, state.figuresSeq, trials.list.length) !== null) return;
    if (row.record === null || row.quote === null || row.figures === null || row.figures.status !== "priced") return;
    trials.add(candidateToTrial({ ...row, record: row.record, quote: row.quote, figures: row.figures }, newTrialId()));
  }

  const notListed = driverNotListedNote(underlyings, controls.driver);
  const pullBlocked = pullProblem(state.rows, state.chosenConIds);

  return (
    <section className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-3" aria-label={CANDIDATES_SECTION_TITLE}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink whitespace-nowrap!">{CANDIDATES_SECTION_TITLE}</h3>
        <button
          type="button"
          aria-expanded={state.open}
          onClick={() => (state.open ? dispatch({ type: "close" }) : void openSection())}
          className={buttonClass}
        >
          {state.open ? "Hide" : "Show"}
        </button>
      </div>

      {state.open && (
        <>
          <p className="text-xs text-ink-faint">{CANDIDATES_BUYING_ONLY_NOTE}</p>
          {notListed && <p className="text-xs text-ink-dim">{notListed}</p>}
          {connected === false && (
            <p className={`text-xs ${CHIP_TONE_TEXT.warn}`}>
              {CANDIDATES_CONNECT_TEXT} {CANDIDATES_DISCONNECTED_NOTE}
            </p>
          )}

          <CandidatePicker
            underlyings={underlyings}
            underlyingSecurityId={pickerUnderlying}
            state={state}
            canAskBroker={canAskBroker}
            disconnected={connected === false}
            pullBlockedText={pullBlocked}
            onUnderlying={pickUnderlying}
            onRight={pickRight}
            onExpiries={(expiries) => dispatch({ type: "choose-expiries", expiries })}
            onShowStrikes={showStrikes}
            onChoose={(conIds) => dispatch({ type: "choose", conIds })}
            onGetQuotes={() => void getQuotes()}
          />
          {state.pullProblem && <p className={`text-xs ${CHIP_TONE_TEXT.warn}`}>{state.pullProblem}</p>}

          <CandidateTable
            state={state}
            budgetDraft={budgetDraft}
            budgetProblem={"problem" in budget ? budget.problem : null}
            onBudgetDraft={setBudgetDraft}
            onBudgetCommit={commitBudget}
            selectedMove={selectedMove}
            crossingHeadingText={crossingHeading(headingDirection(controls.driver, selectedMove), driverSymbol)}
            driverSymbol={driverSymbol}
            caseKey={caseKey}
            yearGain={yearGain}
            trialCount={trials.list.length}
            now={now}
            onAdd={addRow}
            onRemove={(conId) => dispatch({ type: "remove", conId })}
          />

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!canAskBroker || state.rows.length === 0}
              onClick={() => void refreshQuotes()}
              className={buttonClass}
            >
              Refresh quotes
            </button>
            <button
              type="button"
              disabled={state.rows.length === 0}
              onClick={() => dispatch({ type: "clear" })}
              className={buttonClass}
            >
              Clear
            </button>
            {connected === false && <span className="text-xs text-ink-faint">{CANDIDATES_CONNECT_TEXT}</span>}
          </div>
          <p className="text-xs text-ink-faint">{CANDIDATES_NOT_STORED_NOTE}</p>
        </>
      )}
    </section>
  );
}

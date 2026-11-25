"use client";

import { useEffect, useState } from "react";
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
  candidatesComputeBody,
  candidatesInputsKey,
  chosenBatchContracts,
  crossingHeading,
  defaultCandidateUnderlying,
  driverNotListedNote,
  headingDirection,
  parseBudgetText,
  pullProblem,
  refreshBatches,
  rowBatchContract,
  trialBrokerContractIds,
  type CandidateRowState,
} from "@/lib/analysis/gains-at-risk-candidates-view";
import { gainsAtRiskRequestBody, type GainsControls } from "@/lib/analysis/gains-at-risk-view";
import { newTrialId, trialRequestPositions } from "@/lib/analysis/gains-at-risk-trial-view";
// Types only: no engine, query or broker code reaches the browser.
import type {
  BatchContractRequest,
  CandidatesResponse,
  ChainBody,
  ChainResponse,
  QuotesBody,
  QuotesResponse,
} from "@/lib/analysis/gains-at-risk-candidates-input";
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
 * longer wanted (D8, P15). A broker request is sent only after the reducer
 * accepted its request action. Nothing is stored; nothing is retried by
 * itself, and the connection is never polled on a timer.
 */
export function CandidateSection({
  scope,
  controls,
  selectedMove,
  caseKey,
  yearGain,
  underlyings,
  today,
  latestDate,
  bookRevision,
}: {
  scope: AnalysisScope;
  controls: GainsControls;
  selectedMove: number;
  /** The case on screen (index mode: the switch; single-name mode: the one case). */
  caseKey: GainsAtRiskCaseKey;
  yearGain: YearGainResult;
  /** F8: the server-built list of names with a broker contract on file. */
  underlyings: CandidateUnderlyingEntry[];
  today: string;
  latestDate: string;
  /** Bumped when fresh server props arrive (a sync): the same controls then answer a new book. */
  bookRevision: number;
}) {
  const { available, state, act, current, nextId } = useCandidates();
  const trials = useTrialPositions();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState(state.budgetUsdText);
  // The clock for "old quote" (P15): set when the section opens, then every 30 seconds while open.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!state.open) return;
    const first = setTimeout(() => setNow(new Date()), 0);
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [state.open]);

  // ── P15 / F1: the inputs on screen, through the page's ONE body builder. A change clears every row's figures. ──
  const built = gainsAtRiskRequestBody({
    scope,
    controls,
    selectedMove,
    trialPositions: trialRequestPositions(trials.list),
    today,
    latestDate,
  });
  const inputsKey = candidatesInputsKey(built, selectedMove, bookRevision);
  useEffect(() => {
    act({ type: "inputs-changed", key: inputsKey });
  }, [inputsKey, act]);

  const budget = parseBudgetText(state.budgetUsdText);

  // ── The compute (call 2): one request per compute-input revision, only while open. ──
  useEffect(() => {
    if (!state.open || !built.ok || !("usd" in budget)) return;
    if (state.figuresSeq === state.computeSeq) return;
    const candidates = candidateRequestItems(state.rows);
    if (candidates.length === 0) return;
    const body = candidatesComputeBody(built.body, selectedMove, budget.usd, candidates);
    if (body === null) return;
    const seq = state.computeSeq;
    if (!act({ type: "compute-request", seq })) return;
    void (async () => {
      try {
        const res = await apiFetch(COMPUTE_ROUTE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const r = await readMutationResult<{ data: CandidatesResponse }>(res);
        if (!r.ok) {
          act({ type: "compute-failure", seq, message: r.message });
          return;
        }
        act({ type: "compute-reply", seq, reply: r.data.data });
      } catch {
        act({ type: "compute-failure", seq, message: networkFailureMessage("compute the candidates") });
      }
    })();
    // The seq names every input: the body above is the one for this render's seq.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.computeSeq, state.open]);

  // Mounted already open (a scope change): ask whether the broker is connected, and fetch the chain if needed.
  useEffect(() => {
    if (current().open) void connectAndFetch(current().underlyingSecurityId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!available) return null;

  const driverSymbol = controls.driver.kind === "single-name" ? controls.driver.entry.symbol : controls.driverSymbol;
  const isListed = (id: number | null) => id !== null && underlyings.some((u) => u.securityId === id);
  const pickerUnderlying = isListed(state.underlyingSecurityId) ? state.underlyingSecurityId : null;
  const symbolOf = (id: number) => underlyings.find((u) => u.securityId === id)?.symbol ?? "";
  const canAskBroker = connected === true && !busy;
  const inTrials = trialBrokerContractIds(trials.list);

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

  /** Checks the connection, then fetches the expiries when the picker has none for its name. */
  async function connectAndFetch(underlying: number | null) {
    const ok = await checkConnected();
    const s = current();
    if (ok && s.open && underlying !== null && isListed(underlying) && s.expiries === null && !s.chainPending) {
      void fetchChain(underlying, s.right);
    }
  }

  async function fetchChain(underlyingSecurityId: number, right: "put" | "call", expiries?: string[]) {
    const revision = nextId();
    if (!act({ type: "chain-request", revision, ...(expiries ? { expiries } : {}) })) return;
    const body: ChainBody = { underlyingSecurityId, right, ...(expiries ? { expiries } : {}) };
    try {
      const res = await apiFetch(CHAIN_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const r = await readMutationResult<{ data: ChainResponse }>(res);
      if (!r.ok) {
        if (r.status === 503) setConnected(false);
        act({ type: "chain-failure", revision, message: r.message });
        return;
      }
      act({ type: "chain-reply", revision, underlyingSecurityId, right, reply: r.data.data });
    } catch {
      act({ type: "chain-failure", revision, message: networkFailureMessage("fetch the option chain") });
    }
  }

  function openSection() {
    act({ type: "open" });
    let u = pickerUnderlying;
    if (u === null) {
      u = defaultCandidateUnderlying(underlyings, controls.driver, controls.driverSymbol);
      if (u !== null) act({ type: "set-underlying", securityId: u });
    }
    void connectAndFetch(u);
  }

  function pickUnderlying(id: number) {
    act({ type: "set-underlying", securityId: id });
    if (connected) void fetchChain(id, current().right);
  }

  function pickRight(right: "put" | "call") {
    act({ type: "set-right", right });
    if (connected && pickerUnderlying !== null) void fetchChain(pickerUnderlying, right);
  }

  function showStrikes() {
    if (pickerUnderlying === null || state.chosenExpiries.length === 0) return;
    void fetchChain(pickerUnderlying, state.right, state.chosenExpiries);
  }

  /** One quotes call (call 1): "sent" when answered, "refused" on a whole-pull refusal, "skipped" when nothing was sent. */
  async function runPull(
    mode: "pull" | "refresh",
    underlyingSecurityId: number,
    symbol: string,
    contracts: BatchContractRequest[],
  ): Promise<"sent" | "refused" | "skipped"> {
    const pullId = nextId();
    // Item 7: the reducer refused (a closed section, a refresh naming a removed row): nothing is sent.
    if (!act({ type: "quotes-request", mode, pullId, underlyingSecurityId, symbol, contracts })) return "skipped";
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
        act({ type: "quotes-failure", pullId, conIds, message: r.message });
        return "refused";
      }
      act({ type: "quotes-reply", pullId, underlyingSecurityId, reply: r.data.data });
      return "sent";
    } catch {
      act({ type: "quotes-failure", pullId, conIds, message: networkFailureMessage("fetch the quotes") });
      return "refused";
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
    const batches = refreshBatches(current().rows);
    setBusy(true);
    try {
      for (const b of batches) {
        const s = current();
        // Closed, or every row gone (cleared): stop; nothing more is asked.
        if (!s.open || s.rows.length === 0) break;
        // Built from the rows as they stand now: a row removed meanwhile is not asked again.
        const rows = s.rows.filter((r) => b.conIds.includes(r.conId));
        if (rows.length === 0) continue;
        const outcome = await runPull("refresh", b.underlyingSecurityId, rows[0].symbol, rows.map(rowBatchContract));
        if (outcome === "refused") break;
      }
    } finally {
      setBusy(false);
    }
  }

  function commitBudget() {
    if (budgetDraft === state.budgetUsdText) return;
    act({ type: "budget", text: budgetDraft });
  }

  function addRow(row: CandidateRowState) {
    if (candidateAddBlocked(row, state, state.figuresSeq, trials.list.length, inTrials) !== null) return;
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
          onClick={() => (state.open ? act({ type: "close" }) : openSection())}
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
            <div className="flex flex-wrap items-center gap-2">
              <p className={`text-xs ${CHIP_TONE_TEXT.warn}`}>
                {CANDIDATES_CONNECT_TEXT} {CANDIDATES_DISCONNECTED_NOTE}
              </p>
              <button type="button" onClick={() => void connectAndFetch(pickerUnderlying)} className={buttonClass}>
                Check again
              </button>
            </div>
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
            onExpiries={(expiries) => act({ type: "choose-expiries", expiries })}
            onShowStrikes={showStrikes}
            onChoose={(conIds) => act({ type: "choose", conIds })}
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
            inTrials={inTrials}
            now={now}
            onAdd={addRow}
            onRemove={(conId) => act({ type: "remove", conId })}
            onRetryCompute={() => act({ type: "compute-retry" })}
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
              onClick={() => act({ type: "clear" })}
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

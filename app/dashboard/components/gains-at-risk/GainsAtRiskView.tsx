"use client";

import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import apiFetch from "@/lib/http/apiFetch";
import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import { useSortParam } from "@/lib/hooks/useSortParam";
import { Count, Money, Pct, PrivateNumberInput, PrivateText } from "@/lib/privacy/components";
import {
  formatPositionsDate,
  positionsFreshnessCell,
  type PositionsFreshnessCell,
} from "@/lib/ui/positions-freshness-label";
import {
  GAINS_AT_RISK_VOL_MAX,
  GAINS_AT_RISK_VOL_MIN,
  trialPositionSecurityId,
  type GainsAtRiskDriver,
  type GainsAtRiskResponse,
} from "@/lib/analysis/gains-at-risk-input";
import {
  DRIVER_NOT_LISTED_SENTENCE,
  type SingleNameDriversBody,
  type SingleNameDriversResponse,
} from "@/lib/analysis/gains-at-risk-candidates-input";
import type { AnalysisScope } from "@/lib/analysis/view-param";
import { BETA_OVERRIDE_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import {
  BETA_OVERRIDE_REFUSAL_LABELS,
  BOOK_GAINS_TEXT,
  CASE_KEYS,
  CASE_LABELS,
  CASE_NOTES,
  CHART_GAP_NOTE,
  COLUMN_LABELS,
  DEFAULT_CASE,
  DOWN_ONLY_NOTE,
  LEVERAGED_FIGURE_HINT,
  NO_VOLATILITY_PRICE_TEXT,
  OVERRIDE_REFUSAL_LABELS,
  PRICE_SOURCE_LABELS,
  DEFAULT_POSITION_SORT,
  GAINS_SORT_SCOPE,
  SAME_PRICE_TEXT,
  TABLE_MOVES,
  UNDER_TENTH_TEXT,
  YEAR_GAIN_LABEL,
  ZERO_ROW_NOTE,
  DRIVERS_REFRESH_FAILED_TEXT,
  FIGURES_KEPT_NOTE,
  HELD_UNCHANGED_NOTE,
  mountDriver,
  nothingMovesNote,
  resultLayout,
  serverPropsAnswerControls,
  SINGLE_NAME_CHART_NOTE,
  caseOnScreen,
  customMoveBoundsPct,
  customMoveProblemFor,
  defaultSelectedMoveFor,
  driverDroppedText,
  gainsAtRiskRequestBody,
  leveragedNotLinkedText,
  moveDirection,
  GAINS_ANCHORS,
  pageGuideLines,
  rowSideAt,
  sameDriverIn,
  singleNameHeadline,
  singleNameMovesNote,
  singleNameRowCells,
  singleNameVolNote,
  switchDriver,
  tableMovesFor,
  tableRowMoves,
  uniqueSortedIds,
  type DriverChoice,
  betaEvidenceCaption,
  betaOverrideProblem,
  betaSourceLine,
  disclosureSentences,
  disclosureShare,
  formatBeta,
  formatDriverMove,
  gainGivenBackShare,
  gainsRequestReducer,
  givenBackCell,
  initialGainsRequestState,
  betaEditorNote,
  isLeveragedFundRow,
  isGainsSortKey,
  isPriceEditable,
  moneyCell,
  noMeasuredLinkSentence,
  overridesIgnoredLine,
  positionSortNote,
  nameRowKey,
  nameTableEditorOwnership,
  nameTableRows,
  sameFigureTextAt,
  serverPropsAction,
  sortPositions,
  priceBoxOwners,
  reconciliationLine,
  requestFailureText,
  sameMove,
  scopeFreshnessCell,
  yearGainNote,
  type GainsControls,
  type GainsSortKey,
  type NameTableRow,
} from "@/lib/analysis/gains-at-risk-view";
import {
  TRIAL_CHART_NOTE,
  TRIAL_EMPTY_BOOK_NOTE,
  TRIAL_GIVEN_BACK_ARROW,
  TRIAL_TABLE_LABELS,
  crossingSentence,
  noMoveCostSentence,
  trialName,
  trialRefusalNote,
  trialRequestPositions,
  trialTableRow,
} from "@/lib/analysis/gains-at-risk-trial-view";
// Types only: no engine or query code reaches the browser.
import type {
  GainsAtRiskBetaOverrideRefusal,
  GainsAtRiskCaseKey,
  GainsAtRiskResult,
} from "@/lib/compute/gains-at-risk";
import type { SingleNameDriverEntry } from "@/lib/compute/gains-at-risk-drivers";
import { Chip, type ChipTone } from "../Chip";
import { CHIP_TONE_TEXT } from "../chip-tone-text";
import { EmptySection } from "../EmptySection";
import { ScrollFade } from "../ScrollFade";
import { SortableHeader } from "../SortableHeader";
import { DriverControl } from "./DriverControl";
import { useDriverChoice } from "./DriverChoiceProvider";
import { GainsAtRiskChart } from "./GainsAtRiskChart";
import { TrialPositionsPanel } from "./TrialPositionList";
import { CandidateSection } from "./CandidateSection";
import { useTrialPositions, type TrialPositionsValue } from "./TrialPositionsProvider";

const SCOPE_PILLS: { key: AnalysisScope; label: string }[] = [
  { key: "all", label: "All accounts" },
  { key: "vanguard", label: "Vanguard" },
  { key: "ibkr", label: "IBKR" },
  { key: "roth", label: "Roth" },
];

export interface GainsAtRiskInitialInputs {
  driverSymbol: GainsAtRiskDriver;
  valuationDate: string;
  volChangePoints: number;
  selectedMove: number;
}

/**
 * How the figures on screen relate to the controls:
 * - "fresh": they answer the controls;
 * - "stale": a request is running; the last answer stays, dimmed and marked
 *   out of date, so the tables and their boxes stay mounted;
 * - "failed": the request failed; the layout stays, every figure is blanked
 *   and the error sentence stands in their place.
 */
type FigureMode = "fresh" | "stale" | "failed";

const STALE_TEXT = "Computing… The figures below are from the previous settings.";

const FRESHNESS_TONE: Record<PositionsFreshnessCell["tone"], ChipTone> = {
  good: "up",
  warn: "warn",
  bad: "down",
  neutral: "neutral",
};

function FreshnessChip({ cell, label }: { cell: PositionsFreshnessCell; label: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" title={cell.hint}>
      <span className="text-xs text-ink-faint">{label}</span>
      <Chip tone={FRESHNESS_TONE[cell.tone]} size="xs" wrap>
        {cell.dateText}
        {cell.countText ? (
          <>
            {" · "}
            <PrivateText>{cell.countText}</PrivateText>
          </>
        ) : null}
      </Chip>
    </span>
  );
}

const onEnterBlur = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") e.currentTarget.blur();
};

function withoutKey<T>(obj: Record<number, T>, key: number): Record<number, T> {
  const rest = { ...obj };
  delete rest[key];
  return rest;
}

export function GainsAtRiskView({
  scope,
  scopeHasAccounts,
  today,
  latestDate,
  initial,
  initialDriverLists,
  initialInputs,
}: {
  scope: AnalysisScope;
  scopeHasAccounts: boolean;
  today: string;
  latestDate: string;
  initial: GainsAtRiskResponse;
  /** Step 3: the single-name driver list and the candidate underlyings, built with no trial positions; null when they could not be built. */
  initialDriverLists: SingleNameDriversResponse | null;
  initialInputs: GainsAtRiskInitialInputs;
}) {
  // Trial positions live in the unkeyed provider above this keyed view (R5).
  const trials = useTrialPositions();
  const trialsRef = useRef<TrialPositionsValue>(trials);
  // Step 3: the driver choice survives a scope change (an unkeyed provider, like the trial list).
  const driverMemory = useDriverChoice();
  // Step 3 (S6 fix 1): bumped whenever fresh server props arrive (a sync), so the candidate table recomputes too.
  const [bookRevision, setBookRevision] = useState(0);
  const [mount] = useState(() =>
    mountDriver(driverMemory.get(), initialInputs.driverSymbol, initialDriverLists?.drivers ?? null, trials.list.length > 0),
  );
  const mountControls: GainsControls = {
    driverSymbol: mount.driverSymbol,
    driver: mount.driver,
    valuationDate: initialInputs.valuationDate,
    volChangePoints: initialInputs.volChangePoints,
    custom: null,
    priceOverrides: {},
    betaOverrides: {},
  };
  // A remembered driver the first paint did not compute: asked at once on mount
  // (until then the first paint is drawn in its own layout, dimmed, with no headline).
  const driverPendingAtMount = !serverPropsAnswerControls(mountControls, initialInputs);
  // P7: with trial positions already on the page, start pending; the first paint is layout only.
  const [state, dispatch] = useReducer(gainsRequestReducer, initial, (d: GainsAtRiskResponse) =>
    initialGainsRequestState(d, { hasTrials: trials.list.length > 0, trialVersion: trials.version }),
  );
  const seqRef = useRef(0);

  const [controls, setControlsState] = useState<GainsControls>(() => ({
    driverSymbol: mount.driverSymbol,
    driver: mount.driver,
    valuationDate: initialInputs.valuationDate,
    volChangePoints: initialInputs.volChangePoints,
    custom: null,
    priceOverrides: {},
    betaOverrides: {},
  }));
  // The latest controls, for the refresh effect below (it must not read a stale closure).
  const controlsRef = useRef(controls);
  const [dateDraft, setDateDraft] = useState(initialInputs.valuationDate);
  const [volDraft, setVolDraft] = useState(String(initialInputs.volChangePoints));
  const [customDraft, setCustomDraft] = useState("");
  const [customProblem, setCustomProblem] = useState<string | null>(null);
  const mountSelected = mount.driver.kind === "single-name" ? defaultSelectedMoveFor("single-name") : initialInputs.selectedMove;
  const [selectedMove, setSelectedMoveState] = useState(mountSelected);
  // The latest selected move, for run(): in single-name mode it is sent (D5, the crossing's direction).
  const selectedMoveRef = useRef(mountSelected);
  function setSelectedMove(m: number) {
    selectedMoveRef.current = m;
    setSelectedMoveState(m);
  }
  // Step 3: the server-built driver list; refreshed when the trial positions' underlyings change.
  const [driverLists, setDriverLists] = useState<SingleNameDriversResponse>(
    initialDriverLists ?? { drivers: [], candidateUnderlyings: [] },
  );
  // The list could not be loaded: the index keeps working; the single-name choice offers a retry.
  const [driversFailed, setDriversFailed] = useState(initialDriverLists === null);
  const [driverNotice, setDriverNotice] = useState<string | null>(mount.notice);
  // Set when the compute route said the chosen name is not on its list: the fresh list decides (fallback, or ask again).
  const notListedRef = useRef(false);
  const [overrideDrafts, setOverrideDrafts] = useState<Record<number, string>>({});
  const [overrideProblems, setOverrideProblems] = useState<Record<number, string>>({});
  // The case on screen: both are in every answer, so switching asks nothing of the server.
  const [caseKey, setCaseKey] = useState<GainsAtRiskCaseKey>(DEFAULT_CASE);
  // The owner's figure per name, keyed by identitySecurityId (C6).
  const [betaDrafts, setBetaDrafts] = useState<Record<number, string>>({});
  const [betaProblems, setBetaProblems] = useState<Record<number, string>>({});

  async function run(next: GainsControls, selected: number = selectedMoveRef.current) {
    controlsRef.current = next;
    setControlsState(next);
    const seq = ++seqRef.current;
    // The trial positions as they stand now; the answer is shown only for this set.
    const trialNow = trialsRef.current;
    // Clear the shown result first: it answered other controls.
    dispatch({ type: "start", seq, trialVersion: trialNow.version });
    // The one body builder (shared with the candidate table): moves, custom row, date check, driver, figures, trials.
    const built = gainsAtRiskRequestBody({
      scope,
      controls: next,
      selectedMove: selected,
      trialPositions: trialRequestPositions(trialNow.list),
      today,
      latestDate,
    });
    if (!built.ok) {
      dispatch({ type: "failure", seq, message: built.message });
      return;
    }
    const body = built.body;
    try {
      const res = await apiFetch("/api/compute/gains-at-risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const r = await readMutationResult<{ data: GainsAtRiskResponse }>(res);
      if (!r.ok) {
        // The chosen name left the server's list (a trial on it was removed): no error flash;
        // the fresh list sends the page back to the index with its notice.
        if (r.status === 400 && r.message === DRIVER_NOT_LISTED_SENTENCE && next.driver.kind === "single-name") {
          notListedRef.current = true;
          refreshDrivers(trialIdsNow(), () =>
            dispatch({ type: "failure", seq, message: requestFailureText(r.status, r.message) }),
          );
          return;
        }
        dispatch({ type: "failure", seq, message: requestFailureText(r.status, r.message) });
        return;
      }
      dispatch({ type: "success", seq, data: r.data.data, trialVersion: trialNow.version });
    } catch {
      dispatch({ type: "failure", seq, message: networkFailureMessage("compute gains at risk") });
    }
  }

  // The latest trial positions for run() and the effects below. Declared
  // first, so it is current before any later effect in the same commit.
  useEffect(() => {
    trialsRef.current = trials;
  });

  // Fresh server props (a refresh after a sync or a saved note): they were
  // computed with the default controls and no trial positions. Take them only
  // when they answer the controls on screen and no trial position exists;
  // otherwise keep every control and ask again with them. Either way anything
  // still in flight is older and is dropped.
  const seenPropsRef = useRef(initial);
  useEffect(() => {
    if (seenPropsRef.current === initial) return;
    seenPropsRef.current = initial;
    setBookRevision((n) => n + 1);
    const hasTrials = trialsRef.current.list.length > 0;
    if (serverPropsAction(controlsRef.current, initialInputs, hasTrials) === "reset") {
      dispatch({ type: "reset", data: initial, hasTrials });
    } else {
      void run(controlsRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  // P7: mounted with trial positions (first paint, or a scope switch): ask with them at once.
  useEffect(() => {
    if (trialsRef.current.list.length > 0) void run(controlsRef.current);
    // Step 3: a remembered driver the first paint did not compute.
    else if (driverPendingAtMount) void run(controlsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every trial add, edit or remove asks again; the shown result is cleared at once.
  const seenTrialVersionRef = useRef(trials.version);
  useEffect(() => {
    if (seenTrialVersionRef.current === trials.version) return;
    seenTrialVersionRef.current = trials.version;
    void run(controlsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trials.version]);

  function commitVol() {
    const v = Number(volDraft);
    if (volDraft.trim() === "" || !Number.isFinite(v) || v < GAINS_AT_RISK_VOL_MIN || v > GAINS_AT_RISK_VOL_MAX) {
      setVolDraft(String(controls.volChangePoints));
      return;
    }
    if (v === controls.volChangePoints) return;
    void run({ ...controls, volChangePoints: v });
  }

  function commitCustom() {
    const text = customDraft.trim();
    if (text === "") {
      setCustomProblem(null);
      if (controls.custom !== null) {
        if (sameMove(selectedMove, controls.custom)) setSelectedMove(defaultSelectedMoveFor(controls.driver.kind));
        void run({ ...controls, custom: null });
      }
      return;
    }
    const move = Number(text) / 100;
    const problem = customMoveProblemFor(controls.driver.kind, move);
    setCustomProblem(problem);
    if (problem) return;
    if (controls.custom !== null && sameMove(controls.custom, move)) return;
    setSelectedMove(move);
    void run({ ...controls, custom: move });
  }

  function commitOverride(securityId: number) {
    const text = (overrideDrafts[securityId] ?? "").trim();
    if (text === "") {
      clearOverride(securityId);
      return;
    }
    const v = Number(text);
    if (!Number.isFinite(v)) {
      setOverrideProblems((p) => ({ ...p, [securityId]: "Type a price per share as a number." }));
      return;
    }
    setOverrideProblems((p) => withoutKey(p, securityId));
    if (controls.priceOverrides[securityId] === v) return;
    void run({ ...controls, priceOverrides: { ...controls.priceOverrides, [securityId]: v } });
  }

  function clearOverride(securityId: number) {
    setOverrideDrafts((d) => withoutKey(d, securityId));
    setOverrideProblems((p) => withoutKey(p, securityId));
    if (!Object.prototype.hasOwnProperty.call(controls.priceOverrides, securityId)) return;
    void run({ ...controls, priceOverrides: withoutKey(controls.priceOverrides, securityId) });
  }

  function commitBeta(identityId: number) {
    const text = (betaDrafts[identityId] ?? "").trim();
    if (text === "") {
      clearBeta(identityId);
      return;
    }
    const problem = betaOverrideProblem(text);
    if (problem) {
      setBetaProblems((p) => ({ ...p, [identityId]: problem }));
      return;
    }
    setBetaProblems((p) => withoutKey(p, identityId));
    const v = Number(text);
    if (controls.betaOverrides[identityId] === v) return;
    void run({ ...controls, betaOverrides: { ...controls.betaOverrides, [identityId]: v } });
  }

  function clearBeta(identityId: number) {
    setBetaDrafts((d) => withoutKey(d, identityId));
    setBetaProblems((p) => withoutKey(p, identityId));
    if (!Object.prototype.hasOwnProperty.call(controls.betaOverrides, identityId)) return;
    void run({ ...controls, betaOverrides: withoutKey(controls.betaOverrides, identityId) });
  }

  // ── Step 3: the driver ──

  /** Pick a driver (a kind switch resets the sweep and the selected row; date, volatility and trial list stay). */
  function pickDriver(next: DriverChoice, indexSymbol: GainsAtRiskDriver = controls.driverSymbol) {
    setDriverNotice(null);
    const base = { ...controls, driverSymbol: indexSymbol };
    const switched = switchDriver(base, selectedMove, next);
    if (switched.controls.custom !== controls.custom) {
      setCustomDraft("");
      setCustomProblem(null);
    }
    setSelectedMove(switched.selectedMove);
    void run(switched.controls, switched.selectedMove);
  }

  function pickIndex(symbol: GainsAtRiskDriver) {
    if (controls.driver.kind === "index" && controls.driverSymbol === symbol) return;
    pickDriver({ kind: "index" }, symbol);
  }

  function pickSingleName(entry: SingleNameDriverEntry) {
    const cur = controls.driver;
    if (cur.kind === "single-name" && sameDriverIn([entry], cur.entry) !== null) return;
    pickDriver({ kind: "single-name", entry });
  }

  /** In single-name mode the crossing reads in the selected move's direction (D5): a change of direction asks again. */
  function selectMove(m: number) {
    const before = selectedMoveRef.current;
    setSelectedMove(m);
    if (
      controls.driver.kind === "single-name" &&
      trialsRef.current.list.length > 0 &&
      moveDirection(m) !== moveDirection(before)
    ) {
      void run(controlsRef.current, m);
    }
  }

  // The trial positions' underlyings: the drivers route is asked again when they change (P1).
  const trialUnderlyingIds = uniqueSortedIds(trials.list.map((t) => trialPositionSecurityId(t.position)));
  const trialUnderlyingKey = trialUnderlyingIds.join(",");
  // The first paint's lists were built with no trial positions.
  const driversKeyRef = useRef("");
  const driversSeqRef = useRef(0);
  function trialIdsNow(): number[] {
    return uniqueSortedIds(trialsRef.current.list.map((t) => trialPositionSecurityId(t.position)));
  }
  /** Ask the drivers route for the list; an older reply is dropped. `onFail` runs after a failure (the default says so). */
  function refreshDrivers(ids: number[], onFail?: () => void) {
    const seq = ++driversSeqRef.current;
    const body: SingleNameDriversBody = { trialUnderlyingIds: ids };
    const failed = (text: string) => {
      notListedRef.current = false;
      if (onFail) onFail();
      else setDriverNotice(text);
    };
    void (async () => {
      try {
        const res = await apiFetch("/api/compute/gains-at-risk/single-name-drivers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const r = await readMutationResult<{ data: SingleNameDriversResponse }>(res);
        // A reply for an older set of trial positions is dropped.
        if (seq !== driversSeqRef.current) return;
        if (!r.ok) {
          failed(DRIVERS_REFRESH_FAILED_TEXT);
          return;
        }
        setDriversFailed(false);
        applyDriverLists(r.data.data);
      } catch {
        if (seq !== driversSeqRef.current) return;
        failed(`${DRIVERS_REFRESH_FAILED_TEXT} ${networkFailureMessage("refresh the list of names")}`);
      }
    })();
  }
  useEffect(() => {
    if (driversKeyRef.current === trialUnderlyingKey) return;
    driversKeyRef.current = trialUnderlyingKey;
    refreshDrivers(trialUnderlyingIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trialUnderlyingKey]);

  /** Retry after the list failed to load. */
  function retryDrivers() {
    setDriverNotice(null);
    refreshDrivers(trialIdsNow());
  }

  /** Take a fresh list. A chosen name no longer on it sends the page back to the index, and says so. */
  function applyDriverLists(lists: SingleNameDriversResponse) {
    setDriverLists(lists);
    const cur = controlsRef.current.driver;
    if (cur.kind !== "single-name") {
      setDriverNotice(null);
      return;
    }
    const still = sameDriverIn(lists.drivers, cur.entry);
    if (still) {
      setDriverNotice(null);
      // The compute route refused the name a moment ago, but the fresh list has it: ask again.
      if (notListedRef.current) {
        notListedRef.current = false;
        void run(controlsRef.current);
      }
      return;
    }
    notListedRef.current = false;
    const back = switchDriver(controlsRef.current, selectedMoveRef.current, { kind: "index" });
    setCustomDraft("");
    setCustomProblem(null);
    setSelectedMove(back.selectedMove);
    setDriverNotice(driverDroppedText(cur.entry.symbol));
    void run(back.controls, back.selectedMove);
  }

  // Fresh server props carry fresh lists (built with no trial positions): taken when none is on the page.
  const seenListsRef = useRef(initialDriverLists);
  useEffect(() => {
    if (seenListsRef.current === initialDriverLists) return;
    seenListsRef.current = initialDriverLists;
    if (initialDriverLists === null) return;
    setDriversFailed(false);
    if (trialsRef.current.list.length === 0) applyDriverLists(initialDriverLists);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDriverLists]);

  // The driver choice is remembered across a scope change.
  useEffect(() => {
    driverMemory.set({ driver: controls.driver, driverSymbol: controls.driverSymbol });
  }, [driverMemory, controls.driver, controls.driverSymbol]);

  const kind = controls.driver.kind;
  const singleNameSymbol = controls.driver.kind === "single-name" ? controls.driver.entry.symbol : null;
  // Single-name mode has one case, under both keys (P20): the page reads "measured".
  const screenCase = caseOnScreen(kind, caseKey);

  // The figures shown: the answer to the controls, or the last answer kept
  // for layout (dimmed while computing, blanked after a failure).
  const display = state.result ?? state.previous ?? initial;
  // An answer counts only for the trial positions on screen now: between a
  // trial change and its request starting, the last answer is already old.
  const trialsCurrent = state.trialVersion === trials.version;
  const mode: FigureMode =
    state.result && trialsCurrent ? "fresh" : state.loading || !trialsCurrent ? "stale" : "failed";
  // The trial list's figures: only from an answer to the list as it stands.
  const trialAnswer = mode === "fresh" ? (display.result.trial ?? null) : null;
  // A trial row's name in the per-name table: its contract, or its symbol.
  const trialLabels = new Map(
    trials.list.map((t) => [
      t.position.id,
      { symbol: trialName(t), ...(t.position.kind === "option" ? { expiry: t.position.expiry } : {}) },
    ]),
  );

  // The year's gain does not depend on any control, so the header keeps it.
  const yearGain = display.yearGain;
  const recon = reconciliationLine(yearGain);
  const note = yearGainNote(yearGain);
  const allFreshness = positionsFreshnessCell(display.yearGainFreshness);

  return (
    <div className="space-y-6">
      {/* ── Title and stress scope ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-medium text-ink whitespace-nowrap!">Gains at risk</h2>
          {/* Orientation: three short lines; each name jumps to its section. The first carries the page description. */}
          <ul className="mt-1 space-y-0.5 pointer-coarse:space-y-2 text-sm text-ink-faint">
            {pageGuideLines(kind).map((l) => (
              <li key={l.anchor}>
                <a
                  href={`#${l.anchor}`}
                  className="relative text-ink-dim underline pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-1 pointer-coarse:after:-inset-x-1"
                >
                  {l.name}
                </a>
                {": "}
                {l.text}
              </li>
            ))}
          </ul>
        </div>
        <div
          className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 self-start w-fit max-w-full overflow-x-auto"
          role="group"
          aria-label="Stress scope"
        >
          {SCOPE_PILLS.map((s) => (
            <Link
              key={s.key}
              href={`/dashboard/analysis?view=gains&scope=${s.key}`}
              aria-current={scope === s.key ? "true" : undefined}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                scope === s.key ? "bg-panel text-ink shadow-sm" : "text-ink-dim hover:text-ink"
              }`}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      {/* ── The year's gain: every account, whatever the stress scope ── */}
      <section className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-2" aria-label={YEAR_GAIN_LABEL}>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h3 className="text-sm font-medium text-ink-dim whitespace-nowrap!">{YEAR_GAIN_LABEL}</h3>
          <span className="text-2xl font-semibold text-ink tabular-nums">
            <Money value={yearGain.gainUsd} fallback="not available" />
          </span>
          <span className="text-xs text-ink-faint">all accounts</span>
        </div>
        <FreshnessChip cell={allFreshness} label="All accounts' positions as of" />
        {yearGain.accounts.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
            {yearGain.accounts.map((a) => (
              <li key={a.accountId}>
                {a.name}, value as of{" "}
                <span className="text-ink-dim">{a.asOfDate ? formatPositionsDate(a.asOfDate) : "no value"}</span>
              </li>
            ))}
          </ul>
        )}
        {yearGain.gainUsd !== null && (
          <p className="text-xs text-ink-faint">
            Statements check: {recon.text}
            {recon.differenceUsd !== null && (
              <>
                {" "}
                <Money value={moneyCell(recon.differenceUsd, false)} signed />
              </>
            )}
            .
          </p>
        )}
        {note && <p className="text-xs text-ink-dim">{note}</p>}
      </section>

      {/* ── Controls: always shown and editable, whatever the request state ── */}
      <section className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-3" aria-label="Scenario">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <DriverControl
            driver={controls.driver}
            indexSymbol={controls.driverSymbol}
            drivers={driverLists.drivers}
            onPickIndex={pickIndex}
            onPickSingleName={pickSingleName}
            listFailed={driversFailed}
            onRetry={retryDrivers}
          />
          <label className="space-y-1">
            <span className="block text-xs text-ink-faint">by</span>
            <input
              type="date"
              value={dateDraft}
              min={today}
              max={latestDate}
              onChange={(e) => {
                setDateDraft(e.target.value);
                if (e.target.value && e.target.value !== controls.valuationDate) {
                  void run({ ...controls, valuationDate: e.target.value });
                }
              }}
              className="px-2 py-1.5 rounded-md border border-edge bg-raised text-sm text-ink"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-ink-faint">Volatility change (points)</span>
            <input
              type="number"
              inputMode="decimal"
              step={1}
              min={GAINS_AT_RISK_VOL_MIN}
              max={GAINS_AT_RISK_VOL_MAX}
              value={volDraft}
              onChange={(e) => setVolDraft(e.target.value)}
              onBlur={commitVol}
              onKeyDown={onEnterBlur}
              className="w-24 px-2 py-1.5 rounded-md border border-edge bg-raised text-sm text-ink tabular-nums"
            />
          </label>
        </div>
        {singleNameSymbol !== null && <p className="text-xs text-ink-faint">{singleNameVolNote(singleNameSymbol)}</p>}
        {driverNotice && <p className={`text-xs ${CHIP_TONE_TEXT.warn}`}>{driverNotice}</p>}
        {singleNameSymbol !== null && Object.keys(controls.betaOverrides).length > 0 && (
          <p className="text-xs text-ink-faint">{FIGURES_KEPT_NOTE}</p>
        )}
        {singleNameSymbol !== null ? (
          <p className="text-xs text-ink-dim">{HELD_UNCHANGED_NOTE}</p>
        ) : (
          <p className="text-xs text-ink-faint">{DOWN_ONLY_NOTE}</p>
        )}
        {singleNameSymbol === null && (
        <div className="space-y-1">
          <span className="block text-xs text-ink-faint">Case</span>
          <div className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 w-fit" role="group" aria-label="Case">
            {CASE_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={caseKey === k}
                onClick={() => setCaseKey(k)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                  caseKey === k ? "bg-panel text-ink shadow-sm" : "text-ink-dim hover:text-ink"
                }`}
              >
                {CASE_LABELS[k]}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-dim">{CASE_NOTES[caseKey]}</p>
        </div>
        )}
      </section>

      {/* ── Trial positions: page state only, never stored ── */}
      <TrialPositionsPanel
        today={today}
        trial={trialAnswer}
        computing={mode === "stale"}
        yearGain={display.yearGain}
        // The per-name table is on screen when the book or the trial positions give it rows.
        tableBelow={display.result.positions.length > 0 || (display.result.trial?.rows.length ?? 0) > 0}
      />
      <CandidateSection scope={scope} controls={controls} selectedMove={selectedMove} caseKey={screenCase} yearGain={display.yearGain} underlyings={driverLists.candidateUnderlyings} today={today} latestDate={latestDate} bookRevision={bookRevision} />

      <div id={GAINS_ANCHORS.results} className="scroll-mt-4 space-y-6">
      <ResultSections
        result={display.result}
        trialLabels={trialLabels}
        response={display}
        mode={mode}
        error={state.error}
        caseKey={caseKey}
        controlsDriver={{ driver: controls.driver, driverSymbol: controls.driverSymbol }}
        scopeHasAccounts={scopeHasAccounts}
        today={today}
        custom={controls.custom}
        customDraft={customDraft}
        customProblem={customProblem}
        onCustomDraft={setCustomDraft}
        onCustomCommit={commitCustom}
        selectedMove={selectedMove}
        onSelectMove={selectMove}
        overrideDrafts={overrideDrafts}
        overrideProblems={overrideProblems}
        onOverrideDraft={(id, v) => setOverrideDrafts((d) => ({ ...d, [id]: v }))}
        onOverrideCommit={commitOverride}
        onOverrideClear={clearOverride}
        priceOverrides={controls.priceOverrides}
        betaDrafts={betaDrafts}
        betaProblems={betaProblems}
        onBetaDraft={(id, v) => setBetaDrafts((d) => ({ ...d, [id]: v }))}
        onBetaCommit={commitBeta}
        onBetaClear={clearBeta}
        betaOverrides={controls.betaOverrides}
      />
      </div>
    </div>
  );
}

function ResultSections({
  result,
  trialLabels,
  response,
  mode,
  error,
  caseKey: pickedCase,
  controlsDriver,
  scopeHasAccounts,
  today,
  custom,
  customDraft,
  customProblem,
  onCustomDraft,
  onCustomCommit,
  selectedMove,
  onSelectMove,
  overrideDrafts,
  overrideProblems,
  onOverrideDraft,
  onOverrideCommit,
  onOverrideClear,
  priceOverrides,
  betaDrafts,
  betaProblems,
  onBetaDraft,
  onBetaCommit,
  onBetaClear,
  betaOverrides,
}: {
  result: GainsAtRiskResult;
  trialLabels: ReadonlyMap<string, { symbol: string; expiry?: string }>;
  response: GainsAtRiskResponse;
  mode: FigureMode;
  error: string | null;
  /** The case the owner picked (a single-name result reads "measured", P20). */
  caseKey: GainsAtRiskCaseKey;
  /** Step 3: the controls' driver; the layout itself follows the RESULT's own driver. */
  controlsDriver: Pick<GainsControls, "driver" | "driverSymbol">;
  scopeHasAccounts: boolean;
  today: string;
  custom: number | null;
  customDraft: string;
  customProblem: string | null;
  onCustomDraft: (v: string) => void;
  onCustomCommit: () => void;
  selectedMove: number;
  onSelectMove: (m: number) => void;
  overrideDrafts: Record<number, string>;
  overrideProblems: Record<number, string>;
  onOverrideDraft: (id: number, v: string) => void;
  onOverrideCommit: (id: number) => void;
  onOverrideClear: (id: number) => void;
  priceOverrides: Record<number, number>;
  betaDrafts: Record<number, string>;
  betaProblems: Record<number, string>;
  onBetaDraft: (identityId: number, v: string) => void;
  onBetaCommit: (identityId: number) => void;
  onBetaClear: (identityId: number) => void;
  betaOverrides: Record<number, number>;
}) {
  // The per-name table's order lives in the URL (its own key, so no other Analysis table is touched).
  const { sort, setSort } = useSortParam<GainsSortKey>(GAINS_SORT_SCOPE, DEFAULT_POSITION_SORT.field, DEFAULT_POSITION_SORT.dir);
  const scopeCell = scopeFreshnessCell(response.scopeFreshness, scopeHasAccounts);
  // Step 3: everything drawn about the result follows the RESULT's own driver,
  // never the controls; a result for another driver is dimmed and has no headline.
  const layout = resultLayout(result, controlsDriver, mode);
  // A single-name result reads "measured" (both keys hold the same figures, P20).
  const caseKey = caseOnScreen(layout.kind, pickedCase);
  // After a failure no figure is shown; while computing, the old ones are dimmed.
  const failed = mode === "failed";
  const dim = layout.dim ? "opacity-40" : "";
  // Blank after a failure; never a negative zero in a signed cell.
  const fig = (v: number | null | undefined): number | null => moneyCell(v, failed);

  const statusLine =
    mode === "stale" ? (
      <p role="status" className="text-sm text-ink-faint">
        {STALE_TEXT}
      </p>
    ) : failed ? (
      <p role="alert" className={`text-sm ${CHIP_TONE_TEXT.down}`}>
        {error ?? "Could not compute gains at risk."}
      </p>
    ) : null;

  // With trial positions the comparison is drawn even when the scope holds nothing.
  const trial = result.trial && result.trial.rows.length > 0 ? result.trial : null;
  if (result.positions.length === 0 && !trial) {
    return (
      <>
        <FreshnessChip cell={scopeCell} label="Stress scope positions as of" />
        {statusLine}
        <EmptySection
          title="Gains at risk"
          reason={
            scopeHasAccounts
              ? "No positions are held in this scope, so there is nothing to stress."
              : "No account matches this scope, so nothing is stressed."
          }
        />
      </>
    );
  }

  const yearGain = response.yearGain;
  // The table, the per-name table and the disclosures follow the case on screen.
  const selected = result.cases[caseKey];
  const rowAt = (move: number) => selected.moves.find((r) => sameMove(r.move, move)) ?? null;
  const shareShown = selected.moves.some((r) => gainGivenBackShare(r.bookPnlUsd, yearGain) !== null);
  const laterDate = result.valuationDate > today;
  // Step 3: single-name mode has its own rows (falls and rises), headline and words.
  const singleName = layout.kind === "single-name";
  const kind = layout.kind;
  const tableMoves: number[] = singleName ? [...tableMovesFor(kind)] : [...TABLE_MOVES];
  const customExtra = custom !== null && !tableMoves.some((m) => sameMove(m, custom));
  const rowMoves = tableRowMoves(kind, custom);
  // The custom box is a control: its bounds follow the controls' driver.
  const customBounds = customMoveBoundsPct(controlsDriver.driver.kind);
  const selectedIdx = selected.moves.findIndex((r) => sameMove(r.move, selectedMove));
  const driver = result.driverSymbol;
  // A key the URL carries that this table does not know falls back to the default.
  const sortKey: GainsSortKey = isGainsSortKey(sort.field) ? sort.field : DEFAULT_POSITION_SORT.field;
  // By the selected case at the selected move; rows with no figure last either way.
  // Trial positions sit in the same table, marked "trial", sorted with the book.
  const positions = sortPositions(nameTableRows(result, trialLabels), sortKey, sort.dir, caseKey, selectedIdx);
  const sortNote = positionSortNote(sortKey, sort.dir);
  // Both boxes follow the order on screen: the first row of a name (or a contract) owns its box.
  const boxOwners = priceBoxOwners(positions);
  // A book row always holds its name's box; a trial row only for a name no book row has.
  const editorOwnership = nameTableEditorOwnership(positions);
  // A refusal of the owner's figure belongs to the name: shown beside its one box.
  const betaRefusals = new Map<number, GainsAtRiskBetaOverrideRefusal>();
  for (const p of positions) {
    if (p.identitySecurityId !== null && p.betaOverrideRefusal && !betaRefusals.has(p.identitySecurityId)) {
      betaRefusals.set(p.identitySecurityId, p.betaOverrideRefusal);
    }
  }
  const caption = betaEvidenceCaption(result.betaEvidence, driver);
  // The book's change at the selected row (single-name mode): a loss also as a share of the year's gain.
  const selectedRow = rowAt(selectedMove);
  const headlineTrialRow = trial && selectedRow ? trial.cases[caseKey].moves.find((r) => sameMove(r.move, selectedRow.move)) : undefined;
  const headline =
    layout.showHeadline && selectedRow
      ? singleNameHeadline(selectedRow, driver, yearGain, trial ? (headlineTrialRow?.bookWithTrialPnlUsd ?? null) : null)
      : null;
  // P3: the flagged funds (and options on them) no seed links to the stock, held unchanged.
  const lnl = singleName ? (selected.disclosures.leveragedNotLinked ?? null) : null;
  // A scope where nothing moves with the stock: the figures are time decay alone; say so.
  const nothingMoves = nothingMovesNote(result);
  const lnlShare = lnl ? disclosureShare(lnl) : null;
  const ignored = overridesIgnoredLine(result.betaOverridesIgnored);
  const noLink = noMeasuredLinkSentence(selected.disclosures.noMeasuredLink, caseKey);
  // With trial positions: the selected case's book with them (R6: the book's own figures do not move).
  const emptyBook = result.positions.length === 0;
  const trialSel = trial ? trial.cases[caseKey] : null;
  // The selected case's book rows (the moves table below shadows the name `selected`).
  const bookCase = selected;
  const noMoveCost = trialSel && !failed ? noMoveCostSentence(trialSel) : null;
  const crossing =
    trialSel && !failed ? crossingSentence(trialSel, driver, customExtra && custom !== null ? [...tableMoves, custom] : tableMoves) : null;

  return (
    <>
      {/* ── Chart ── */}
      <section
        className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-3"
        aria-label="Profit or loss by move"
        aria-busy={mode === "stale"}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="text-sm font-medium text-ink whitespace-nowrap!">
            Book profit or loss by {driver} move
          </h3>
          <FreshnessChip cell={scopeCell} label="Stress scope positions as of" />
        </div>
        {statusLine}
        {!failed && (
          <div className={dim}>
            <GainsAtRiskChart
              cases={result.cases}
              selectedCase={caseKey}
              driverSymbol={driver}
              yearGain={yearGain}
              trial={trial ? trial.cases : null}
              singleName={singleName}
            />
          </div>
        )}
        {singleName ? (
          <p className="text-xs text-ink-faint">{SINGLE_NAME_CHART_NOTE}</p>
        ) : (
          <p className="text-xs text-ink-faint">{trial ? TRIAL_CHART_NOTE : CHART_GAP_NOTE}</p>
        )}
        {trial && emptyBook && <p className="text-xs text-ink-faint">{TRIAL_EMPTY_BOOK_NOTE}</p>}
      </section>

      {/* ── Table: fixed rows and a custom row ── */}
      <section className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-3" aria-label="Moves" aria-busy={mode === "stale"}>
        {nothingMoves && <p className={`text-xs text-ink-dim ${dim}`}>{nothingMoves}</p>}
        <ScrollFade>
          <table className={`w-full text-sm tabular-nums ${dim}`}>
            <thead>
              <tr className="text-xs text-ink-faint text-right">
                <th className="text-left font-normal py-1 pr-3 whitespace-nowrap">
                  {driver} {COLUMN_LABELS.move}
                </th>
                {trialSel ? (
                  <>
                    <th className="font-normal py-1 px-3 whitespace-nowrap">{TRIAL_TABLE_LABELS.asIs}</th>
                    <th className="font-normal py-1 px-3 whitespace-nowrap">{TRIAL_TABLE_LABELS.withTrial}</th>
                    <th className="font-normal py-1 px-3 whitespace-nowrap">{TRIAL_TABLE_LABELS.difference}</th>
                    {shareShown && <th className="font-normal py-1 pl-3 whitespace-nowrap">{TRIAL_TABLE_LABELS.givenBack}</th>}
                  </>
                ) : (
                  <>
                    <th className="font-normal py-1 px-3 whitespace-nowrap">{COLUMN_LABELS.losers}</th>
                    <th className="font-normal py-1 px-3 whitespace-nowrap">{COLUMN_LABELS.offsets}</th>
                    <th className="font-normal py-1 px-3 whitespace-nowrap">{COLUMN_LABELS.book}</th>
                    {shareShown && <th className="font-normal py-1 pl-3 whitespace-nowrap">{COLUMN_LABELS.givenBack}</th>}
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rowMoves.map((move) => {
                const row = rowAt(move);
                // P6: each single-name row carries its own direction's split; the zero row has none.
                const cells = singleName && row ? singleNameRowCells(row) : null;
                const selected = sameMove(move, selectedMove);
                const isCustom = customExtra && custom !== null && sameMove(move, custom);
                const cell = row && !failed ? givenBackCell(row.bookPnlUsd, yearGain) : null;
                const tRow = trialSel ? trialTableRow(bookCase, trialSel, move) : null;
                const withCell = tRow && !failed ? givenBackCell(tRow.withTrial, yearGain) : null;
                return (
                  <tr key={move} className={`border-t border-edge ${selected ? "bg-raised" : ""}`}>
                    <td className="text-left py-1.5 pr-3">
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onSelectMove(move)}
                        className="text-left text-ink underline decoration-dotted underline-offset-2"
                      >
                        {formatDriverMove(move)}
                        {isCustom ? " (custom)" : ""}
                      </button>
                      {sameMove(move, 0) && laterDate && (
                        <span className="block text-[11px] text-ink-faint">{ZERO_ROW_NOTE}</span>
                      )}
                    </td>
                    {trialSel ? (
                      <>
                        <td className="text-right py-1.5 px-3 whitespace-nowrap">
                          <Money value={fig(row?.bookPnlUsd)} signed />
                        </td>
                        <td className="text-right py-1.5 px-3 text-ink whitespace-nowrap">
                          <Money value={fig(tRow?.withTrial)} signed />
                        </td>
                        <td className="text-right py-1.5 px-3 whitespace-nowrap">
                          <Money value={fig(tRow?.difference)} signed />
                        </td>
                        {shareShown && (
                          <td className="text-right py-1.5 pl-3 whitespace-nowrap">
                            <GivenBack cell={cell} />
                            <span className="text-ink-faint"> {TRIAL_GIVEN_BACK_ARROW} </span>
                            <GivenBack cell={withCell} />
                          </td>
                        )}
                      </>
                    ) : (
                      <>
                        <td className="text-right py-1.5 px-3 whitespace-nowrap">
                          {cells && cells.loses === null ? null : <Money value={fig(row?.losersPnlUsd)} signed />}
                        </td>
                        <td className="text-right py-1.5 px-3 whitespace-nowrap">
                          {cells && cells.offsets === null ? null : <Money value={fig(row?.offsetsPnlUsd)} signed />}
                        </td>
                        <td className="text-right py-1.5 px-3 text-ink whitespace-nowrap">
                          <Money value={fig(row?.bookPnlUsd)} signed />
                        </td>
                        {shareShown && (
                          <td className="text-right py-1.5 pl-3 whitespace-nowrap">
                            <GivenBack cell={cell} />
                          </td>
                        )}
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollFade>
        {noMoveCost && (
          <p className={`text-xs text-ink-dim ${dim}`}>
            {noMoveCost.usd === null ? (
              noMoveCost.before
            ) : (
              <>
                {noMoveCost.before} <Money value={fig(noMoveCost.usd)} /> {noMoveCost.after}
              </>
            )}
          </p>
        )}
        {crossing && <p className={`text-xs text-ink-dim ${dim}`}>{crossing}</p>}
        {headline && !failed && (
          <p className={`text-sm text-ink ${dim}`}>
            {headline.text} <Money value={fig(headline.usd)} signed />
            {headline.share !== null && (
              <>
                {" "}
                (<Pct value={headline.share * 100} /> of the year&apos;s gain)
              </>
            )}
            {headline.withTrial && (
              <>
                ; {headline.withTrial.text} <Money value={fig(headline.withTrial.usd)} signed />
                {headline.withTrial.share !== null && (
                  <>
                    {" "}
                    (<Pct value={headline.withTrial.share * 100} /> of the year&apos;s gain)
                  </>
                )}
              </>
            )}
            .
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="gains-custom-move" className="text-ink-faint text-xs">
            Custom {controlsDriver.driver.kind === "single-name" ? controlsDriver.driver.entry.symbol : controlsDriver.driverSymbol} move
          </label>
          <input
            id="gains-custom-move"
            type="number"
            inputMode="decimal"
            step={0.5}
            max={customBounds.max}
            min={customBounds.min}
            placeholder={controlsDriver.driver.kind === "single-name" ? "-25" : "-7"}
            value={customDraft}
            onChange={(e) => onCustomDraft(e.target.value)}
            onBlur={onCustomCommit}
            onKeyDown={onEnterBlur}
            className="w-20 px-2 py-1 rounded-md border border-edge bg-raised text-sm text-ink tabular-nums"
          />
          <span className="text-xs text-ink-faint">%</span>
          {customProblem && <span className={`text-xs ${CHIP_TONE_TEXT.down}`}>{customProblem}</span>}
        </div>
      </section>

      {/* ── Per name ── */}
      <section className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-3" aria-label="What moves the result" aria-busy={mode === "stale"}>
        <h3 className="text-sm font-medium text-ink whitespace-nowrap!">
          What moves the result{selectedIdx >= 0 ? ` at ${formatDriverMove(selected.moves[selectedIdx].move)}` : ""}
        </h3>
        {sortNote && <p className="text-xs text-ink-dim">{sortNote}</p>}
        {singleName ? (
          <p className="text-xs text-ink-faint">{singleNameMovesNote(driver)} Pick a row above to see that move.</p>
        ) : (
          <p className="text-xs text-ink-faint">
            Each name moves by its beta times the index&apos;s move. In a real fall a name can move more than that, or alone.
            Pick a row above to see that move.
          </p>
        )}
        {!failed && !singleName && (
          <p className={`text-xs text-ink-faint ${dim}`}>
            {caption.text}
            {caption.waiting && (
              <>
                {" "}
                <Count value={caption.waiting.count} /> {caption.waiting.text}
              </>
            )}
          </p>
        )}
        {!failed && !singleName && caption.notCaptured && (
          <p className={`text-xs text-ink-faint ${dim}`}>
            <Count value={caption.notCaptured.count} /> {caption.notCaptured.text}
          </p>
        )}
        {mode === "fresh" && ignored && (
          <p className={`text-xs ${CHIP_TONE_TEXT.warn}`}>
            <Count value={ignored.count} /> {ignored.text}
          </p>
        )}
        <ScrollFade>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-ink-faint text-left">
                <SortableHeader field="account" sort={sort} onSort={setSort} className="whitespace-nowrap">
                  Account
                </SortableHeader>
                <SortableHeader field="symbol" sort={sort} onSort={setSort} className="whitespace-nowrap">
                  Name
                </SortableHeader>
                <SortableHeader field="value" sort={sort} onSort={setSort} align="right" className="whitespace-nowrap">
                  Value
                </SortableHeader>
                <SortableHeader field="beta" sort={sort} onSort={setSort} align="right" className="whitespace-nowrap">
                  Beta to {driver}
                </SortableHeader>
                <th className="font-normal py-1 pr-3 whitespace-nowrap">Where it comes from</th>
                {!singleName && <th className="font-normal py-1 pr-3 whitespace-nowrap">Your figure</th>}
                <th className="font-normal py-1 pr-3 whitespace-nowrap">Price</th>
                <SortableHeader field="loss" sort={sort} onSort={setSort} align="right" className="whitespace-nowrap">
                  {selectedIdx >= 0 ? <>Result at {formatDriverMove(selected.moves[selectedIdx].move)}</> : "Result"}
                </SortableHeader>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const key = nameRowKey(p);
                const editor = editorOwnership.get(key);
                return (
                  <PositionRow
                    key={key}
                    p={p}
                    mode={mode}
                    caseKey={caseKey}
                    driver={driver}
                    singleName={singleName}
                    selectedMove={selectedMove}
                    pnl={selectedIdx >= 0 ? fig(p.cases[caseKey].pnlByMove[selectedIdx]) : null}
                    ownsBox={boxOwners.has(`${p.accountId}:${p.securityId}`)}
                    draft={overrideDrafts[p.securityId]}
                    problem={overrideProblems[p.securityId] ?? null}
                    hasOverride={Object.prototype.hasOwnProperty.call(priceOverrides, p.securityId)}
                    onDraft={(v) => onOverrideDraft(p.securityId, v)}
                    onCommit={() => onOverrideCommit(p.securityId)}
                    onClear={() => onOverrideClear(p.securityId)}
                    ownsEditor={editor?.owner === true}
                    sameFigure={editor && !editor.owner ? sameFigureTextAt(editor.ownerSymbol, p.symbol, editor.where) : null}
                    betaDraft={p.identitySecurityId !== null ? betaDrafts[p.identitySecurityId] : undefined}
                    betaProblem={p.identitySecurityId !== null ? (betaProblems[p.identitySecurityId] ?? null) : null}
                    betaRefusal={p.identitySecurityId !== null ? (betaRefusals.get(p.identitySecurityId) ?? null) : null}
                    hasBeta={
                      p.identitySecurityId !== null &&
                      Object.prototype.hasOwnProperty.call(betaOverrides, p.identitySecurityId)
                    }
                    onBetaDraft={(v) => {
                      if (p.identitySecurityId !== null) onBetaDraft(p.identitySecurityId, v);
                    }}
                    onBetaCommit={() => {
                      if (p.identitySecurityId !== null) onBetaCommit(p.identitySecurityId);
                    }}
                    onBetaClear={() => {
                      if (p.identitySecurityId !== null) onBetaClear(p.identitySecurityId);
                    }}
                  />
                );
              })}
            </tbody>
          </table>
        </ScrollFade>
      </section>

      {/* ── Disclosures ── */}
      <section
        className={`bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-1.5 ${dim}`}
        aria-label="What the figures leave out"
      >
        {/* Single-name mode measures nothing, so "no measured link" does not apply there. */}
        {disclosureSentences(selected.disclosures)
          .filter((d) => !(singleName && d.key === "noMeasuredLink"))
          .map((d) => {
          const share = disclosureShare(d);
          return (
            <p key={d.key} className="text-xs text-ink-dim">
              <span className="text-ink">{d.text}:</span> <Count value={fig(d.count)} />
              {!failed && d.count > 0 && share.kind === "pct" && (
                <>
                  {" · "}
                  <Pct value={share.value * 100} /> of the book
                </>
              )}
              {!failed && d.count > 0 && share.kind === "not-known" && <>{" · "}share not known</>}
              {!failed && d.key === "noMeasuredLink" && d.count > 0 && (
                <>
                  {" · "}
                  {noLink.treatment}
                  {noLink.reasons.map((r) => (
                    <span key={r.key}>
                      {" · "}
                      {r.text} (<Count value={r.count} />)
                    </span>
                  ))}
                </>
              )}
              {!failed && d.unknownValueCount > 0 && (
                <>
                  {" · "}
                  <Count value={d.unknownValueCount} /> value not known
                </>
              )}
              {!failed && d.symbols.length > 0 && <span className="text-ink-faint"> · {d.symbols.join(", ")}</span>}
            </p>
          );
        })}
        {lnl && (
          <p className="text-xs text-ink-dim">
            <span className="text-ink">{leveragedNotLinkedText(driver)}:</span> <Count value={fig(lnl.count)} />
            {!failed && lnl.count > 0 && lnlShare?.kind === "pct" && (
              <>
                {" · "}
                <Pct value={lnlShare.value * 100} /> of the book
              </>
            )}
            {!failed && lnl.symbols.length > 0 && <span className="text-ink-faint"> · {lnl.symbols.join(", ")}</span>}
          </p>
        )}
      </section>
    </>
  );
}

function PositionRow({
  p,
  mode,
  caseKey,
  driver,
  singleName,
  selectedMove,
  pnl,
  ownsBox,
  draft,
  problem,
  hasOverride,
  onDraft,
  onCommit,
  onClear,
  ownsEditor,
  sameFigure,
  betaDraft,
  betaProblem,
  betaRefusal,
  hasBeta,
  onBetaDraft,
  onBetaCommit,
  onBetaClear,
}: {
  p: NameTableRow;
  mode: FigureMode;
  caseKey: GainsAtRiskCaseKey;
  driver: string;
  /** Step 3: single-name mode (no figure box; words name the stock; the side of the selected move's direction). */
  singleName: boolean;
  selectedMove: number;
  pnl: number | null;
  ownsBox: boolean;
  draft: string | undefined;
  problem: string | null;
  hasOverride: boolean;
  onDraft: (v: string) => void;
  onCommit: () => void;
  onClear: () => void;
  ownsEditor: boolean;
  /** Set on a later row of a name whose box sits higher up in the current order. */
  sameFigure: string | null;
  betaDraft: string | undefined;
  betaProblem: string | null;
  betaRefusal: GainsAtRiskBetaOverrideRefusal | null;
  hasBeta: boolean;
  onBetaDraft: (v: string) => void;
  onBetaCommit: () => void;
  onBetaClear: () => void;
}) {
  const editable = isPriceEditable(p);
  // No figure box on the index itself or a fixed row: a short note in its place.
  const editorNote = betaEditorNote(p);
  const isOption = p.expiry !== undefined;
  // Figures and the engine's verdicts belong to the answer; dim or blank them with it.
  const dim = mode === "stale" ? "opacity-40" : "";
  const showFigures = mode !== "failed";
  const fig = (v: number | null | undefined): number | null => moneyCell(v, mode === "failed");
  // This case's beta, side and source; the not-modelled reason is read first (betaSourceLine).
  const pc = p.cases[caseKey];
  const source = betaSourceLine(p, caseKey, singleName ? driver : undefined);
  const side = rowSideAt(pc, singleName ? "single-name" : "index", selectedMove);
  // A refused trial row says why in place of where its beta comes from.
  const trialRefusal = p.trialRow && p.trialRefusal !== undefined ? trialRefusalNote(p.trialRow, { tableBelow: "this-row" }) : null;
  return (
    <tr className="border-t border-edge align-top">
      <td className="py-1.5 pr-3 text-ink-faint whitespace-nowrap">{p.accountName}</td>
      <td className="py-1.5 pr-3">
        <span className="font-mono text-ink">{p.symbol}</span>
        {p.trialId !== undefined && (
          <Chip tone="neutral" size="xs" className="ml-1.5">
            trial
          </Chip>
        )}
        {side === "offsets" && (
          <Chip tone="info" size="xs" className="ml-1.5">
            offsetting
          </Chip>
        )}
        {p.expiresBeforeDate && <span className="block text-[11px] text-ink-faint">expires before the date</span>}
      </td>
      <td className={`py-1.5 pr-3 text-right tabular-nums text-ink-dim whitespace-nowrap ${dim}`}>
        <Money value={fig(p.valueUsd)} />
      </td>
      <td className={`py-1.5 pr-3 text-right tabular-nums text-ink-dim whitespace-nowrap ${dim}`}>
        {formatBeta(pc.beta)}
        {isOption && pc.beta !== null ? " (underlying)" : ""}
      </td>
      <td className={`py-1.5 pr-3 text-ink-dim min-w-40 ${dim}`}>
        {trialRefusal ? (
          <span className={`block max-w-56 ${CHIP_TONE_TEXT.warn}`}>{trialRefusal}</span>
        ) : (
          <>
            {source.text}
            {source.details.map((d) => (
              <span key={d} className="block text-[11px] text-ink-faint">
                {d}
              </span>
            ))}
          </>
        )}
      </td>
      {!singleName && (
      <td className="py-1.5 pr-3 text-ink-dim">
        {ownsEditor && p.identitySecurityId !== null && (
          <span className="flex flex-wrap items-center gap-1.5">
            {/* A beta is not a portfolio figure: a plain number box, not masked. Named by aria-label:
                an sr-only label escapes the table's scroller and widens the page. */}
            <input
              id={`gains-beta-${p.identitySecurityId}`}
              aria-label={`Your figure for ${p.symbol}: how it moves per 1% of ${driver}`}
              type="number"
              inputMode="decimal"
              step={0.05}
              min={BETA_OVERRIDE_BOUNDS.min}
              max={BETA_OVERRIDE_BOUNDS.max}
              placeholder="your figure"
              value={betaDraft ?? ""}
              onChange={(e) => onBetaDraft(e.target.value)}
              onBlur={onBetaCommit}
              onKeyDown={onEnterBlur}
              className="w-24 px-2 py-1 rounded-md border border-edge bg-raised text-sm text-ink tabular-nums"
            />
            {(hasBeta || (betaDraft ?? "") !== "") && (
              <button
                type="button"
                onClick={onBetaClear}
                className="px-2 py-1 rounded-md border border-edge text-xs text-ink-dim hover:text-ink"
              >
                Clear
              </button>
            )}
          </span>
        )}
        {editorNote && <span className="block text-[11px] text-ink-faint">{editorNote}</span>}
        {!editorNote && !ownsEditor && sameFigure && (
          <span className="block text-[11px] text-ink-faint">{sameFigure}</span>
        )}
        {ownsEditor && isLeveragedFundRow(p) && (
          <span className="block text-[11px] text-ink-faint max-w-56">{LEVERAGED_FIGURE_HINT}</span>
        )}
        {ownsEditor && betaProblem && <span className={`block text-[11px] ${CHIP_TONE_TEXT.down}`}>{betaProblem}</span>}
        {ownsEditor && mode === "fresh" && betaRefusal && (
          <span className={`block text-[11px] max-w-56 ${CHIP_TONE_TEXT.warn}`}>{BETA_OVERRIDE_REFUSAL_LABELS[betaRefusal]}</span>
        )}
      </td>
      )}
      <td className="py-1.5 pr-3 text-ink-dim">
        <span className={dim}>
          {p.priceSource ? PRICE_SOURCE_LABELS[p.priceSource] : "—"}
          {showFigures && p.priceSource === "model" && p.modelPricePerShare !== undefined && (
            <>
              {" "}
              <Money value={p.modelPricePerShare} precise />
            </>
          )}
        </span>
        {editable && ownsBox && (
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <PrivateNumberInput
              id={`gains-price-${p.securityId}`}
              aria-label={`Your price per share for ${p.symbol}`}
              inputMode="decimal"
              step={0.01}
              min={0}
              placeholder="your price"
              value={draft ?? ""}
              onChange={(e) => onDraft(e.target.value)}
              onBlur={onCommit}
              onKeyDown={onEnterBlur}
              className="w-24 px-2 py-1 rounded-md border border-edge bg-raised text-sm text-ink tabular-nums"
            />
            {(hasOverride || (draft ?? "") !== "") && (
              <button
                type="button"
                onClick={onClear}
                className="px-2 py-1 rounded-md border border-edge text-xs text-ink-dim hover:text-ink"
              >
                Clear
              </button>
            )}
          </span>
        )}
        {editable && ownsBox && p.priceSource === null && (
          <span className="block text-[11px] text-ink-faint max-w-56">{NO_VOLATILITY_PRICE_TEXT}</span>
        )}
        {editable && !ownsBox && <span className="block text-[11px] text-ink-faint">{SAME_PRICE_TEXT}</span>}
        {ownsBox && problem && <span className={`block text-[11px] ${CHIP_TONE_TEXT.down}`}>{problem}</span>}
        {ownsBox && mode === "fresh" && p.overrideRefusal && (
          <span className={`block text-[11px] ${CHIP_TONE_TEXT.warn}`}>{OVERRIDE_REFUSAL_LABELS[p.overrideRefusal]}</span>
        )}
      </td>
      <td className={`py-1.5 text-right tabular-nums text-ink ${dim}`}>
        <Money value={pnl} signed />
      </td>
    </tr>
  );
}

/** One "Gain given back" figure: "none: the book gains", "under 0.1%", or the percent. */
function GivenBack({ cell }: { cell: ReturnType<typeof givenBackCell> | null }) {
  if (cell?.kind === "book-gains") return <span className="text-ink-faint">{BOOK_GAINS_TEXT}</span>;
  if (cell?.kind === "under-tenth") return <PrivateText>{UNDER_TENTH_TEXT}</PrivateText>;
  return <Pct value={cell?.kind === "pct" ? cell.percent : null} />;
}

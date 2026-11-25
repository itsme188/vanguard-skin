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
  GAINS_AT_RISK_DRIVERS,
  GAINS_AT_RISK_VOL_MAX,
  GAINS_AT_RISK_VOL_MIN,
  type GainsAtRiskBody,
  type GainsAtRiskDriver,
  type GainsAtRiskResponse,
} from "@/lib/analysis/gains-at-risk-input";
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
  betaEditorOwnership,
  betaEvidenceCaption,
  betaOverrideProblem,
  betaSourceLine,
  customMoveProblem,
  defaultSweep,
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
  sameFigureText,
  sortPositions,
  priceBoxOwners,
  reconciliationLine,
  requestFailureText,
  requestMoves,
  sameMove,
  scopeFreshnessCell,
  serverPropsAnswerControls,
  yearGainNote,
  type GainsControls,
  type GainsSortKey,
} from "@/lib/analysis/gains-at-risk-view";
// Types only: no engine or query code reaches the browser.
import type {
  GainsAtRiskBetaOverrideRefusal,
  GainsAtRiskCaseKey,
  GainsAtRiskPosition,
  GainsAtRiskResult,
} from "@/lib/compute/gains-at-risk";
import { Chip, type ChipTone } from "../Chip";
import { CHIP_TONE_TEXT } from "../chip-tone-text";
import { EmptySection } from "../EmptySection";
import { ScrollFade } from "../ScrollFade";
import { SortableHeader } from "../SortableHeader";
import { GainsAtRiskChart } from "./GainsAtRiskChart";

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
  initialInputs,
}: {
  scope: AnalysisScope;
  scopeHasAccounts: boolean;
  today: string;
  latestDate: string;
  initial: GainsAtRiskResponse;
  initialInputs: GainsAtRiskInitialInputs;
}) {
  const [state, dispatch] = useReducer(gainsRequestReducer, initial, initialGainsRequestState);
  const seqRef = useRef(0);

  const [controls, setControlsState] = useState<GainsControls>(() => ({
    driverSymbol: initialInputs.driverSymbol,
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
  const [selectedMove, setSelectedMove] = useState(initialInputs.selectedMove);
  const [overrideDrafts, setOverrideDrafts] = useState<Record<number, string>>({});
  const [overrideProblems, setOverrideProblems] = useState<Record<number, string>>({});
  // The case on screen: both are in every answer, so switching asks nothing of the server.
  const [caseKey, setCaseKey] = useState<GainsAtRiskCaseKey>(DEFAULT_CASE);
  // The owner's figure per name, keyed by identitySecurityId (C6).
  const [betaDrafts, setBetaDrafts] = useState<Record<number, string>>({});
  const [betaProblems, setBetaProblems] = useState<Record<number, string>>({});

  async function run(next: GainsControls) {
    controlsRef.current = next;
    setControlsState(next);
    const seq = ++seqRef.current;
    // Clear the shown result first: it answered other controls.
    dispatch({ type: "start", seq });
    if (!(next.valuationDate >= today && next.valuationDate <= latestDate)) {
      dispatch({ type: "failure", seq, message: `Pick a date from ${today} to ${latestDate}.` });
      return;
    }
    const body: GainsAtRiskBody = {
      scope,
      driverSymbol: next.driverSymbol,
      valuationDate: next.valuationDate,
      moves: requestMoves(defaultSweep(), next.custom),
      volChangePoints: next.volChangePoints,
      ...(Object.keys(next.priceOverrides).length > 0 ? { priceOverrides: next.priceOverrides } : {}),
      // Left out when there are none: the route refuses an explicit null.
      ...(Object.keys(next.betaOverrides).length > 0 ? { betaOverrides: next.betaOverrides } : {}),
    };
    try {
      const res = await apiFetch("/api/compute/gains-at-risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const r = await readMutationResult<{ data: GainsAtRiskResponse }>(res);
      if (!r.ok) {
        dispatch({ type: "failure", seq, message: requestFailureText(r.status, r.message) });
        return;
      }
      dispatch({ type: "success", seq, data: r.data.data });
    } catch {
      dispatch({ type: "failure", seq, message: networkFailureMessage("compute gains at risk") });
    }
  }

  // Fresh server props (a refresh after a sync or a saved note): they were
  // computed with the default controls. Take them only when they answer the
  // controls on screen; otherwise keep every control and ask again with them.
  // Either way anything still in flight is older and is dropped.
  const seenPropsRef = useRef(initial);
  useEffect(() => {
    if (seenPropsRef.current === initial) return;
    seenPropsRef.current = initial;
    if (serverPropsAnswerControls(controlsRef.current, initialInputs)) {
      dispatch({ type: "reset", data: initial });
    } else {
      void run(controlsRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

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
        if (sameMove(selectedMove, controls.custom)) setSelectedMove(initialInputs.selectedMove);
        void run({ ...controls, custom: null });
      }
      return;
    }
    const move = Number(text) / 100;
    const problem = customMoveProblem(move);
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

  // The figures shown: the answer to the controls, or the last answer kept
  // for layout (dimmed while computing, blanked after a failure).
  const display = state.result ?? state.previous ?? initial;
  const mode: FigureMode = state.result ? "fresh" : state.loading ? "stale" : "failed";

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
          <p className="text-sm text-ink-faint mt-0.5">
            If an index falls by a date, how much of the year&apos;s gain the book gives back.
          </p>
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
          <div className="space-y-1">
            <span className="block text-xs text-ink-faint">If this index falls</span>
            <div className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 w-fit" role="group" aria-label="Index">
              {GAINS_AT_RISK_DRIVERS.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={controls.driverSymbol === d}
                  onClick={() => {
                    if (d !== controls.driverSymbol) void run({ ...controls, driverSymbol: d });
                  }}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    controls.driverSymbol === d ? "bg-panel text-ink shadow-sm" : "text-ink-dim hover:text-ink"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
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
        <p className="text-xs text-ink-faint">{DOWN_ONLY_NOTE}</p>
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
      </section>

      <ResultSections
        result={display.result}
        response={display}
        mode={mode}
        error={state.error}
        caseKey={caseKey}
        scopeHasAccounts={scopeHasAccounts}
        today={today}
        custom={controls.custom}
        customDraft={customDraft}
        customProblem={customProblem}
        onCustomDraft={setCustomDraft}
        onCustomCommit={commitCustom}
        selectedMove={selectedMove}
        onSelectMove={setSelectedMove}
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
  );
}

function ResultSections({
  result,
  response,
  mode,
  error,
  caseKey,
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
  response: GainsAtRiskResponse;
  mode: FigureMode;
  error: string | null;
  caseKey: GainsAtRiskCaseKey;
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
  // After a failure no figure is shown; while computing, the old ones are dimmed.
  const failed = mode === "failed";
  const dim = mode === "stale" ? "opacity-40" : "";
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

  if (result.positions.length === 0) {
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
  const tableMoves: number[] = [...TABLE_MOVES];
  const customExtra = custom !== null && !tableMoves.some((m) => sameMove(m, custom));
  const selectedIdx = selected.moves.findIndex((r) => sameMove(r.move, selectedMove));
  const driver = result.driverSymbol;
  // A key the URL carries that this table does not know falls back to the default.
  const sortKey: GainsSortKey = isGainsSortKey(sort.field) ? sort.field : DEFAULT_POSITION_SORT.field;
  // By the selected case at the selected move; rows with no figure last either way.
  const positions = sortPositions(result.positions, sortKey, sort.dir, caseKey, selectedIdx);
  const sortNote = positionSortNote(sortKey, sort.dir);
  // Both boxes follow the order on screen: the first row of a name (or a contract) owns its box.
  const boxOwners = priceBoxOwners(positions);
  const editorOwnership = betaEditorOwnership(positions);
  // A refusal of the owner's figure belongs to the name: shown beside its one box.
  const betaRefusals = new Map<number, GainsAtRiskBetaOverrideRefusal>();
  for (const p of positions) {
    if (p.identitySecurityId !== null && p.betaOverrideRefusal && !betaRefusals.has(p.identitySecurityId)) {
      betaRefusals.set(p.identitySecurityId, p.betaOverrideRefusal);
    }
  }
  const caption = betaEvidenceCaption(result.betaEvidence, driver);
  const ignored = overridesIgnoredLine(result.betaOverridesIgnored);
  const noLink = noMeasuredLinkSentence(selected.disclosures.noMeasuredLink, caseKey);

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
            <GainsAtRiskChart cases={result.cases} selectedCase={caseKey} driverSymbol={driver} yearGain={yearGain} />
          </div>
        )}
        <p className="text-xs text-ink-faint">{CHART_GAP_NOTE}</p>
      </section>

      {/* ── Table: fixed rows and a custom row ── */}
      <section className="bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-3" aria-label="Moves" aria-busy={mode === "stale"}>
        <ScrollFade>
          <table className={`w-full text-sm tabular-nums ${dim}`}>
            <thead>
              <tr className="text-xs text-ink-faint text-right">
                <th className="text-left font-normal py-1 pr-3 whitespace-nowrap">
                  {driver} {COLUMN_LABELS.move}
                </th>
                <th className="font-normal py-1 px-3 whitespace-nowrap">{COLUMN_LABELS.losers}</th>
                <th className="font-normal py-1 px-3 whitespace-nowrap">{COLUMN_LABELS.offsets}</th>
                <th className="font-normal py-1 px-3 whitespace-nowrap">{COLUMN_LABELS.book}</th>
                {shareShown && <th className="font-normal py-1 pl-3 whitespace-nowrap">{COLUMN_LABELS.givenBack}</th>}
              </tr>
            </thead>
            <tbody>
              {[...tableMoves, ...(customExtra && custom !== null ? [custom] : [])].map((move) => {
                const row = rowAt(move);
                const selected = sameMove(move, selectedMove);
                const isCustom = customExtra && custom !== null && sameMove(move, custom);
                const cell = row && !failed ? givenBackCell(row.bookPnlUsd, yearGain) : null;
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
                    <td className="text-right py-1.5 px-3 whitespace-nowrap">
                      <Money value={fig(row?.losersPnlUsd)} signed />
                    </td>
                    <td className="text-right py-1.5 px-3 whitespace-nowrap">
                      <Money value={fig(row?.offsetsPnlUsd)} signed />
                    </td>
                    <td className="text-right py-1.5 px-3 text-ink whitespace-nowrap">
                      <Money value={fig(row?.bookPnlUsd)} signed />
                    </td>
                    {shareShown && (
                      <td className="text-right py-1.5 pl-3 whitespace-nowrap">
                        {cell?.kind === "book-gains" ? (
                          <span className="text-ink-faint">{BOOK_GAINS_TEXT}</span>
                        ) : cell?.kind === "under-tenth" ? (
                          <PrivateText>{UNDER_TENTH_TEXT}</PrivateText>
                        ) : (
                          <Pct value={cell?.kind === "pct" ? cell.percent : null} />
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollFade>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="gains-custom-move" className="text-ink-faint text-xs">
            Custom {driver} move
          </label>
          <input
            id="gains-custom-move"
            type="number"
            inputMode="decimal"
            step={0.5}
            max={0}
            min={-60}
            placeholder="-7"
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
        <p className="text-xs text-ink-faint">
          Each name moves by its beta times the index&apos;s move. In a real fall a name can move more than that, or alone.
          Pick a row above to see that move.
        </p>
        {!failed && (
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
        {!failed && caption.notCaptured && (
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
                <th className="font-normal py-1 pr-3 whitespace-nowrap">Your figure</th>
                <th className="font-normal py-1 pr-3 whitespace-nowrap">Price</th>
                <SortableHeader field="loss" sort={sort} onSort={setSort} align="right" className="whitespace-nowrap">
                  {selectedIdx >= 0 ? <>Result at {formatDriverMove(selected.moves[selectedIdx].move)}</> : "Result"}
                </SortableHeader>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const key = `${p.accountId}:${p.securityId}`;
                const editor = editorOwnership.get(key);
                return (
                  <PositionRow
                    key={key}
                    p={p}
                    mode={mode}
                    caseKey={caseKey}
                    driver={driver}
                    pnl={selectedIdx >= 0 ? fig(p.cases[caseKey].pnlByMove[selectedIdx]) : null}
                    ownsBox={boxOwners.has(key)}
                    draft={overrideDrafts[p.securityId]}
                    problem={overrideProblems[p.securityId] ?? null}
                    hasOverride={Object.prototype.hasOwnProperty.call(priceOverrides, p.securityId)}
                    onDraft={(v) => onOverrideDraft(p.securityId, v)}
                    onCommit={() => onOverrideCommit(p.securityId)}
                    onClear={() => onOverrideClear(p.securityId)}
                    ownsEditor={editor?.owner === true}
                    sameFigure={editor && !editor.owner ? sameFigureText(editor.ownerSymbol, p.symbol) : null}
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
        {disclosureSentences(selected.disclosures).map((d) => {
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
      </section>
    </>
  );
}

function PositionRow({
  p,
  mode,
  caseKey,
  driver,
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
  p: GainsAtRiskPosition;
  mode: FigureMode;
  caseKey: GainsAtRiskCaseKey;
  driver: string;
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
  const source = betaSourceLine(p, caseKey);
  return (
    <tr className="border-t border-edge align-top">
      <td className="py-1.5 pr-3 text-ink-faint whitespace-nowrap">{p.accountName}</td>
      <td className="py-1.5 pr-3">
        <span className="font-mono text-ink">{p.symbol}</span>
        {pc.side === "offsets" && (
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
        {source.text}
        {source.details.map((d) => (
          <span key={d} className="block text-[11px] text-ink-faint">
            {d}
          </span>
        ))}
      </td>
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

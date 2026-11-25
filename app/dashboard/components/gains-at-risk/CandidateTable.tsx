"use client";

import { useState, type KeyboardEvent } from "react";
import { Count, Money, Pct, PrivateNumberInput, PrivateText } from "@/lib/privacy/components";
import { CANDIDATE_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import { UNDER_TENTH_TEXT } from "@/lib/analysis/gains-at-risk-view";
import {
  BUDGET_PENDING_TEXT,
  CANDIDATE_SORT_OPTIONS,
  CAPPED_TEXT,
  IN_TRIALS_MARK,
  IN_TRIALS_NOTE,
  candidateAddBlocked,
  candidateCells,
  candidateContractText,
  isCandidateSortKey,
  observationTimesLine,
  quoteAgeLine,
  signedMovePct,
  sortCandidateRows,
  type CandidateCells,
  type CandidateRowState,
  type CandidateSortKey,
  type CandidatesState,
} from "@/lib/analysis/gains-at-risk-candidates-view";
import { formatMarketPrice } from "@/lib/analysis/gains-at-risk-trial-view";
// Types only.
import type { GainsAtRiskCaseKey } from "@/lib/compute/gains-at-risk";
import type { YearGainResult } from "@/lib/compute/year-gain";
import { CHIP_TONE_TEXT } from "../chip-tone-text";
import { ScrollFade } from "../ScrollFade";

const buttonClass =
  "px-2 py-1 rounded-md border border-edge text-xs text-ink-dim hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed";

const onEnterBlur = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") e.currentTarget.blur();
};

/** A per-contract price: market data (the mid x 100), plain. */
function perContractText(usd: number | null): string {
  return usd === null ? "—" : `$${formatMarketPrice(usd)}`;
}

interface RowProps {
  row: CandidateRowState;
  /** Ruling (S6 fix 1): this contract already has a trial position. */
  inTrial: boolean;
  cells: CandidateCells;
  addBlockedText: string | null;
  waitingText: string;
  now: Date;
  onAdd: () => void;
  onRemove: () => void;
}

/**
 * The candidate table (R2, P12, P15, P22). Rows stay in pull order until the
 * owner picks a column in the native sort select; rows with no figures sort
 * last. No column is called better or best. Figures show only from the
 * answer to the inputs on screen (the reducer clears them otherwise).
 * Bid, ask, mid, strikes and expiries are plain; the budget, contracts, cost
 * and every book figure go through the privacy components. A phone shows one
 * card per row; a wider screen shows the table inside ScrollFade.
 */
export function CandidateTable({
  state,
  budgetDraft,
  budgetProblem,
  onBudgetDraft,
  onBudgetCommit,
  selectedMove,
  crossingHeadingText,
  driverSymbol,
  caseKey,
  yearGain,
  trialCount,
  inTrials,
  now,
  onAdd,
  onRemove,
  onRetryCompute,
}: {
  state: CandidatesState;
  budgetDraft: string;
  budgetProblem: string | null;
  onBudgetDraft: (text: string) => void;
  onBudgetCommit: () => void;
  selectedMove: number;
  crossingHeadingText: string;
  driverSymbol: string;
  caseKey: GainsAtRiskCaseKey;
  yearGain: YearGainResult;
  trialCount: number;
  /** The broker contract ids already in the trial list. */
  inTrials: ReadonlySet<number>;
  now: Date;
  onAdd: (row: CandidateRowState) => void;
  onRemove: (conId: number) => void;
  /** S6 fix 1 (item 8): ask a failed compute again. */
  onRetryCompute: () => void;
}) {
  const [sortKey, setSortKey] = useState<CandidateSortKey>("none");
  const sorted = sortCandidateRows(state.rows, sortKey, caseKey, yearGain);
  // Item 9: a typed budget not yet applied: the figures below are for the applied one, dimmed until Enter.
  const budgetPending = budgetDraft !== state.budgetUsdText;
  const anyInTrials = state.rows.some((r) => inTrials.has(r.conId));
  const computing = state.computingSeq !== null && state.computingSeq === state.computeSeq;
  const waitingText = computing ? "Computing…" : (state.computeProblem ?? budgetProblem ?? "—");
  const selectedLabel = `At ${signedMovePct(selectedMove)}`;
  const rowProps = (r: CandidateRowState): RowProps => ({
    row: r,
    inTrial: inTrials.has(r.conId),
    cells: candidateCells(r, caseKey, yearGain, driverSymbol),
    addBlockedText: candidateAddBlocked(r, state, state.figuresSeq, trialCount, inTrials)?.text ?? null,
    waitingText,
    now,
    onAdd: () => onAdd(r),
    onRemove: () => onRemove(r.conId),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <label className="space-y-1">
          <span className="block text-xs text-ink-faint">Budget ($)</span>
          <PrivateNumberInput
            inputMode="decimal"
            step={0.01}
            min={0.01}
            max={CANDIDATE_BOUNDS.maxBudgetUsd}
            value={budgetDraft}
            onChange={(e) => onBudgetDraft(e.target.value)}
            onBlur={onBudgetCommit}
            onKeyDown={onEnterBlur}
            className="w-32 px-2 py-1.5 rounded-md border border-edge bg-raised text-sm text-ink tabular-nums"
          />
        </label>
        <p className="text-xs text-ink-dim">At the selected move: {driverSymbol} {signedMovePct(selectedMove)}</p>
        <label className="space-y-1 min-w-0 max-w-full">
          <span className="block text-xs text-ink-faint">Sort</span>
          <select
            value={sortKey}
            onChange={(e) => {
              if (isCandidateSortKey(e.target.value)) setSortKey(e.target.value);
            }}
            className="w-full min-w-0 max-w-full px-2 py-1.5 rounded-md border border-edge bg-raised text-sm text-ink"
          >
            {CANDIDATE_SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {budgetPending && <p className="text-xs text-ink-dim">{BUDGET_PENDING_TEXT}</p>}
      {budgetProblem && <p className={`text-xs ${CHIP_TONE_TEXT.warn}`}>{budgetProblem}</p>}
      {state.computeProblem && (
        <div className="flex flex-wrap items-center gap-2">
          <p className={`text-xs ${CHIP_TONE_TEXT.warn}`}>{state.computeProblem}</p>
          <button type="button" onClick={onRetryCompute} className={buttonClass}>
            Try again
          </button>
        </div>
      )}

      {sorted.length === 0 ? (
        <p className="text-xs text-ink-faint">No contracts yet. Pick strikes above and get quotes.</p>
      ) : (
        <div className={budgetPending ? "opacity-60" : undefined}>
          {/* Phone: one card per row. */}
          <ul className="md:hidden space-y-2">
            {sorted.map((r) => (
              <CandidateCard key={r.conId} {...rowProps(r)} selectedLabel={selectedLabel} crossingHeadingText={crossingHeadingText} />
            ))}
          </ul>
          {/* Wider screens: the table, scrolling inside its own box. */}
          <div className="hidden md:block">
            <ScrollFade>
              <table className="min-w-full text-xs tabular-nums">
                <thead>
                  <tr className="text-left text-ink-faint">
                    <th className="py-1 pr-3 font-normal whitespace-nowrap!">Contract</th>
                    <th className="py-1 pr-3 font-normal whitespace-nowrap!">Bid / Ask</th>
                    <th className="py-1 pr-3 font-normal whitespace-nowrap!">Mid</th>
                    <th className="py-1 pr-3 font-normal whitespace-nowrap!">Per contract</th>
                    <th className="py-1 pr-3 font-normal whitespace-nowrap!">Contracts</th>
                    <th className="py-1 pr-3 font-normal whitespace-nowrap!">Cost</th>
                    <th className="py-1 pr-3 font-normal whitespace-nowrap!">{selectedLabel}</th>
                    <th className="py-1 pr-3 font-normal whitespace-nowrap!">At 0%</th>
                    <th className="py-1 pr-3 font-normal whitespace-nowrap!">{crossingHeadingText}</th>
                    <th className="py-1 pr-3 font-normal whitespace-nowrap!">Cost / year&apos;s gain</th>
                    <th className="py-1 font-normal" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <CandidateTableRow key={r.conId} {...rowProps(r)} />
                  ))}
                </tbody>
              </table>
            </ScrollFade>
          </div>
          {anyInTrials && <p className="mt-2 text-xs text-ink-faint">{IN_TRIALS_NOTE}</p>}
        </div>
      )}
    </div>
  );
}

function ShareCell({ share }: { share: Extract<CandidateCells, { kind: "priced" }>["costShare"] }) {
  if (share === null) return <>—</>;
  return share.kind === "under-tenth" ? <PrivateText>{UNDER_TENTH_TEXT}</PrivateText> : <Pct value={share.percent} />;
}

/** The quote line (P15) and the two arrival times behind a button (D6; never a hover). */
function QuoteLines({ row, inTrial, now }: { row: CandidateRowState; inTrial: boolean; now: Date }) {
  const [showTimes, setShowTimes] = useState(false);
  const q = row.quote;
  return (
    <div className="space-y-0.5">
      {inTrial && <p className="text-ink-dim">{IN_TRIALS_MARK}</p>}
      {q && <p className="text-ink-faint">{quoteAgeLine(q, now)}</p>}
      {row.quoteProblem && q && <p className={CHIP_TONE_TEXT.warn}>{row.quoteProblem}</p>}
      {q && (
        <button type="button" onClick={() => setShowTimes((v) => !v)} aria-expanded={showTimes} className="text-ink-dim underline">
          {showTimes ? "Hide times" : "Show times"}
        </button>
      )}
      {q && showTimes && <p className="text-ink-faint">{observationTimesLine(q)}</p>}
    </div>
  );
}

function AddRemove({ addBlockedText, onAdd, onRemove, label }: Pick<RowProps, "addBlockedText" | "onAdd" | "onRemove"> & { label: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={addBlockedText !== null}
          onClick={onAdd}
          aria-label={`Add ${label} to trial positions`}
          className={`${buttonClass} whitespace-nowrap`}
        >
          Add to trial positions
        </button>
        <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className={buttonClass}>
          Remove
        </button>
      </div>
      {addBlockedText && <p className="text-ink-faint">{addBlockedText}</p>}
    </div>
  );
}

function CandidateTableRow({ row, inTrial, cells, addBlockedText, waitingText, now, onAdd, onRemove }: RowProps) {
  const q = row.quote;
  const label = candidateContractText(row);
  return (
    <tr className="border-t border-edge align-top">
      <td className="py-1.5 pr-3">
        <p className="font-mono text-ink whitespace-nowrap">{label}</p>
        <QuoteLines row={row} inTrial={inTrial} now={now} />
        {cells.kind === "priced" && cells.heldUnchangedText && <p className="text-ink-dim">{cells.heldUnchangedText}</p>}
      </td>
      <td className="py-1.5 pr-3 whitespace-nowrap">{q ? `${formatMarketPrice(q.bid)} / ${formatMarketPrice(q.ask)}` : ""}</td>
      <td className="py-1.5 pr-3">{q ? formatMarketPrice(q.mid) : ""}</td>
      {cells.kind === "no-quote" ? (
        <td colSpan={7} className={`py-1.5 pr-3 ${CHIP_TONE_TEXT.warn}`}>
          {cells.text}
        </td>
      ) : cells.kind === "waiting" ? (
        <>
          <td className="py-1.5 pr-3">{perContractText(cells.perContractUsd)}</td>
          <td colSpan={6} className="py-1.5 pr-3 text-ink-faint">
            {row.record ? waitingText : (row.quoteProblem ?? "—")}
          </td>
        </>
      ) : cells.kind === "zero-contracts" ? (
        <>
          <td className="py-1.5 pr-3">{perContractText(cells.perContractUsd)}</td>
          <td colSpan={6} className="py-1.5 pr-3 text-ink-dim">
            {cells.text}
          </td>
        </>
      ) : cells.kind === "refused" ? (
        <>
          <td className="py-1.5 pr-3">{perContractText(cells.perContractUsd)}</td>
          <td colSpan={6} className={`py-1.5 pr-3 ${CHIP_TONE_TEXT.warn}`}>
            {cells.text}
          </td>
        </>
      ) : (
        <>
          <td className="py-1.5 pr-3">{perContractText(cells.perContractUsd)}</td>
          <td className="py-1.5 pr-3">
            <Count value={cells.contracts} />
            {cells.capped && <p className="text-ink-faint">{CAPPED_TEXT}</p>}
          </td>
          <td className="py-1.5 pr-3">
            <Money value={cells.costUsd} />
          </td>
          <td className="py-1.5 pr-3">
            <Money value={cells.atSelectedUsd} signed />
          </td>
          <td className="py-1.5 pr-3">
            <Money value={cells.atZeroUsd} signed />
          </td>
          <td className="py-1.5 pr-3 whitespace-nowrap">{cells.crossingText ?? "—"}</td>
          <td className="py-1.5 pr-3">
            <ShareCell share={cells.costShare} />
          </td>
        </>
      )}
      <td className="py-1.5">
        <AddRemove addBlockedText={addBlockedText} onAdd={onAdd} onRemove={onRemove} label={label} />
      </td>
    </tr>
  );
}

function CandidateCard({
  row,
  inTrial,
  cells,
  addBlockedText,
  waitingText,
  now,
  onAdd,
  onRemove,
  selectedLabel,
  crossingHeadingText,
}: RowProps & { selectedLabel: string; crossingHeadingText: string }) {
  const q = row.quote;
  const label = candidateContractText(row);
  return (
    <li className="border-t border-edge pt-2 space-y-1 text-xs tabular-nums">
      <p className="font-mono text-sm text-ink break-words">{label}</p>
      {q && (
        <p className="text-ink-dim">
          Bid / ask {formatMarketPrice(q.bid)} / {formatMarketPrice(q.ask)} · mid {formatMarketPrice(q.mid)}
        </p>
      )}
      <QuoteLines row={row} inTrial={inTrial} now={now} />
      {cells.kind === "no-quote" && <p className={CHIP_TONE_TEXT.warn}>{cells.text}</p>}
      {cells.kind === "waiting" && (
        <p className="text-ink-faint">
          Per contract {perContractText(cells.perContractUsd)} · {row.record ? waitingText : (row.quoteProblem ?? "—")}
        </p>
      )}
      {cells.kind === "zero-contracts" && (
        <p className="text-ink-dim">
          Per contract {perContractText(cells.perContractUsd)} · {cells.text}
        </p>
      )}
      {cells.kind === "refused" && (
        <p className={CHIP_TONE_TEXT.warn}>
          Per contract {perContractText(cells.perContractUsd)} · {cells.text}
        </p>
      )}
      {cells.kind === "priced" && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          <dt className="text-ink-faint">Per contract</dt>
          <dd>{perContractText(cells.perContractUsd)}</dd>
          <dt className="text-ink-faint">Contracts</dt>
          <dd>
            <Count value={cells.contracts} />
            {cells.capped && <span className="text-ink-faint"> {CAPPED_TEXT}</span>}
          </dd>
          <dt className="text-ink-faint">Cost</dt>
          <dd>
            <Money value={cells.costUsd} />
          </dd>
          <dt className="text-ink-faint">{selectedLabel}</dt>
          <dd>
            <Money value={cells.atSelectedUsd} signed />
          </dd>
          <dt className="text-ink-faint">At 0%</dt>
          <dd>
            <Money value={cells.atZeroUsd} signed />
          </dd>
          <dt className="text-ink-faint">{crossingHeadingText}</dt>
          <dd>{cells.crossingText ?? "—"}</dd>
          <dt className="text-ink-faint">Cost / year&apos;s gain</dt>
          <dd>
            <ShareCell share={cells.costShare} />
          </dd>
        </dl>
      )}
      {cells.kind === "priced" && cells.heldUnchangedText && <p className="text-ink-dim">{cells.heldUnchangedText}</p>}
      <AddRemove addBlockedText={addBlockedText} onAdd={onAdd} onRemove={onRemove} label={label} />
    </li>
  );
}

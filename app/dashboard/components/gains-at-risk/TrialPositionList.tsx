"use client";

import { useState } from "react";
import { Count, Money, Pct, PrivateText, QuantityUnit } from "@/lib/privacy/components";
import { GAINS_ANCHORS, UNDER_TENTH_TEXT } from "@/lib/analysis/gains-at-risk-view";
import {
  TRIAL_LIMIT_TEXT,
  TRIAL_NOT_STORED_NOTE,
  TRIAL_SECTION_TITLE,
  TRIAL_TRY_BUTTON,
  TRIAL_ZERO_START_NOTE,
  formatMarketPrice,
  holdingsChangedNote,
  leavesShortNote,
  netCashLine,
  noLinkWarningNote,
  quoteLabel,
  shortByNameLines,
  staleCloseNote,
  trialCostLine,
  trialCostShareCell,
  trialEntryPrice,
  trialPositionLabel,
  trialRefusalNote,
  underlyingPriceNote,
  type TrialPositionState,
} from "@/lib/analysis/gains-at-risk-trial-view";
import { TRIAL_POSITION_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
// Types only: no engine code reaches the browser.
import type { GainsAtRiskTrialResult, GainsAtRiskTrialRow } from "@/lib/compute/gains-at-risk";
import type { YearGainResult } from "@/lib/compute/year-gain";
import { CHIP_TONE_TEXT } from "../chip-tone-text";
import { TrialPositionForm } from "./TrialPositionForm";
import { useTrialPositions } from "./TrialPositionsProvider";

const buttonClass = "px-2 py-1 rounded-md border border-edge text-xs text-ink-dim hover:text-ink";

/**
 * The trial positions: the "Try a position" button, the form (new or
 * editing one row), and the list with each row's cost and notes. Figures
 * come only from `trial`, the answer to the CURRENT set of trial positions
 * (the view passes null while a newer request runs or after a failure), so a
 * row never shows a cost computed for an older set. Nothing here is stored.
 */
export function TrialPositionsPanel({
  today,
  trial,
  computing,
  yearGain,
  tableBelow,
}: {
  today: string;
  /** Whether the per-name table is on screen below: only then may a note point to it. */
  tableBelow: boolean;
  /** The engine's trial result for the list as it stands; null while computing or after a failure. */
  trial: GainsAtRiskTrialResult | null;
  computing: boolean;
  yearGain: YearGainResult;
}) {
  const trials = useTrialPositions();
  // Which form is open: none, a new position, or the id of the one being edited.
  const [formFor, setFormFor] = useState<null | "new" | string>(null);
  if (!trials.available) return null;

  const full = trials.list.length >= TRIAL_POSITION_BOUNDS.maxPositions;
  const editing = formFor !== null && formFor !== "new" ? (trials.list.find((t) => t.position.id === formFor) ?? null) : null;
  const rowFor = (id: string): GainsAtRiskTrialRow | null => trial?.rows.find((r) => r.id === id) ?? null;
  const shortLines = trial ? shortByNameLines(trial) : [];
  const net = trial ? netCashLine(trial.netCashUsd) : null;

  return (
    <section id={GAINS_ANCHORS.trial} className="scroll-mt-4 bg-panel rounded-xl p-4 sm:p-5 card-elev space-y-3" aria-label={TRIAL_SECTION_TITLE}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink whitespace-nowrap!">{TRIAL_SECTION_TITLE}</h3>
        <button
          type="button"
          disabled={full || formFor !== null}
          onClick={() => setFormFor("new")}
          className={`${buttonClass} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {TRIAL_TRY_BUTTON}
        </button>
      </div>
      {full && formFor === null && <p className="text-xs text-ink-faint">{TRIAL_LIMIT_TEXT}</p>}

      {formFor !== null && (formFor === "new" || editing) && (
        <TrialPositionForm
          // A new key per target: an edit never inherits another form's replies.
          key={formFor}
          editing={editing}
          listCount={trials.list.length}
          today={today}
          onSave={(t) => (editing ? trials.edit(editing.position.id, t) : trials.add(t))}
          onClose={() => setFormFor(null)}
        />
      )}

      {trials.list.length > 0 && (
        <ul className="space-y-2">
          {trials.list.map((t) => (
            <TrialRow
              key={t.position.id}
              t={t}
              row={rowFor(t.position.id)}
              computing={computing}
              yearGain={yearGain}
              tableBelow={tableBelow}
              editDisabled={formFor !== null}
              onEdit={() => setFormFor(t.position.id)}
              onRemove={() => {
                if (formFor === t.position.id) setFormFor(null);
                trials.remove(t.position.id);
              }}
            />
          ))}
        </ul>
      )}

      {trial &&
        shortLines.map((s) => (
          <p key={s.securityId} className={`text-xs ${CHIP_TONE_TEXT.warn}`}>
            {s.before} <Count value={s.shortBy} /> {s.after}
            {s.alreadyShort && (
              <>
                {" "}
                {s.alreadyShort.before} <Count value={s.alreadyShort.count} /> {s.alreadyShort.after}
              </>
            )}
          </p>
        ))}
      {trial && net && trials.list.length > 0 && (
        <p className="text-sm text-ink-dim">
          Net cash:{" "}
          {net.verb === "none" ? (
            "none"
          ) : (
            <>
              {net.verb} <Money value={net.usd} />
            </>
          )}
        </p>
      )}
      {trial && trial.refusedCount > 0 && (
        <p className="text-xs text-ink-dim">
          <Count value={trial.refusedCount} /> of these add nothing; each says why.
        </p>
      )}
      {trial && trial.noLinkWarningCount > 0 && (
        <p className="text-xs text-ink-dim">
          <Count value={trial.noLinkWarningCount} /> of these options have no measured link to the index; see each.
        </p>
      )}
      {trials.list.length > 0 && <p className="text-xs text-ink-faint">{TRIAL_ZERO_START_NOTE}</p>}
      <p className="text-xs text-ink-faint">{TRIAL_NOT_STORED_NOTE}</p>
    </section>
  );
}

function TrialRow({
  t,
  row,
  computing,
  yearGain,
  tableBelow,
  editDisabled,
  onEdit,
  onRemove,
}: {
  t: TrialPositionState;
  row: GainsAtRiskTrialRow | null;
  computing: boolean;
  yearGain: YearGainResult;
  tableBelow: boolean;
  editDisabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const label = trialPositionLabel(t);
  const quote = quoteLabel(t);
  const underlying = underlyingPriceNote(t);
  const stale = staleCloseNote(t);
  const cost = row ? trialCostLine(row) : null;
  const share = row ? trialCostShareCell(row, yearGain) : null;
  const refusal = row ? trialRefusalNote(row, { tableBelow }) : null;
  const changed = row ? holdingsChangedNote(t, row) : null;
  const short = row ? leavesShortNote(row) : null;
  const noLink = row ? noLinkWarningNote(row, { tableBelow }) : null;
  return (
    <li className="border-t border-edge pt-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm text-ink">
          {label.verb} <Count value={label.count} />{" "}
          {label.unit && (
            <>
              <QuantityUnit securityType="stock" quantity={label.count} />{" "}
            </>
          )}
          <span className="font-mono">{label.text}</span>{" "}
          <span className="text-ink-dim">at {formatMarketPrice(trialEntryPrice(t))}</span>
        </p>
        {quote && <p className="text-xs text-ink-faint">{quote}</p>}
        {underlying && <p className="text-xs text-ink-faint">{underlying}</p>}
        {stale && <p className="text-xs text-ink-faint">{stale}</p>}
        {computing && !row && <p className="text-xs text-ink-faint">Computing…</p>}
        {cost && (
          <p className="text-xs text-ink-dim">
            {cost.verb} <Money value={cost.usd} />
            {cost.note ? ` ${cost.note}` : ""}
            {share !== null && (
              <>
                {" · "}
                {share.kind === "under-tenth" ? <PrivateText>{UNDER_TENTH_TEXT}</PrivateText> : <Pct value={share.percent} />} of
                the year&apos;s gain
              </>
            )}
          </p>
        )}
        {refusal && <p className={`text-xs ${CHIP_TONE_TEXT.warn}`}>{refusal}</p>}
        {changed && <p className={`text-xs ${CHIP_TONE_TEXT.warn}`}>{changed}</p>}
        {short && (
          <p className={`text-xs ${CHIP_TONE_TEXT.warn}`}>
            {short.before} <Count value={short.count} /> {short.after}
          </p>
        )}
        {noLink && <p className={`text-xs ${CHIP_TONE_TEXT.warn}`}>{noLink}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={editDisabled}
          onClick={onEdit}
          aria-label={`Edit the trial position ${label.text}`}
          className={`${buttonClass} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          Edit
        </button>
        <button type="button" onClick={onRemove} aria-label={`Remove the trial position ${label.text}`} className={buttonClass}>
          Remove
        </button>
      </div>
    </li>
  );
}

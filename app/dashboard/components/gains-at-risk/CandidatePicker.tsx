"use client";

import { CANDIDATE_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import {
  CANDIDATES_CONNECT_TEXT,
  chosenCountText,
  underlyingOptionLabel,
  type CandidatesState,
} from "@/lib/analysis/gains-at-risk-candidates-view";
import { formatMarketPrice, formatStrike } from "@/lib/analysis/gains-at-risk-trial-view";
// Types only.
import type { CandidateUnderlyingEntry } from "@/lib/compute/gains-at-risk-drivers";
import { CHIP_TONE_TEXT } from "../chip-tone-text";

const buttonClass =
  "px-2 py-1 rounded-md border border-edge text-xs text-ink-dim hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * The candidate picker (P11, D1, D4): the underlying (a native select of the
 * server's list, F8; no list is built here), puts or calls, up to three
 * expiries, then each chosen expiry's own strikes, 15 contracts at most in
 * all. Strikes, expiries and the valuation price are market data, plain.
 */
export function CandidatePicker({
  underlyings,
  underlyingSecurityId,
  state,
  canAskBroker,
  disconnected,
  pullBlockedText,
  onUnderlying,
  onRight,
  onExpiries,
  onShowStrikes,
  onChoose,
  onGetQuotes,
}: {
  underlyings: CandidateUnderlyingEntry[];
  underlyingSecurityId: number | null;
  state: CandidatesState;
  /** Broker connected and no pull running. */
  canAskBroker: boolean;
  /** P16: the broker is known to be disconnected. */
  disconnected: boolean;
  pullBlockedText: string | null;
  onUnderlying: (securityId: number) => void;
  onRight: (right: "put" | "call") => void;
  onExpiries: (expiries: string[]) => void;
  onShowStrikes: () => void;
  onChoose: (conIds: number[]) => void;
  onGetQuotes: () => void;
}) {
  const maxExpiries = CANDIDATE_BOUNDS.maxExpiriesPerPull;
  const maxContracts = CANDIDATE_BOUNDS.maxContractsPerPull;
  const chosen = new Set(state.chosenConIds);
  const full = state.chosenConIds.length >= maxContracts;

  function toggleExpiry(expiry: string, on: boolean) {
    onExpiries(on ? [...state.chosenExpiries, expiry] : state.chosenExpiries.filter((e) => e !== expiry));
  }
  function toggleContract(conId: number, on: boolean) {
    onChoose(on ? [...state.chosenConIds, conId] : state.chosenConIds.filter((id) => id !== conId));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <label className="space-y-1 min-w-0 max-w-full">
          <span className="block text-xs text-ink-faint">Underlying</span>
          <select
            value={underlyingSecurityId ?? ""}
            onChange={(e) => {
              const id = Number(e.target.value);
              if (Number.isSafeInteger(id) && id > 0) onUnderlying(id);
            }}
            className="w-full min-w-0 max-w-full px-2 py-1.5 rounded-md border border-edge bg-raised text-sm text-ink"
          >
            {underlyingSecurityId === null && <option value="">Pick a name</option>}
            {underlyings.map((u) => (
              <option key={u.securityId} value={u.securityId}>
                {underlyingOptionLabel(u)}
              </option>
            ))}
          </select>
        </label>
        <div className="space-y-1">
          <span className="block text-xs text-ink-faint">Right</span>
          <div className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 w-fit" role="group" aria-label="Right">
            {(["put", "call"] as const).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={state.right === r}
                onClick={() => onRight(r)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                  state.right === r ? "bg-panel text-ink shadow-sm" : "text-ink-dim hover:text-ink"
                }`}
              >
                {r === "put" ? "Puts" : "Calls"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {state.chainPending && <p className="text-xs text-ink-faint">Asking the broker…</p>}
      {state.chainProblem && <p className={`text-xs ${CHIP_TONE_TEXT.warn}`}>{state.chainProblem}</p>}

      {state.expiries !== null && (
        <fieldset className="space-y-1">
          <legend className="text-xs text-ink-faint">Expiries (up to {maxExpiries})</legend>
          {state.expiries.length === 0 ? (
            <p className="text-xs text-ink-dim">The broker lists no expiries for this name.</p>
          ) : (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {state.expiries.map((e) => {
                const on = state.chosenExpiries.includes(e);
                return (
                  <label key={e} className="inline-flex items-center gap-1 text-xs text-ink-dim">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!on && state.chosenExpiries.length >= maxExpiries}
                      onChange={(ev) => toggleExpiry(e, ev.target.checked)}
                    />
                    {e}
                  </label>
                );
              })}
            </div>
          )}
          <button
            type="button"
            disabled={!canAskBroker || state.chosenExpiries.length === 0 || state.chainPending}
            onClick={onShowStrikes}
            className={buttonClass}
          >
            Show strikes
          </button>
        </fieldset>
      )}

      {state.strikes !== null && (
        <fieldset className="space-y-2">
          <legend className="text-xs text-ink-faint">
            Strikes
            {state.strikes.valuationPrice !== null
              ? ` (by default the five nearest on the out-of-the-money side of ${formatMarketPrice(state.strikes.valuationPrice)})`
              : ""}
          </legend>
          {state.strikes.byExpiry.map((e) => (
            <div key={e.expiry} className="space-y-1">
              <p className="text-xs text-ink-dim">{e.expiry}</p>
              {e.contracts.length === 0 ? (
                <p className="text-xs text-ink-faint">No standard contracts for this expiry.</p>
              ) : (
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {[...e.contracts]
                    .sort((a, b) => a.strike - b.strike)
                    .map((c) => {
                      const on = chosen.has(c.conId);
                      return (
                        <label key={c.conId} className="inline-flex items-center gap-1 text-xs text-ink-dim tabular-nums">
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={!on && full}
                            onChange={(ev) => toggleContract(c.conId, ev.target.checked)}
                          />
                          {formatStrike(c.strike)}
                        </label>
                      );
                    })}
                </div>
              )}
              {e.droppedNonStandard + e.droppedAmbiguous > 0 && (
                <p className="text-xs text-ink-faint">Contracts that are not standard are left out.</p>
              )}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!canAskBroker || state.chosenConIds.length === 0 || pullBlockedText !== null}
              onClick={onGetQuotes}
              className={buttonClass}
            >
              Get quotes
            </button>
            <span className="text-xs text-ink-faint">{chosenCountText(state.chosenConIds.length)}</span>
          </div>
          {pullBlockedText && <p className="text-xs text-ink-dim">{pullBlockedText}</p>}
          {disconnected && <p className="text-xs text-ink-faint">{CANDIDATES_CONNECT_TEXT}</p>}
        </fieldset>
      )}
    </div>
  );
}

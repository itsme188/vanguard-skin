"use client";

import { useState, type ReactNode } from "react";
import { CANDIDATE_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import {
  CANDIDATES_CONNECT_TEXT,
  STRIKES_NEAR_NOTE,
  chosenCountText,
  priceMarkerIndex,
  storedPriceLine,
  strikeSideText,
  underlyingOptionLabel,
  visibleStrikes,
  type CandidatesState,
} from "@/lib/analysis/gains-at-risk-candidates-view";
import { formatMarketPrice, formatStrike } from "@/lib/analysis/gains-at-risk-trial-view";
// Types only.
import type { CandidateUnderlyingEntry } from "@/lib/compute/gains-at-risk-drivers";
import type { ChainContract } from "@/lib/analysis/gains-at-risk-candidates-input";
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
  symbol,
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
  /** The picker's underlying symbol, for the price line. */
  symbol: string;
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
  const priceLine = state.strikes ? storedPriceLine(symbol, state.strikes.valuationPrice, state.strikes.valuationPriceDate, state.strikes.valuationPriceSource) : null;
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
          <legend className="text-xs text-ink-faint">Strikes</legend>
          {priceLine && (
            <p className="text-sm text-ink">
              {priceLine} <span className="text-xs text-ink-dim">{strikeSideText(state.right)}</span>
            </p>
          )}
          {state.strikes.valuationPrice !== null && (
            <p className="text-xs text-ink-faint">{STRIKES_NEAR_NOTE}</p>
          )}
          {state.strikes.byExpiry.map((e) => (
            <ExpiryStrikes
              key={e.expiry}
              expiry={e.expiry}
              contracts={e.contracts}
              price={state.strikes?.valuationPrice ?? null}
              chosenConIds={state.chosenConIds}
              full={full}
              droppedCount={e.droppedNonStandard + e.droppedAmbiguous}
              onToggle={toggleContract}
            />
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

/**
 * One expiry's strikes: by default the 15 listed on each side of the price
 * (and any already ticked), with a button to show every strike. A plain
 * marker with the price sits between the two strikes it falls between.
 */
function ExpiryStrikes({
  expiry,
  contracts,
  price,
  chosenConIds,
  full,
  droppedCount,
  onToggle,
}: {
  expiry: string;
  contracts: ChainContract[];
  price: number | null;
  chosenConIds: number[];
  full: boolean;
  droppedCount: number;
  onToggle: (conId: number, on: boolean) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const near = visibleStrikes(contracts, price, chosenConIds);
  const shown = showAll ? visibleStrikes(contracts, null, chosenConIds) : near;
  const marker = priceMarkerIndex(shown, price);
  const chosen = new Set(chosenConIds);
  const hidden = contracts.length - near.length;
  const items: ReactNode[] = shown.map((c) => {
    const on = chosen.has(c.conId);
    return (
      <label key={c.conId} className="inline-flex items-center gap-1 text-xs text-ink-dim tabular-nums">
        <input type="checkbox" checked={on} disabled={!on && full} onChange={(ev) => onToggle(c.conId, ev.target.checked)} />
        {formatStrike(c.strike)}
      </label>
    );
  });
  if (marker !== null && price !== null) {
    items.splice(
      marker,
      0,
      <span key="price" className="inline-flex items-center gap-1 border-l-2 border-ink-dim pl-1 text-xs text-ink tabular-nums">
        price {formatMarketPrice(price)}
      </span>,
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-xs text-ink-dim">{expiry}</p>
      {contracts.length === 0 ? (
        <p className="text-xs text-ink-faint">No standard contracts for this expiry.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{items}</div>
      )}
      {hidden > 0 && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className={buttonClass}>
          {showAll ? "Show fewer" : "Show all strikes"}
        </button>
      )}
      {droppedCount > 0 && <p className="text-xs text-ink-faint">Contracts that are not standard are left out.</p>}
    </div>
  );
}

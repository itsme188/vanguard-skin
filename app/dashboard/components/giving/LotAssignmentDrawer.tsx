"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { OpenLotForDonation } from "@/lib/queries/giving-view";
import { Money, PrivateNumberInput, Shares } from "@/lib/privacy/components";
import { Chip } from "../Chip";
import { useToast } from "../Toast";
import apiFetch from "@/lib/http/apiFetch";
import { LedgerRecomputeDialog, useLedgerRecomputeFlow } from "./LedgerRecomputeDialog";
import { withLedgerAck } from "./ledger-recompute-flow";

/**
 * Lot-assignment drawer (Task 13) — skeleton copied from
 * MacroThemeReceiptDrawer (fixed overlay z-[55], Escape handler, backdrop
 * click, stopPropagation). Lists open lots AS OF the donation's OUT-leg
 * date, served verbatim by GET /api/donations/:id/lots — this component
 * never recomputes `remainingAsOfDonationDate` client-side (today's
 * quantity_remaining would price the gift on the wrong post-split basis).
 *
 * "Suggest highest-gain long-term" preselects client-side from the API's
 * own `suggested`/`suggestedQuantity` flags. Save POSTs the current
 * selections (replace semantics); "Clear assignments" POSTs an empty array
 * (Codex plan-review #5).
 *
 * Both end in a recompute of the ENTIRE tax-lot ledger, so both go through
 * the disclose-and-confirm flow (owner ruling 2026-10-06,
 * LedgerRecomputeDialog): the first request carries no acknowledgement, the
 * server refuses it and writes nothing, the dialog says what a recompute
 * rebuilds and asks; only a confirmed request saves. The dialog then shows
 * progress and what moved. The drawer closes only after a saved change's
 * result has been read and closed.
 */

interface LotAssignmentDrawerProps {
  donationId: number;
  symbol: string;
  targetQuantity: number | null;
  onClose: () => void;
}

interface LotsResponse {
  success: boolean;
  data?: { lots: OpenLotForDonation[] };
  error?: string;
}

export function LotAssignmentDrawer({
  donationId,
  symbol,
  targetQuantity,
  onClose,
}: LotAssignmentDrawerProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [lots, setLots] = useState<OpenLotForDonation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<number, number>>({});
  const flow = useLedgerRecomputeFlow();
  const flowActive = flow.active;

  // Close on Escape — same idiom as MacroThemeReceiptDrawer/TrustStripDrawer.
  // Not while the recompute dialog is up: closing the drawer would unmount
  // the dialog and hide a running recompute and its result.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !flowActive) onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, flowActive]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await apiFetch(`/api/donations/${donationId}/lots`);
        const json = (await res.json()) as LotsResponse;
        if (cancelled) return;
        if (!res.ok || !json.success || !json.data) {
          setLoadError(json.error ?? "Failed to load open lots");
          return;
        }
        setLots(json.data.lots);
        // Pre-fill from this donation's OWN current per-lot assignment
        // (controller ruling, 2026-08-17) — "Edit lots" now opens showing
        // what's actually saved instead of always starting blank. Save
        // still fully replaces (assignDonationLots' replace semantics);
        // the explicit "Clear assignments" button remains the only clear
        // path (Save-with-0-selected stays blocked below).
        const initial: Record<number, number> = {};
        for (const lot of json.data.lots) {
          if (lot.currentlyAssignedQuantity > 0) initial[lot.acquisitionTransactionId] = lot.currentlyAssignedQuantity;
        }
        setSelections(initial);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load open lots");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [donationId]);

  function totalSelected(source: Record<number, number>): number {
    return Object.values(source).reduce((sum, v) => sum + v, 0);
  }

  function toggleLot(lot: OpenLotForDonation) {
    setSelections((prev) => {
      const next = { ...prev };
      if ((next[lot.acquisitionTransactionId] ?? 0) > 0) {
        delete next[lot.acquisitionTransactionId];
        return next;
      }
      const remainingNeeded =
        targetQuantity != null ? Math.max(0, targetQuantity - totalSelected(prev)) : lot.remainingAsOfDonationDate;
      next[lot.acquisitionTransactionId] = Math.min(
        lot.remainingAsOfDonationDate,
        remainingNeeded > 0 ? remainingNeeded : lot.remainingAsOfDonationDate
      );
      return next;
    });
  }

  function setQty(lot: OpenLotForDonation, raw: string) {
    const value = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    setSelections((prev) => {
      const next = { ...prev };
      if (value <= 0) delete next[lot.acquisitionTransactionId];
      else next[lot.acquisitionTransactionId] = Math.min(value, lot.remainingAsOfDonationDate);
      return next;
    });
  }

  function applySuggestion() {
    if (!lots) return;
    const next: Record<number, number> = {};
    for (const lot of lots) {
      if (lot.suggested && lot.suggestedQuantity > 0) next[lot.acquisitionTransactionId] = lot.suggestedQuantity;
    }
    setSelections(next);
  }

  function submit(assignments: { acquisitionTransactionId: number; quantity: number }[], mode: "save" | "clear") {
    // flow.start ignores a second click while a request is out or the dialog is up.
    flow.start({
      title: mode === "clear" ? "Clearing these lot assignments" : "Saving these lot assignments",
      send: (acknowledged) =>
        apiFetch(`/api/donations/${donationId}/lots`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withLedgerAck({ assignments }, acknowledged)),
        }),
      // Not saved (cancelled or refused): the drawer stays open with the picks intact.
      onClosed: (saved) => {
        if (!saved) return;
        router.refresh();
        onClose();
      },
    });
  }

  function handleSave() {
    const assignments = Object.entries(selections)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => ({ acquisitionTransactionId: Number(id), quantity: qty }));
    if (assignments.length === 0) {
      toast("Select at least one lot, or use Clear assignments to remove them.", "error");
      return;
    }
    submit(assignments, "save");
  }

  function handleClear() {
    submit([], "clear");
  }

  const selectedTotal = totalSelected(selections);

  return (
    <div
      className="fixed inset-0 z-[55] flex"
      onClick={() => {
        if (!flowActive) onClose();
      }}
      role="dialog"
      aria-label={`Assign lots for ${symbol}`}
    >
      <div className="flex-1 bg-black/30" aria-hidden="true" />
      <aside
        className="w-full max-w-md bg-panel border-l border-edge p-5 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Inside the aside (which stops click propagation) so a click in the
            dialog never reaches the backdrop's close handler. */}
        <LedgerRecomputeDialog flow={flow} />
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-ink">Assign lots — {symbol}</h2>
            <p className="text-xs text-ink-faint mt-1">
              Open lots as of the donation&apos;s OUT-leg date.
              {targetQuantity != null && (
                <>
                  {" "}
                  Target <Shares value={targetQuantity} digits={4} /> sh · Selected{" "}
                  <Shares value={selectedTotal} digits={4} /> sh
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-faint hover:text-ink text-sm shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {loadError && <p className="text-sm text-down mb-3">{loadError}</p>}

        {!lots && !loadError && <p className="text-sm text-ink-faint">Loading open lots…</p>}

        {lots && lots.length === 0 && (
          <p className="text-sm text-ink-faint">No open lots found before the donation&apos;s OUT-leg date.</p>
        )}

        {lots && lots.length > 0 && (
          <>
            <div className="flex justify-end mb-2">
              <button
                type="button"
                onClick={applySuggestion}
                className="text-xs px-2.5 py-1 rounded-md border border-edge text-ink-dim hover:text-ink hover:border-edge-strong transition-colors focus-ring"
              >
                Suggest highest-gain long-term
              </button>
            </div>
            <ul className="space-y-2 mb-4">
              {lots.map((lot) => {
                const checked = (selections[lot.acquisitionTransactionId] ?? 0) > 0;
                const disabled = lot.remainingAsOfDonationDate <= 0;
                return (
                  <li key={lot.acquisitionTransactionId} className="rounded-lg border border-edge px-3 py-2">
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleLot(lot)}
                        disabled={disabled}
                        className="mt-0.5"
                      />
                      <span className="flex-1">
                        <span className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono text-ink-dim">{lot.acquisitionDate}</span>
                          <Chip tone={lot.isLongTerm ? "up" : "neutral"} size="xs">
                            {lot.isLongTerm ? "LT" : "ST"}
                          </Chip>
                          {lot.gainPerShare != null && (
                            <span className="text-xs text-ink-faint">
                              <Money value={lot.gainPerShare} precise /> /sh gain
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-ink-faint mt-0.5">
                          Available <Shares value={lot.remainingAsOfDonationDate} digits={4} /> sh · Cost basis{" "}
                          <Money value={lot.costBasis} />
                        </span>
                      </span>
                    </label>
                    {checked && (
                      <div className="mt-2 pl-6">
                        <PrivateNumberInput
                          aria-label={`Shares to assign from lot ${lot.acquisitionTransactionId}`}
                          min={0}
                          max={lot.remainingAsOfDonationDate}
                          step="any"
                          value={selections[lot.acquisitionTransactionId] ?? 0}
                          onChange={(e) => setQty(lot, e.target.value)}
                          className="w-28 rounded-md bg-raised border border-edge px-2 py-1 text-xs text-ink font-mono"
                        />
                        <span className="text-xs text-ink-faint ml-1.5">
                          of <Shares value={lot.remainingAsOfDonationDate} digits={4} /> sh
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <p className="text-xs text-ink-dim pt-2 border-t border-edge">
          Saving or clearing recomputes the entire tax-lot ledger. You will be asked to confirm first.
        </p>
        <div className="flex items-center justify-between gap-2 pt-2">
          <button
            type="button"
            onClick={handleClear}
            disabled={flowActive}
            className="px-3 py-2 rounded-lg border border-edge text-xs font-medium text-ink-dim hover:text-down hover:border-down/40 transition-colors disabled:opacity-50 focus-ring"
          >
            Clear assignments
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={flowActive || !lots || lots.length === 0}
            className="px-4 py-2 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 disabled:opacity-50 transition-[filter,scale] active:scale-[0.96] focus-ring"
          >
            Save
          </button>
        </div>
      </aside>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Count } from "@/lib/privacy/components";
import type { LedgerCensus, LedgerRecomputeReport } from "@/lib/compute/donation-recompute-contract";
import {
  LedgerFlowController,
  isLedgerFlowBusy,
  ledgerUnchanged,
  type LedgerFlowAction,
  type LedgerFlowPhase,
} from "./ledger-recompute-flow";

/**
 * Disclose, confirm, progress, result — the one dialog every Giving mutation
 * goes through (owner ruling 2026-10-06). Each of those mutations ends in a
 * recompute of the ENTIRE tax-lot ledger, so the user is told before it runs,
 * sees that it is running, and is told what moved.
 *
 * `useLedgerRecomputeFlow` owns the state; `LedgerRecomputeDialog` draws it.
 * The page behind is refreshed only when the result is closed, so a row that
 * disappears on refresh cannot take the result away with it.
 */

export interface LedgerRecomputeFlow {
  phase: LedgerFlowPhase;
  /** True from the first click until the dialog is closed. */
  active: boolean;
  /** Ignored unless idle — a second click never sends a second request. */
  start: (action: LedgerFlowAction) => void;
  /** The user said yes at the confirm step. Ignored in any other phase. */
  proceed: () => void;
  /** Cancel or Close. Ignored while a request is out. */
  close: () => void;
}

export function useLedgerRecomputeFlow(): LedgerRecomputeFlow {
  // The state machine lives outside React (LedgerFlowController) so its
  // guards do not depend on render timing: two clicks in one frame both hit
  // the same controller, and the second is ignored.
  const [controller] = useState(() => new LedgerFlowController());
  const phase = useSyncExternalStore(controller.subscribe, controller.getPhase, controller.getPhase);
  const start = useCallback(
    (action: LedgerFlowAction) => {
      void controller.start(action);
    },
    [controller]
  );
  const proceed = useCallback(() => {
    void controller.proceed();
  }, [controller]);
  const close = useCallback(() => {
    controller.close();
  }, [controller]);
  return { phase, active: phase.kind !== "idle", start, proceed, close };
}

function CensusList({ census }: { census: LedgerCensus }) {
  return (
    <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
      <dt className="text-ink-dim">Closed sales (Estimated closes included)</dt>
      <dd className="text-right font-mono tabular-nums text-ink">
        <Count value={census.closedSales} />
      </dd>
      <dt className="text-ink-dim">Open lots</dt>
      <dd className="text-right font-mono tabular-nums text-ink">
        <Count value={census.openLots} />
      </dd>
      <dt className="text-ink-dim">Estimated closes</dt>
      <dd className="text-right font-mono tabular-nums text-ink">
        <Count value={census.engineCloses} />
      </dd>
    </dl>
  );
}

/** The dialog's heading and body for one phase. Exported for the render tests. */
export function LedgerRecomputeBody({ phase }: { phase: LedgerFlowPhase }) {
  if (phase.kind === "idle") return null;

  if (phase.kind === "checking") {
    return (
      <div role="status" aria-live="polite">
        <h3 className="text-base font-medium mb-2">Checking the ledger…</h3>
        <p className="text-sm text-ink-dim">
          {phase.title} recomputes the entire tax-lot ledger. Nothing has been saved yet.
        </p>
      </div>
    );
  }

  if (phase.kind === "confirm") {
    return (
      <div>
        <h3 className="text-base font-medium mb-2">Recompute the entire tax-lot ledger?</h3>
        <p className="text-sm text-ink-dim">
          {phase.title} recomputes the entire tax-lot ledger, not just this gift. Every tax lot and every
          closed sale in the book is rebuilt. Realized gains and the tax tiles can move, Estimated closes
          can be added or dropped, and saved trade reviews can go out of date.
        </p>
        {phase.acceptedTaxYearsAffected > 0 && (
          <p className="text-sm text-warn mt-3">
            <Count value={phase.acceptedTaxYearsAffected} className="font-mono font-medium" /> accepted account tax
            year(s) will go back to not-for-filing until they are reconciled again.
          </p>
        )}
        <p className="text-xs text-ink-faint mt-3">The ledger now holds:</p>
        <CensusList census={phase.census} />
        <p className="text-sm text-ink-dim mt-3">
          This can take a while on a large ledger. It cannot be cancelled once it starts. Nothing has been
          saved yet.
        </p>
      </div>
    );
  }

  if (phase.kind === "running") {
    return (
      <div role="status" aria-live="polite">
        <h3 className="text-base font-medium mb-2">Recomputing the entire tax-lot ledger…</h3>
        <p className="text-sm text-ink-dim">
          Saving the change, then rebuilding every tax lot and closed sale. Keep this window open. This
          can take a while on a large ledger.
        </p>
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-raised" aria-hidden="true">
          <div className="h-full w-1/3 rounded-full bg-gold animate-pulse" />
        </div>
      </div>
    );
  }

  if (phase.kind === "failed") {
    return (
      <div role="alert">
        <h3 className="text-base font-medium mb-2">
          {phase.saved === "unknown" ? "No answer from the server" : "Not saved"}
        </h3>
        <p className="text-sm text-ink-dim">{phase.message}</p>
        {phase.saved === "no" && (
          <p className="text-sm text-ink-dim mt-2">The ledger was not recomputed.</p>
        )}
      </div>
    );
  }

  // done
  const { report } = phase;
  if (!phase.recomputed) {
    return (
      <div role="alert">
        <h3 className="text-base font-medium mb-2">Saved, but the ledger was not recomputed</h3>
        <p className="text-sm text-ink-dim">
          The change is saved. The recompute failed: {phase.recomputeError}.{" "}
          {report == null
            ? "The server sent no counts, so check the Tax Lots page for the state of the ledger."
            : ledgerUnchanged(report)
              ? "The failed run was undone as a whole: the ledger is exactly as it was before, as the counts below show."
              : "The counts below show what the ledger holds now."}{" "}
          Lot and gain figures stay out of date until a recompute succeeds: make the change again, or use
          Recompute on the Tax Lots page.
        </p>
        {report && <ReportTable report={report} />}
      </div>
    );
  }
  return (
    <div role="status">
      <h3 className="text-base font-medium mb-2">Saved. The ledger was recomputed</h3>
      {report ? (
        <>
          <p className="text-sm text-ink-dim">
            {ledgerUnchanged(report)
              ? "Every tax lot and closed sale was rebuilt. Nothing moved: the counts, every closed-sale row and every lot's open quantity and basis match what was there before."
              : "Every tax lot and closed sale was rebuilt. This is what moved:"}
          </p>
          <ReportTable report={report} />
        </>
      ) : (
        <p className="text-sm text-ink-dim">
          Every tax lot and closed sale was rebuilt, but the server sent no before-and-after counts. Check
          the Tax Lots page for what moved.
        </p>
      )}
    </div>
  );
}

function ReportTable({ report }: { report: LedgerRecomputeReport }) {
  const rows: [string, number, number][] = [
    ["Closed sales (Estimated closes included)", report.before.closedSales, report.after.closedSales],
    ["Open lots", report.before.openLots, report.after.openLots],
    ["Estimated closes", report.before.engineCloses, report.after.engineCloses],
  ];
  return (
    <>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-xs text-ink-faint">
            <th className="text-left font-medium py-1">Ledger</th>
            <th className="text-right font-medium py-1">Before</th>
            <th className="text-right font-medium py-1">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, before, after]) => (
            <tr key={label} className="border-t border-edge">
              <td className="py-1 text-ink-dim">{label}</td>
              <td className="py-1 text-right font-mono tabular-nums text-ink-dim">
                <Count value={before} />
              </td>
              <td className="py-1 text-right font-mono tabular-nums text-ink">
                <Count value={after} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-dim">Open lots changed (open quantity or basis)</dt>
        <dd className="text-right font-mono tabular-nums text-ink">
          <Count value={report.openLotsChanged} />
        </dd>
        <dt className="text-ink-dim">Closed-sale rows added or changed</dt>
        <dd className="text-right font-mono tabular-nums text-ink">
          <Count value={report.saleRowsAddedOrChanged} />
        </dd>
        <dt className="text-ink-dim">Closed-sale rows removed or changed</dt>
        <dd className="text-right font-mono tabular-nums text-ink">
          <Count value={report.saleRowsRemovedOrChanged} />
        </dd>
      </dl>
    </>
  );
}

export function LedgerRecomputeDialog({ flow }: { flow: LedgerRecomputeFlow }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { phase, proceed, close } = flow;
  const open = phase.kind !== "idle";
  const busy = isLedgerFlowBusy(phase);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Escape never dismisses the native dialog on its own: while a request is
    // out it does nothing, otherwise it is the same as the Cancel/Close button.
    const handleCancel = (e: Event) => {
      e.preventDefault();
      close();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [close]);

  return (
    <dialog
      ref={dialogRef}
      aria-busy={busy}
      // m-auto restores the dialog centering that Tailwind v4's preflight zeroes.
      className="m-auto rounded-xl border border-edge bg-panel p-0 text-ink backdrop:bg-canvas/70 backdrop:backdrop-blur-sm max-w-md w-full"
    >
      <div className="p-6">
        <LedgerRecomputeBody phase={phase} />
      </div>
      <div className="flex justify-end gap-3 px-6 pb-6">
        {phase.kind === "confirm" && (
          <>
            <button
              type="button"
              onClick={close}
              className="px-4 py-2 rounded-lg border border-edge text-sm text-ink-dim hover:text-ink hover:bg-raised transition-colors focus-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={proceed}
              className="px-4 py-2 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 transition-[filter,scale] active:scale-[0.96] focus-ring"
            >
              Save and recompute
            </button>
          </>
        )}
        {busy && (
          // No button while a request is out: there is nothing to cancel and a
          // second click must do nothing.
          <span className="py-2 text-sm text-ink-dim">
            {phase.kind === "checking" ? "Checking…" : "Recomputing. Please wait…"}
          </span>
        )}
        {(phase.kind === "done" || phase.kind === "failed") && (
          <button
            type="button"
            onClick={close}
            className="px-4 py-2 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 transition-[filter,scale] active:scale-[0.96] focus-ring"
          >
            Close
          </button>
        )}
      </div>
    </dialog>
  );
}

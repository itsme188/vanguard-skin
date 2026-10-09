"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "../components/Toast";
import { useConfirmPrompt } from "../components/useConfirmPrompt";
import apiFetch, { type ApiFetch } from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";

/**
 * What the confirm says for a row that "Fix date" minted (owner ruling
 * 2026-09-02, option 2). That correction hid the vendor's original date, so
 * removing the corrected row alone drops the company's earnings coverage for
 * good. The dialog says so and offers to un-hide the vendor date as well.
 */
export function fixDatedDeleteCopy(
  symbol: string | null,
  vendorDate: string,
): { title: string; message: string; restoreLabel: string; removeOnlyLabel: string } {
  const name = symbol ?? "this company";
  return {
    title: `Remove the corrected earnings date${symbol ? ` for ${symbol}` : ""}?`,
    message:
      `This row is the date you corrected ${name} to. The vendor's original date (${vendorDate}) ` +
      `was hidden when you fixed it. Removing only this row leaves ${name} with no earnings date, ` +
      `and no calendar refresh will bring one back.`,
    restoreLabel: "Remove and restore vendor date",
    removeOnlyLabel: "Remove only",
  };
}

/**
 * What the two-answer question says for every other row. A hand-entered row
 * is simply deleted; a vendor row is deleted AND suppressed, so the next
 * calendar sync cannot bring the same date back.
 */
export function plainDeleteCopy(
  symbol: string | null,
  source: string,
): { title: string; message: string; confirmLabel: string } {
  const label = symbol ? ` for ${symbol}` : "";
  if (source === "manual") {
    return {
      title: `Remove this manually-added earnings event${label}?`,
      message: "Only this hand-entered row is removed.",
      confirmLabel: "Remove",
    };
  }
  return {
    title: `Remove this ${source}-sourced earnings event${label}?`,
    message:
      'It will stay removed across calendar syncs. If the date was wrong, add the correct one with "+ Add ticker".',
    confirmLabel: "Remove",
  };
}

export type DeleteEarningsOutcome =
  | { kind: "removed"; suppressionsLifted: number | null }
  | { kind: "failed"; message: string }
  | { kind: "unreachable" };

/**
 * DELETE one earnings event and classify the reply. Extracted from the
 * component so the network contract is testable in Node (no DOM harness):
 * `restoreVendorDate` is sent only when asked for, and a 2xx without
 * `success: true` is a failure.
 */
export async function deleteEarningsEvent(
  input: { eventId: number; restoreVendorDate?: boolean },
  fetchImpl: ApiFetch = apiFetch,
): Promise<DeleteEarningsOutcome> {
  try {
    const res = await fetchImpl("/api/calendar/events", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: input.eventId,
        ...(input.restoreVendorDate ? { restoreVendorDate: true } : {}),
      }),
    });
    const result = await readMutationResult<{ suppressionsLifted?: number }>(res);
    if (!result.ok) return { kind: "failed", message: result.message };
    return {
      kind: "removed",
      suppressionsLifted:
        typeof result.data.suppressionsLifted === "number" ? result.data.suppressionsLifted : null,
    };
  } catch {
    return { kind: "unreachable" };
  }
}

/**
 * Remove control for earnings events. Manual rows delete directly; sync-owned
 * rows (finnhub/nasdaq/wsh) delete via suppression — the API records the
 * (symbol, date, type) tuple so the next calendar sync can't re-insert the
 * same wrong date (migration 070; the NET Jul-30-vs-Aug-6 correction path).
 * The confirm copy tells the user which flavor they're getting.
 *
 * Confirm-before-delete in the app's own dialog (useConfirmPrompt), never the
 * browser's; a declined question sends no request. A row that "Fix date"
 * minted (`vendorDate` set) has three answers, not two, so it asks in its own
 * dialog (see fixDatedDeleteCopy).
 * Honest feedback per the project convention: checks res.ok AND the
 * response body, explains failures via toast, refreshes the list on success
 * so the row visibly disappears.
 */
export function EarningsDeleteButton({
  eventId,
  symbol,
  source = "manual",
  vendorDate = null,
}: {
  eventId: number;
  symbol: string | null;
  source?: string;
  /** The vendor date this manual row was corrected FROM (fixDateOrigin), else null. */
  vendorDate?: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const prompt = useConfirmPrompt();
  const [deleting, setDeleting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const label = symbol ? ` for ${symbol}` : "";
  const isManual = source === "manual";
  const fixDated = isManual && vendorDate != null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (asking && !dialog.open) dialog.showModal();
    else if (!asking && dialog.open) dialog.close();
  }, [asking]);

  async function remove(restoreVendorDate: boolean) {
    if (deleting) return;
    setDeleting(true);
    try {
      const outcome = await deleteEarningsEvent({ eventId, restoreVendorDate });
      if (outcome.kind !== "removed") {
        toast(
          outcome.kind === "unreachable"
            ? `${networkFailureMessage(`remove the event${label}`)} The row is unchanged.`
            : `Couldn't remove the event${label}: ${outcome.message} The row is unchanged.`,
          "error",
        );
        return;
      }
      setAsking(false);
      if (fixDated) {
        toast(
          restoreVendorDate
            ? outcome.suppressionsLifted
              ? `Removed the corrected earnings date${label}. The vendor's ${vendorDate} date is no longer hidden; it returns on the next Refresh from Finnhub if the vendor still carries it.`
              : `Removed the corrected earnings date${label}. No hidden vendor date was left to restore.`
            : `Removed the corrected earnings date${label}. The vendor's ${vendorDate} date stays hidden.`,
          "success",
        );
      } else {
        toast(
          isManual
            ? `Removed manual earnings event${label}.`
            : `Removed ${source} earnings event${label} — it won't come back on the next sync.`,
          "success",
        );
      }
      // router.refresh() re-renders the server-rendered Hub; the cockpit is
      // a client poller and needs its own signal to drop the row now.
      window.dispatchEvent(new Event("earnings-data-changed"));
      startTransition(() => router.refresh());
    } finally {
      setDeleting(false);
    }
  }

  async function handleClick() {
    if (deleting) return;
    if (fixDated) {
      setAsking(true);
      return;
    }
    if (!(await prompt.ask({ ...plainDeleteCopy(symbol, source), variant: "danger" }))) return;
    void remove(false);
  }

  const copy = fixDated ? fixDatedDeleteCopy(symbol, vendorDate) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={deleting}
        className="relative text-[10px] font-mono px-1.5 py-0.5 rounded text-down bg-down/15 hover:bg-down/25 disabled:opacity-50 cursor-pointer pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
        title={
          isManual
            ? `Remove this manually-added earnings event${label}`
            : `Remove this ${source} earnings event${label} (stays removed across syncs)`
        }
        aria-label={`Remove earnings event${label}`}
      >
        {deleting ? "…" : "✕"}
      </button>
      {prompt.dialog}
      {copy && (
        <dialog
          ref={dialogRef}
          // m-auto restores the dialog centering Tailwind v4's preflight zeroes.
          className="m-auto rounded-xl border border-edge bg-panel p-0 text-ink text-left backdrop:bg-canvas/70 backdrop:backdrop-blur-sm max-w-sm w-full"
          onCancel={(e) => {
            e.preventDefault();
            if (!deleting) setAsking(false);
          }}
        >
          <div className="p-6">
            <h3 className="text-base font-medium mb-2">{copy.title}</h3>
            <p className="text-sm text-ink-dim">{copy.message}</p>
          </div>
          <div className="flex flex-col gap-2 px-6 pb-6">
            <button
              type="button"
              onClick={() => void remove(true)}
              disabled={deleting}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-gold text-canvas hover:brightness-110 focus-ring disabled:opacity-50"
            >
              {copy.restoreLabel}
            </button>
            <button
              type="button"
              onClick={() => void remove(false)}
              disabled={deleting}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-down/90 text-white hover:bg-down focus-ring disabled:opacity-50"
            >
              {copy.removeOnlyLabel}
            </button>
            <button
              type="button"
              onClick={() => setAsking(false)}
              disabled={deleting}
              className="px-4 py-2 rounded-lg border border-edge text-sm text-ink-dim hover:text-ink hover:bg-raised focus-ring disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}

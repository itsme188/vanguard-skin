"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "../components/Toast";

/**
 * Remove control for earnings events. Manual rows delete directly; sync-owned
 * rows (finnhub/nasdaq/wsh) delete via suppression — the API records the
 * (symbol, date, type) tuple so the next calendar sync can't re-insert the
 * same wrong date (migration 070; the NET Jul-30-vs-Aug-6 correction path).
 * The confirm copy tells the user which flavor they're getting.
 *
 * Confirm-before-delete via window.confirm — matches the codebase idiom for
 * destructive row actions (LevelsPanel delete, BogeysEditModal, ImportHistory
 * undo). Honest feedback per the project convention: checks res.ok AND the
 * response body, explains failures via toast, refreshes the list on success
 * so the row visibly disappears.
 */
export function EarningsDeleteButton({
  eventId,
  symbol,
  source = "manual",
}: {
  eventId: number;
  symbol: string | null;
  source?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);
  const [, startTransition] = useTransition();
  const label = symbol ? ` for ${symbol}` : "";
  const isManual = source === "manual";
  const confirmMessage = isManual
    ? `Remove this manually-added earnings event${label}?`
    : `Remove this ${source}-sourced earnings event${label}? It will STAY removed across calendar syncs — if the date was wrong, add the correct one with "+ Add ticker".`;

  async function handleDelete() {
    if (deleting) return;
    if (!confirm(confirmMessage)) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/calendar/events", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: eventId }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || !json.success) {
        toast(
          `Couldn't remove the event${label}: ${json.error ?? `server returned ${res.status}`} — the row is unchanged.`,
          "error",
        );
        return;
      }
      toast(
        isManual
          ? `Removed manual earnings event${label}.`
          : `Removed ${source} earnings event${label} — it won't come back on the next sync.`,
        "success",
      );
      // router.refresh() re-renders the server-rendered Hub; the cockpit is
      // a client poller and needs its own signal to drop the row now.
      window.dispatchEvent(new Event("earnings-data-changed"));
      startTransition(() => router.refresh());
    } catch {
      toast(
        `Couldn't remove the event${label}: could not reach the server — the row is unchanged.`,
        "error",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
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
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "../components/Toast";

/**
 * Remove control for manually-added earnings events (source='manual' only —
 * the EarningsHub renders this conditionally, and the API's source guard is
 * the real authority: DELETE /api/calendar/events 403s for sync-owned rows).
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
}: {
  eventId: number;
  symbol: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);
  const [, startTransition] = useTransition();
  const label = symbol ? ` for ${symbol}` : "";

  async function handleDelete() {
    if (deleting) return;
    if (!confirm(`Remove this manually-added earnings event${label}?`)) return;
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
      toast(`Removed manual earnings event${label}.`, "success");
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
      title={`Remove this manually-added earnings event${label}`}
      aria-label={`Remove manually-added earnings event${label}`}
    >
      {deleting ? "…" : "✕"}
    </button>
  );
}

"use client";

/**
 * Small "Sync Vanguard (Plaid)" button for the Accounts tab — RecomputeButton
 * pattern (useToast honest feedback). The route itself explains not-connected
 * / already-synced-today / market-closed no-ops via `data.error` or
 * `skippedReason`, so this always renders rather than hiding based on
 * connection state the client doesn't know yet.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./Toast";
import apiFetch from "@/lib/http/apiFetch";

interface PlaidSyncResponse {
  success: boolean;
  holdingsWritten?: number;
  skippedReason?: "market_closed" | "already_synced_today" | null;
  error?: string;
}

export function PlaidSyncButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);

  async function handleClick() {
    setIsLoading(true);
    try {
      const res = await apiFetch("/api/plaid/sync", { method: "POST" });
      const data = (await res.json()) as PlaidSyncResponse;
      if (data.success) {
        if (data.skippedReason === "market_closed") {
          toast("Vanguard sync skipped — the market is closed.", "info");
        } else if (data.skippedReason === "already_synced_today") {
          toast("Vanguard already synced today — nothing new to pull.", "info");
        } else {
          toast(`Vanguard synced — ${data.holdingsWritten ?? 0} holdings updated`, "success");
          router.refresh();
        }
      } else {
        toast(`Vanguard sync failed: ${data.error}`, "error");
      }
    } catch {
      toast("Failed to connect to server", "error");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={isLoading}
      title={isLoading ? "Syncing…" : undefined}
      className="px-4 py-2 rounded-lg bg-raised border border-edge text-sm font-medium text-ink-dim hover:text-ink hover:border-edge-strong transition-[color,border-color,scale] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed focus-ring"
    >
      {isLoading ? "Syncing…" : "Sync Vanguard (Plaid)"}
    </button>
  );
}

"use client";

/**
 * Small "Sync Vanguard (Plaid)" button for the Accounts tab — RecomputeButton
 * pattern (useToast honest feedback). Every sentence it shows comes from
 * `lib/ui/plaid-sync-message.ts` (plan v4, section A "The button"): a
 * skipped read says "Nothing stored" and why, a read that stored no account
 * is information, never success, and the page refreshes only when at least
 * one account was stored. It always renders rather than hiding based on
 * connection state the client doesn't know yet; the route names a missing
 * connection in `error`.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./Toast";
import apiFetch from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
import {
  PLAID_SYNC_ACTION,
  plaidSyncFailureText,
  plaidSyncMessage,
  type PlaidSyncAnswer,
} from "@/lib/ui/plaid-sync-message";

interface PlaidSyncResponse {
  success: boolean;
  data?: PlaidSyncAnswer | null;
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
      const result = await readMutationResult<PlaidSyncResponse>(res);
      if (!result.ok) {
        toast(plaidSyncFailureText(result.message), "error");
        return;
      }
      const message = plaidSyncMessage(result.data.data);
      toast(message.text, message.tone);
      if (message.refresh) router.refresh();
    } catch {
      toast(networkFailureMessage(PLAID_SYNC_ACTION), "error");
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

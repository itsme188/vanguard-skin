"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import apiFetch from "@/lib/http/apiFetch";

interface Props {
  ticker: string;
}

/**
 * Client island that POSTs /api/transcripts {ticker} to trigger the
 * fallback fetch chain (API Ninjas → Motley Fool → EDGAR with
 * quarter-match guard) and then refreshes the page on success.
 *
 * No quarter is passed — the fetcher defaults to the most recent
 * quarter via getMostRecentQuarter, which is what the user wants when
 * they click "refresh" on a security they don't follow per-quarter.
 */
export function TranscriptsRefreshButton({ ticker }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.success) {
        setError(body?.error ?? `HTTP ${res.status}`);
        setBusy(false);
        return;
      }
      router.refresh();
      // Brief grace period so the disabled state is visible after refresh
      // commits — otherwise the button flashes idle while the new HTML
      // streams in.
      setTimeout(() => setBusy(false), 300);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-[11px]">
      {error && (
        <span className="text-down" style={{ maxWidth: "360px" }}>
          ⚠ {error}
        </span>
      )}
      <button
        type="button"
        onClick={refresh}
        disabled={busy}
        className="text-ink-dim hover:text-gold disabled:opacity-50 font-mono"
      >
        {busy ? "…fetching" : "↻ refresh"}
      </button>
    </div>
  );
}

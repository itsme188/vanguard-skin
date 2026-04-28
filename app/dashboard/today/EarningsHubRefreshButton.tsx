"use client";

/**
 * Refresh-from-Finnhub button for the Earnings Hub. Calls the existing
 * /api/calendar/sync SSE endpoint for the current week, drains the
 * stream, then refreshes the server component so new rows appear.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  weekOf: string;
}

export function EarningsHubRefreshButton({ weekOf }: Props) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setSyncing(true);
    setError(null);
    setProgress("syncing…");
    try {
      const res = await fetch("/api/calendar/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekOf }),
      });
      if (!res.ok || !res.body) {
        setError(`HTTP ${res.status}`);
        setSyncing(false);
        return;
      }
      // SSE: drain and surface the latest progress message until done.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6)) as { type?: string; message?: string };
              if (evt.message) setProgress(evt.message);
            } catch {
              // ignore non-JSON lines
            }
          }
        }
      }
      setProgress(null);
      setSyncing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSyncing(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-[12px]">
      {progress && <span className="text-[11px] text-ink-faint italic">{progress}</span>}
      {error && <span className="text-[11px] text-down">{error}</span>}
      <button
        type="button"
        onClick={refresh}
        disabled={syncing}
        className="text-ink-dim hover:text-gold disabled:opacity-50"
      >
        {syncing ? "Syncing…" : "↻ Refresh from Finnhub"}
      </button>
    </div>
  );
}

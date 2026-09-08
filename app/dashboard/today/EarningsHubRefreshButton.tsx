"use client";

/**
 * Refresh-from-Finnhub button for the Earnings Hub. Calls the existing
 * /api/calendar/sync SSE endpoint for the current week, drains the
 * stream, then refreshes the server component so new rows appear.
 *
 * Honest-button convention (CLAUDE.md): a mutating control reports what it
 * did or why it failed, in domain language — never silence. The route
 * (app/api/calendar/sync/route.ts) streams `{ progress: { phase, message } }`
 * frames while it works, then exactly one of `{ complete: true, data }` or
 * `{ error }` before the `[DONE]` sentinel. There is no top-level `message`
 * field on any frame — an earlier version of this button read one and so
 * never updated past the initial "syncing…" placeholder.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import apiFetch from "@/lib/http/apiFetch";

interface Props {
  weekOf: string;
}

interface SyncCompleteData {
  newEvents: number;
  refreshedEvents: number;
  errors?: string[];
}

export interface SyncOutcome {
  text: string;
  title?: string;
}

/**
 * Turns the sync route's `complete` payload into the line the button shows
 * and keeps visible once the run ends. Pure so it's unit-testable without a
 * DOM (this repo has no jsdom/RTL — see reference_no_dom_test_harness_source_pin).
 */
export function buildSyncOutcome(data: SyncCompleteData): SyncOutcome {
  const newEvents = data.newEvents ?? 0;
  const refreshedEvents = data.refreshedEvents ?? 0;
  const errors = data.errors ?? [];

  const parts: string[] = [];
  if (newEvents > 0) parts.push(`${newEvents} new`);
  if (refreshedEvents > 0) parts.push(`${refreshedEvents} updated`);
  let text = parts.length > 0 ? `Refreshed — ${parts.join(", ")}` : "Refreshed — no changes";

  if (errors.length > 0) {
    text += ` · ${errors.length} step${errors.length === 1 ? "" : "s"} had problems`;
    return { text, title: errors.join("; ") };
  }
  return { text };
}

interface SyncFrame {
  progress?: { phase?: string; message?: string };
  complete?: boolean;
  data?: SyncCompleteData;
  error?: string;
}

export function EarningsHubRefreshButton({ weekOf }: Props) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setSyncing(true);
    setError(null);
    setOutcome(null);
    setProgress("syncing…");
    let gotResult = false;
    try {
      const res = await apiFetch("/api/calendar/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekOf }),
      });
      if (!res.ok || !res.body) {
        setProgress(null);
        setError(`HTTP ${res.status}`);
        setSyncing(false);
        return;
      }
      // SSE: drain frames — progress.message updates the live line;
      // complete/error become the outcome the button keeps showing once the
      // stream ends.
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
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload) as SyncFrame;
            if (evt.progress?.message) {
              setProgress(evt.progress.message);
            } else if (evt.complete && evt.data) {
              gotResult = true;
              setProgress(null);
              setOutcome(buildSyncOutcome(evt.data));
            } else if (typeof evt.error === "string") {
              gotResult = true;
              setProgress(null);
              setError(`Refresh failed: ${evt.error}`);
            }
          } catch {
            // ignore non-JSON lines
          }
        }
      }
      if (!gotResult) {
        setProgress(null);
        setError("Refresh ended without a result — reload to check.");
      }
      setSyncing(false);
      router.refresh();
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : "Network error");
      setSyncing(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-[14px]">
      {progress && <span className="text-[11px] text-ink-faint italic">{progress}</span>}
      {!progress && outcome && (
        <span className="text-[11px] text-ink-faint" title={outcome.title}>
          {outcome.text}
        </span>
      )}
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

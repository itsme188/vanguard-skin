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
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";

interface Props {
  weekOf: string;
}

interface SyncCompleteData {
  newEvents: number;
  refreshedEvents: number;
  errors?: string[];
  /** Domain-language entries for legs that never ran (e.g. no TWS, no Finnhub
   * key) — distinct from `errors`, which is failures during an attempt. */
  skipped?: string[];
  /** Rows the refresh DELETED that were showing before it, each with a reason. */
  removed?: SyncRowChange[];
  /** Earnings rows the refresh HID (superseded) that were showing before it. */
  superseded?: SyncRowChange[];
}

/** One row a refresh took off the calendar — mirrors `CalendarRowChange` in
 * lib/calendar/sync.ts. Title and date are public calendar data. */
interface SyncRowChange {
  title: string;
  eventDate: string;
  reason: string;
}

export interface SyncOutcome {
  text: string;
  title?: string;
  /** Every removed / hidden row, one line each — set only when the visible
   * line could not name them all (more than one of a kind). */
  changes?: string[];
}

/** Keeps only well-formed entries, so a stale or odd server frame can never
 * throw inside the outcome composer or print "undefined". */
function rowChanges(value: unknown): SyncRowChange[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is SyncRowChange =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as SyncRowChange).title === "string" &&
      typeof (r as SyncRowChange).eventDate === "string" &&
      typeof (r as SyncRowChange).reason === "string",
  );
}

function describeRowChange(verb: "Removed" | "Hidden", row: SyncRowChange): string {
  return `${verb} ${row.title} (${row.eventDate}) — ${row.reason}`;
}

/** Longest error summary we will put on the always-visible outcome line. */
const INLINE_ERROR_MAX = 120;

/**
 * Makes one `errors` entry safe to show inline. The entries are composed by
 * lib/calendar/sync.ts in domain language, but a phase that blows up outright
 * pushes the upstream message verbatim — which can be a JSON body. Cut at the
 * first JSON delimiter, collapse whitespace, and cap the length; the untouched
 * original stays in `title` (rendered as the expandable detail).
 */
function summarizeError(message: string): string {
  const jsonAt = message.search(/[{[]/);
  const head = (jsonAt >= 0 ? message.slice(0, jsonAt) : message)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[:\-–—,;]+$/, "")
    .trim();
  const cleaned = head || "unknown error";
  return cleaned.length > INLINE_ERROR_MAX
    ? `${cleaned.slice(0, INLINE_ERROR_MAX - 1).trimEnd()}…`
    : cleaned;
}

/**
 * Turns the sync route's `complete` payload into the line the button shows
 * and keeps visible once the run ends. Pure so it's unit-testable without a
 * DOM (this repo has no jsdom/RTL — see reference_no_dom_test_harness_source_pin).
 *
 * A degraded run has to be distinguishable AT A GLANCE. The line used to say
 * "· 2 steps had problems" and hide what they were in an expandable detail,
 * so a sync that silently skipped N of M symbols (Finnhub 429 storm) read
 * as a clean "Refreshed — k new". The first problem now shows inline; the
 * rest are counted, and the full list stays in `title`.
 *
 * When a "not scanned" entry is present it is shown inline even if it isn't
 * `errors[0]` — `errors` is pushed in phase order (wsh, macro, then the
 * finnhub partial-scan summary last), so a WSH or macro failure would
 * otherwise bump the symbol-count warning behind "(+1 more)", hiding the
 * exact failure this function exists to surface.
 *
 * A leg that never ran at all (no TWS, no Finnhub key) is a SKIP, not a
 * failure — lib/calendar/sync.ts reports it in `data.skipped`, never
 * `errors`. Each skipped entry is appended inline after the count, same as
 * an error, but never counted into the errors "(+N more)" tally — a skip
 * isn't one of the N failed attempts.
 *
 * A row the refresh took off the calendar is NAMED, with the reason (owner
 * rulings 2026-10-06): "Removed" for a row the cleanup deleted, "Hidden" for
 * an earnings row another date superseded (still stored, no longer shown).
 * Each kind is counted beside new/updated, its first row is spelled out on
 * the line, and when there are more the full list goes in `changes` (the
 * tap-to-expand detail). A run whose only effect was a removal never reads
 * "no changes".
 */
export function buildSyncOutcome(data: SyncCompleteData): SyncOutcome {
  const newEvents = data.newEvents ?? 0;
  const refreshedEvents = data.refreshedEvents ?? 0;
  const errors = data.errors ?? [];
  const skipped = data.skipped ?? [];

  const removed = rowChanges(data.removed);
  const hidden = rowChanges(data.superseded);

  const parts: string[] = [];
  if (newEvents > 0) parts.push(`${newEvents} new`);
  if (refreshedEvents > 0) parts.push(`${refreshedEvents} updated`);
  if (removed.length > 0) parts.push(`${removed.length} removed`);
  if (hidden.length > 0) parts.push(`${hidden.length} hidden`);
  let text = parts.length > 0 ? `Refreshed — ${parts.join(", ")}` : "Refreshed — no changes";

  const removedLines = removed.map((r) => describeRowChange("Removed", r));
  const hiddenLines = hidden.map((r) => describeRowChange("Hidden", r));
  for (const lines of [removedLines, hiddenLines]) {
    if (lines.length === 0) continue;
    text += ` · ${lines[0]}${lines.length > 1 ? ` (+${lines.length - 1} more)` : ""}`;
  }
  const changes =
    removedLines.length > 1 || hiddenLines.length > 1
      ? [...removedLines, ...hiddenLines]
      : undefined;

  for (const entry of skipped) {
    text += ` · ${entry}`;
  }

  if (errors.length > 0) {
    // Prefer a "not scanned" entry when one is present — it's the most
    // actionable failure (an exact count of what to re-run) and must not
    // hide behind "(+N more)" just because it wasn't the first phase to fail.
    const notScannedIndex = errors.findIndex((e) => /not scanned/i.test(e));
    const inlineIndex = notScannedIndex >= 0 ? notScannedIndex : 0;
    const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
    text += ` · ${summarizeError(errors[inlineIndex])}${more}`;
    return { text, title: errors.join("; "), ...(changes ? { changes } : {}) };
  }
  return changes ? { text, changes } : { text };
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
      if (!res.ok) {
        // A refused request never opens the stream — it answers with the
        // JSON error envelope (sign-in expired, blocked origin, server
        // error). Read it through the shared reader so the line says what
        // went wrong instead of a bare status code.
        const failure = await readMutationResult(res);
        setProgress(null);
        setError(
          failure.ok
            ? "Refresh failed: the server refused the request."
            : `Refresh failed: ${failure.message}`,
        );
        setSyncing(false);
        return;
      }
      if (!res.body) {
        setProgress(null);
        setError("Refresh failed: the server sent no result — reload to check.");
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
    } catch {
      // Never a raw exception ("Failed to fetch"): the request, or the stream
      // mid-run, lost the server. The run may have partly applied — the next
      // refresh is idempotent.
      setProgress(null);
      setError(networkFailureMessage("refresh the calendar"));
      setSyncing(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-[14px]">
      {progress && <span className="text-[11px] text-ink-faint italic">{progress}</span>}
      {!progress && outcome && (
        outcome.title || outcome.changes ? (
          // The joined per-phase errors used to live ONLY in the `title`
          // attribute — a hover-only affordance a touch user can never
          // trigger (CLAUDE.md: hover-only = touch tap-trap). A <details>
          // keeps the one-line outcome always visible as the summary and
          // makes the detail a tap target, not just a hover target.
          <details className="text-[11px] text-ink-faint">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              {outcome.text} <span aria-hidden="true">▾</span>
            </summary>
            {outcome.changes && (
              // Every row the refresh removed or hid, one per line — public
              // calendar titles and dates, so no privacy wrapper.
              <ul className="mt-1 space-y-0.5">
                {outcome.changes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {outcome.title && (
              <div className="mt-1 text-down whitespace-pre-wrap">{outcome.title}</div>
            )}
          </details>
        ) : (
          <span className="text-[11px] text-ink-faint">{outcome.text}</span>
        )
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

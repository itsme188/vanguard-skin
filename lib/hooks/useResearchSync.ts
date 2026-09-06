"use client";

import { useEffect, useRef, useCallback } from "react";
import apiFetch from "@/lib/http/apiFetch";
import { researchSyncCompleted } from "@/lib/research/sync-completion";

const SYNC_DEBOUNCE_KEY = "vgs:lastResearchSync";
const FOCUS_IDLE_MS = 10 * 60 * 1000; // 10 min away counts as "back from idle"
const MIN_INTERVAL_MS = 5 * 60 * 1000; // No more than once per 5 min total

/**
 * Auto-trigger a research-feed sync when the user actively engages with the
 * Research surface — on tab mount, and when they refocus the app after
 * being away. Debounced across the whole session so rapid tab switches
 * don't fire repeated syncs. Calls the existing user-facing `/api/research/sync`
 * endpoint (NOT the cron-only endpoint).
 *
 * The lastSync timestamp is stored in localStorage so it survives across
 * mounts within the same session — opening the Research tab, switching
 * to Today, then back, won't re-trigger a sync.
 */
export function useResearchSync(options: {
  /** When this changes, we may trigger a sync. Default: fire on mount. */
  enabled?: boolean;
  /** Called right before the fetch fires — useful to flip a syncing pill. */
  onSyncStart?: () => void;
  /** Called when the fetch completes (success or failure). */
  onSyncDone?: () => void;
} = {}) {
  const { enabled = true, onSyncStart, onSyncDone } = options;
  const syncingRef = useRef(false);
  const lastFocusAtRef = useRef<number>(Date.now());

  // Callers pass inline arrows for onSyncStart/onSyncDone. Depending on them
  // directly would recreate triggerSync every render, re-firing the mount
  // effect below in a loop: the callbacks' setState → render → new triggerSync
  // → effect → setState… (a request storm on any install where the Gmail
  // pre-flight short-circuits before the localStorage debounce is stamped).
  // Same trap as the useCallback render-loop rule in CLAUDE.md.
  const onSyncStartRef = useRef(onSyncStart);
  const onSyncDoneRef = useRef(onSyncDone);
  useEffect(() => {
    onSyncStartRef.current = onSyncStart;
    onSyncDoneRef.current = onSyncDone;
  });

  const triggerSync = useCallback(async () => {
    if (syncingRef.current) return;

    // Read the last-sync timestamp lazily — survives across remounts.
    const lastStr = (() => {
      try {
        return localStorage.getItem(SYNC_DEBOUNCE_KEY);
      } catch {
        return null;
      }
    })();
    const last = lastStr ? Number(lastStr) : 0;
    if (Number.isFinite(last) && Date.now() - last < MIN_INTERVAL_MS) return;

    syncingRef.current = true;
    onSyncStartRef.current?.();
    try {
      // Pre-flight: skip quietly when Gmail OAuth isn't configured — firing
      // the sync would 400 and log a console error on every mount. The
      // config-only check reads env vars, no Google round-trip. If the
      // pre-flight itself fails, fall through and attempt the sync anyway.
      try {
        const status = await fetch("/api/gmail/status?check=config");
        if (status.ok) {
          const { connected } = (await status.json()) as { connected?: boolean };
          if (connected === false) return;
        }
      } catch {
        // Pre-flight unreachable — let the sync attempt decide.
      }
      // The endpoint is SSE. Only its terminal completion event earns the
      // cooldown; a 409 or a failed/truncated stream must remain retryable.
      // The manual sync UI handles verbose progress separately.
      // Label this pass as the BACKGROUND runner. The manual "Sync Feeds"
      // button POSTs the same route without this header, and the route uses
      // it to acquire the sync lock under the right owner — so a collision
      // during this automatic pass says "a background refresh is running"
      // instead of blaming the user for "a sync you already started".
      // apiFetch builds a Headers from `init.headers` and only ADDS the CSRF
      // token to it, so passing headers here can't drop that header.
      const res = await apiFetch("/api/research/sync", {
        method: "POST",
        headers: { "X-Sync-Runner": "background" },
      });
      if (!(await researchSyncCompleted(res))) return;
      try {
        localStorage.setItem(SYNC_DEBOUNCE_KEY, String(Date.now()));
      } catch {
        // localStorage may be disabled — proceed anyway.
      }
    } catch {
      // Network error — silent. Manual sync button is always available.
    } finally {
      syncingRef.current = false;
      onSyncDoneRef.current?.();
    }
  }, []);

  // Fire once when the component mounts and `enabled` flips to true.
  useEffect(() => {
    if (!enabled) return;
    void triggerSync();
  }, [enabled, triggerSync]);

  // Fire when the page comes back into focus after a meaningful idle
  // period (10+ min away). Short blur/focus cycles (e.g. switching to
  // Slack briefly) don't trigger.
  useEffect(() => {
    if (!enabled) return;
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") {
        lastFocusAtRef.current = Date.now();
        return;
      }
      const idleMs = Date.now() - lastFocusAtRef.current;
      lastFocusAtRef.current = Date.now();
      if (idleMs >= FOCUS_IDLE_MS) void triggerSync();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [enabled, triggerSync]);
}

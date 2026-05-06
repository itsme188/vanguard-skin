"use client";

import { useEffect, useRef, useCallback } from "react";

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
    onSyncStart?.();
    try {
      // The endpoint is SSE — but for our purposes we just need it to fire
      // and complete. We `read` the stream to drain it; we don't surface
      // the events. The user's manual sync UI in ResearchFeedsView handles
      // the verbose progress UI separately.
      const res = await fetch("/api/research/sync", { method: "POST" });
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        // Drain the stream — we don't care about the contents here.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      try {
        localStorage.setItem(SYNC_DEBOUNCE_KEY, String(Date.now()));
      } catch {
        // localStorage may be disabled — proceed anyway.
      }
    } catch {
      // Network error — silent. Manual sync button is always available.
    } finally {
      syncingRef.current = false;
      onSyncDone?.();
    }
  }, [onSyncStart, onSyncDone]);

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

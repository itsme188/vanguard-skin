"use client";

import { useEffect, useRef, useCallback } from "react";
import apiFetch from "@/lib/http/apiFetch";
import type { SyncState } from "@/lib/tws/sync-state";
import { shouldFireDisconnectedRefresh } from "@/lib/tws/webapi-refresh-gate";

/** localStorage key for the disconnected-path (IBKR Web API) refresh debounce.
 *  The hook's in-memory ref resets on every page mount, so a persistent gate
 *  is needed or every page-open away from home would fire a refresh. (Since
 *  R1b the Web API path DOES report through server sync-state — via
 *  lastSyncVia:'ibkr-webapi' — but this client-side debounce stays as the
 *  cheap first gate that avoids even the POST.) */
const LAST_WEBAPI_REFRESH_KEY = "vgs:lastWebApiRefresh";

/**
 * Client-driven periodic refresh hook.
 *
 * When TWS is connected and no sync is in progress, triggers a quick refresh
 * (snapshot prices + valuations) at the configured interval.
 *
 * When TWS is NOT connected (away from home), the same cadence fires the
 * route's IBKR Web API fallback instead — but only Mon–Fri 9:30–16:00 ET,
 * holiday-aware, debounced via localStorage (R1 auto-cadence; spec:
 * docs/superpowers/specs/2026-07-03-away-from-home-auto-refresh-design.md).
 *
 * Survives HMR (client-side, no server state). Naturally pauses when no
 * browser tab is open. Respects the sync-state mutex (won't fire if already syncing).
 */
export function useAutoRefresh(options: {
  /** Current TWS connection state. */
  twsConnected: boolean;
  /** Current sync state (from polling /api/tws/sync-status). */
  syncState: SyncState | null;
  /** Refresh interval in minutes. 0 = disabled. Default: 30. */
  intervalMinutes?: number;
  /** Called when a refresh is triggered. */
  onRefresh?: () => void;
}) {
  const { twsConnected, syncState, intervalMinutes = 30, onRefresh } = options;
  const lastTriggerRef = useRef<number>(0);

  const triggerRefresh = useCallback(async () => {
    if (!twsConnected) {
      // Disconnected path: fire the route's IBKR Web API fallback on the
      // same cadence, market-hours-only + holiday-aware + localStorage
      // debounce. Broker-only pricing — no third-party price source.
      if (syncState?.status === "syncing") return;
      let lastRefreshMs = 0;
      try {
        lastRefreshMs = Number(localStorage.getItem(LAST_WEBAPI_REFRESH_KEY)) || 0;
      } catch {
        // localStorage unavailable → fall back to the in-memory ref only.
        lastRefreshMs = lastTriggerRef.current;
      }
      if (
        !shouldFireDisconnectedRefresh({
          now: new Date(),
          lastRefreshMs: Math.max(lastRefreshMs, lastTriggerRef.current),
          intervalMinutes,
        })
      ) {
        return;
      }
      lastTriggerRef.current = Date.now();
      try {
        localStorage.setItem(LAST_WEBAPI_REFRESH_KEY, String(Date.now()));
      } catch {
        // best-effort
      }
      try {
        await apiFetch("/api/tws/auto-refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ level: "quick" }),
        });
        onRefresh?.();
      } catch {
        // Sync-status polling will show errors
      }
      return;
    }
    if (!syncState || syncState.status === "syncing") return;
    if (intervalMinutes <= 0) return;

    // Check if enough time has passed since last sync
    const now = Date.now();
    const lastSyncMs = syncState.lastSyncAt
      ? new Date(syncState.lastSyncAt).getTime()
      : 0;
    const intervalMs = intervalMinutes * 60_000;

    // Also check our own trigger time to prevent double-fires
    const sinceTrigger = now - lastTriggerRef.current;
    if (sinceTrigger < intervalMs && lastTriggerRef.current > 0) return;

    const sinceLastSync = now - lastSyncMs;
    if (sinceLastSync < intervalMs) return;

    lastTriggerRef.current = now;

    try {
      await apiFetch("/api/tws/auto-refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "quick" }),
      });
      onRefresh?.();
    } catch {
      // Sync-status polling will show errors
    }
  }, [twsConnected, syncState, intervalMinutes, onRefresh]);

  useEffect(() => {
    // Timer runs regardless of TWS state — the disconnected path has its
    // own market-hours/holiday/debounce gate inside triggerRefresh.
    if (intervalMinutes <= 0) return;

    // Check every 60 seconds whether we need to refresh
    const interval = setInterval(triggerRefresh, 60_000);
    return () => clearInterval(interval);
  }, [intervalMinutes, triggerRefresh]);
}

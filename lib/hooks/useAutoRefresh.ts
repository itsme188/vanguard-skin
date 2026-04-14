"use client";

import { useEffect, useRef, useCallback } from "react";
import type { SyncState } from "@/lib/tws/sync-state";

/**
 * Client-driven periodic refresh hook.
 *
 * When TWS is connected and no sync is in progress, triggers a quick refresh
 * (snapshot prices + valuations) at the configured interval.
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
    if (!twsConnected) return;
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
      await fetch("/api/tws/auto-refresh", {
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
    if (!twsConnected || intervalMinutes <= 0) return;

    // Check every 60 seconds whether we need to refresh
    const interval = setInterval(triggerRefresh, 60_000);
    return () => clearInterval(interval);
  }, [twsConnected, intervalMinutes, triggerRefresh]);
}

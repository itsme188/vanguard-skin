/**
 * Sync state singleton — tracks auto-refresh pipeline progress.
 *
 * Uses the same globalThis pattern as client.ts to survive
 * Turbopack HMR reloads in dev mode.
 */

export interface PhaseProgress {
  current: number;
  total: number;
  label: string; // e.g. "AAPL" or "Saving prices..."
}

export interface AutoRefreshResult {
  positionsSynced: number;
  securitiesEnriched: number;
  pricesUpdated: number;
  valuationsRecomputed: boolean;
  benchmarksSynced: number;
  errors: string[];
  durationMs: number;
}

export interface SyncState {
  status: "idle" | "syncing" | "error";
  currentPhase:
    | "positions"
    | "enriching"
    | "prices"
    | "valuations"
    | "benchmarks"
    | null;
  phaseProgress: PhaseProgress | null;
  lastSyncAt: string | null; // ISO timestamp
  lastSyncResult: AutoRefreshResult | null;
  error: string | null;
}

// ── globalThis singleton ──────────────────────────────────────

interface SyncGlobal {
  __sync_state: SyncState;
}

const g = globalThis as unknown as Partial<SyncGlobal>;
if (!g.__sync_state) {
  g.__sync_state = {
    status: "idle",
    currentPhase: null,
    phaseProgress: null,
    lastSyncAt: null,
    lastSyncResult: null,
    error: null,
  };
}

// ── Public API ────────────────────────────────────────────────

export function getSyncState(): SyncState {
  return { ...g.__sync_state! };
}

export function setSyncPhase(
  phase: SyncState["currentPhase"],
  progress?: PhaseProgress,
): void {
  g.__sync_state!.status = "syncing";
  g.__sync_state!.currentPhase = phase;
  g.__sync_state!.phaseProgress = progress ?? null;
  g.__sync_state!.error = null;
}

export function setSyncProgress(progress: PhaseProgress): void {
  g.__sync_state!.phaseProgress = progress;
}

export function setSyncComplete(result: AutoRefreshResult): void {
  g.__sync_state!.status = "idle";
  g.__sync_state!.currentPhase = null;
  g.__sync_state!.phaseProgress = null;
  g.__sync_state!.lastSyncAt = new Date().toISOString();
  g.__sync_state!.lastSyncResult = result;
  g.__sync_state!.error = null;
}

export function setSyncError(error: string): void {
  g.__sync_state!.status = "error";
  g.__sync_state!.currentPhase = null;
  g.__sync_state!.phaseProgress = null;
  g.__sync_state!.error = error;
}

/** Returns true if a sync is already in progress (mutex check). */
export function isSyncing(): boolean {
  return g.__sync_state!.status === "syncing";
}

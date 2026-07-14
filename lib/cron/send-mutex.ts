/**
 * In-process mutex for the cron email routes (briefing/digest/evening).
 *
 * The launchd wrapper scripts retry when curl times out — but an abandoned
 * HTTP request does NOT stop the Next.js handler, so each retry stacked a
 * second (and third) full send pipeline on top of the still-running first
 * one. All of them eventually sent (2026-07-12: Sunday briefing ×3, all
 * Mac-generated). The KV marker dance (mac-sent / cloud-sent) only dedups
 * COMPLETED sends; this lock closes the concurrent-in-flight window inside
 * one server process — the same job the earnings sweep's claim-row mutex
 * (migration 063) does cross-process for per-event sends.
 *
 * globalThis-anchored so dev-mode HMR module reloads can't mint a second
 * lock table. A 30-minute stale window lets a crashed run's lock self-expire
 * (mirrors the earnings claim reap) — the longest healthy pipeline (Sunday
 * briefing) runs ~9 minutes.
 */

export type SendJobType = "briefing" | "digest" | "evening";

const STALE_LOCK_MS = 30 * 60 * 1000;

const globalStore = globalThis as unknown as {
  __vgsSendLocks?: Map<SendJobType, number>;
};

function locks(): Map<SendJobType, number> {
  if (!globalStore.__vgsSendLocks) {
    globalStore.__vgsSendLocks = new Map();
  }
  return globalStore.__vgsSendLocks;
}

/**
 * Attempt to claim the send lock for a job type. Returns false when another
 * run of the same type is in flight (acquired < 30 min ago). Callers MUST
 * release in a finally block.
 */
export function tryAcquireSendLock(type: SendJobType, nowMs = Date.now()): boolean {
  const heldSince = locks().get(type);
  if (heldSince !== undefined && nowMs - heldSince < STALE_LOCK_MS) {
    return false;
  }
  locks().set(type, nowMs);
  return true;
}

export function releaseSendLock(type: SendJobType): void {
  locks().delete(type);
}

/** Test-only: clear all locks so cases stay independent. */
export function _resetSendLocksForTest(): void {
  locks().clear();
}

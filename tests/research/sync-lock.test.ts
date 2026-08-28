/**
 * Tests for lib/research/sync-lock.ts — the in-process mutex that stops the
 * manual "Sync Feeds" button, the background auto-refresh, and the 90-min
 * launchd cron from running the research-sync pipeline concurrently.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  acquireResearchSyncLock,
  releaseResearchSyncLock,
  currentResearchSyncRunner,
  alreadyRunningMessage,
  __resetResearchSyncLockForTests,
} from "@/lib/research/sync-lock";

beforeEach(() => {
  __resetResearchSyncLockForTests();
});

describe("research sync lock", () => {
  it("a manual sync is refused while a background pass holds the lock, and is told who has it", () => {
    const background = acquireResearchSyncLock("background");
    expect(background.ok).toBe(true);

    const manual = acquireResearchSyncLock("manual");
    expect(manual).toEqual({ ok: false, heldBy: "background" });

    if (manual.ok) throw new Error("expected manual acquire to be refused");
    const message = alreadyRunningMessage(manual.heldBy);
    expect(message).toContain("background refresh");
    expect(message).toContain("Nothing was skipped");
  });

  it("a stale token cannot free a lock a newer runner holds", () => {
    const first = acquireResearchSyncLock("manual");
    if (!first.ok) throw new Error("expected first acquire to succeed");
    releaseResearchSyncLock(first.token);

    const second = acquireResearchSyncLock("cron");
    expect(second.ok).toBe(true);

    // A late release from the already-finished manual run must not free
    // the cron run's lock.
    releaseResearchSyncLock(first.token);
    expect(currentResearchSyncRunner()).toBe("cron");
  });

  it("release by the owning token frees the lock", () => {
    const acquired = acquireResearchSyncLock("manual");
    if (!acquired.ok) throw new Error("expected acquire to succeed");
    expect(currentResearchSyncRunner()).toBe("manual");

    releaseResearchSyncLock(acquired.token);
    expect(currentResearchSyncRunner()).toBeNull();

    const reacquired = acquireResearchSyncLock("cron");
    expect(reacquired.ok).toBe(true);
    expect(currentResearchSyncRunner()).toBe("cron");
  });
});

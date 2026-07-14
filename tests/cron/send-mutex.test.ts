/**
 * In-process mutex for the cron email routes (briefing/digest/evening).
 *
 * Why: the launchd wrapper's curl abandons requests at its --max-time while
 * the Next.js handler keeps running — the retry then launches a SECOND full
 * pipeline concurrently, and both send (2026-07-12: Sunday briefing ×3, all
 * Mac-sent). The KV marker dance only dedups COMPLETED sends; this lock
 * closes the concurrent-in-flight window inside one server process.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  tryAcquireSendLock,
  releaseSendLock,
  _resetSendLocksForTest,
} from "@/lib/cron/send-mutex";

describe("send-mutex", () => {
  beforeEach(() => {
    _resetSendLocksForTest();
  });

  it("second acquire for the same type fails while the first is held", () => {
    expect(tryAcquireSendLock("briefing")).toBe(true);
    expect(tryAcquireSendLock("briefing")).toBe(false);
  });

  it("release frees the lock for the next acquire", () => {
    expect(tryAcquireSendLock("digest")).toBe(true);
    releaseSendLock("digest");
    expect(tryAcquireSendLock("digest")).toBe(true);
  });

  it("types are independent locks", () => {
    expect(tryAcquireSendLock("briefing")).toBe(true);
    expect(tryAcquireSendLock("digest")).toBe(true);
    expect(tryAcquireSendLock("evening")).toBe(true);
  });

  it("a stale lock (crashed run) can be taken over after 30 minutes", () => {
    const t0 = Date.parse("2026-07-12T20:32:00Z");
    expect(tryAcquireSendLock("briefing", t0)).toBe(true);
    // 10 minutes later — still held.
    expect(tryAcquireSendLock("briefing", t0 + 10 * 60 * 1000)).toBe(false);
    // 31 minutes later — stale, takeover allowed.
    expect(tryAcquireSendLock("briefing", t0 + 31 * 60 * 1000)).toBe(true);
  });

  it("releasing an unheld lock is a no-op", () => {
    expect(() => releaseSendLock("evening")).not.toThrow();
    expect(tryAcquireSendLock("evening")).toBe(true);
  });
});

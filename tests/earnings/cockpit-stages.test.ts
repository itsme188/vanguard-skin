import { describe, it, expect } from "vitest";
import {
  deriveEventStages,
  COCKPIT_BLOCKED_MIN_AGE_MS,
  type StageEventInputs,
} from "@/lib/earnings/cockpit-stages";
import { REACTION_READY_MS } from "@/lib/calendar/enrichment-runner";

// 2026-07-08 is EDT (UTC-4): 16:20 ET = 20:20 UTC.
const AMC_EVENT: StageEventInputs = {
  event_date: "2026-07-08",
  release_time: "16:20",
  actual_value: null,
  consensus_estimate: "EPS 0.94 · Rev 44100000000",
  consensus_value: null,
  reaction_snapshot: null,
};
const TODAY = "2026-07-08";
const NO_EMAILS = { preview: null, recap: null } as const;
const NO_SKIPS = { preview: false, recap: false } as const;

describe("deriveEventStages", () => {
  it("pre-release: preview pending, released upcoming with instant, actual/reaction pending, recap waiting", () => {
    const now = new Date("2026-07-08T14:00:00Z"); // 10:00 ET
    const s = deriveEventStages(AMC_EVENT, NO_EMAILS, NO_SKIPS, false, now, TODAY);
    expect(s.preview).toBe("pending");
    expect(s.released.state).toBe("upcoming");
    expect(s.released.releaseInstant).toBe("2026-07-08T20:20:00.000Z");
    expect(s.actual).toBe("pending");
    expect(s.reaction.state).toBe("pending");
    expect(s.reaction.readyAt).toBe(new Date(Date.parse("2026-07-08T20:20:00Z") + REACTION_READY_MS).toISOString());
    expect(s.recap).toBe("waiting");
  });

  it("email tri-state maps: sent / sent-by-cloud / in-flight", () => {
    const now = new Date("2026-07-08T14:00:00Z");
    expect(deriveEventStages(AMC_EVENT, { preview: "sent", recap: null }, NO_SKIPS, false, now, TODAY).preview).toBe("sent");
    expect(deriveEventStages(AMC_EVENT, { preview: "sent-by-cloud", recap: null }, NO_SKIPS, false, now, TODAY).preview).toBe("sent-by-cloud");
    expect(deriveEventStages(AMC_EVENT, { preview: "in-flight", recap: null }, NO_SKIPS, false, now, TODAY).preview).toBe("in-flight");
  });

  it("skip and mute both render skipped (mute family-decided by caller)", () => {
    const now = new Date("2026-07-08T14:00:00Z");
    expect(deriveEventStages(AMC_EVENT, NO_EMAILS, { preview: true, recap: false }, false, now, TODAY).preview).toBe("skipped");
    const muted = deriveEventStages(AMC_EVENT, NO_EMAILS, NO_SKIPS, true, now, TODAY);
    expect(muted.preview).toBe("skipped");
    expect(muted.recap).toBe("skipped");
  });

  it("post-release, no preview ever sent → missed", () => {
    const now = new Date("2026-07-08T21:00:00Z"); // 17:00 ET
    const s = deriveEventStages(AMC_EVENT, NO_EMAILS, NO_SKIPS, false, now, TODAY);
    expect(s.preview).toBe("missed");
    expect(s.released.state).toBe("released");
  });

  it("blocked at exactly the 2h boundary, pending just before", () => {
    const release = Date.parse("2026-07-08T20:20:00Z");
    const justBefore = new Date(release + COCKPIT_BLOCKED_MIN_AGE_MS - 1000);
    const atBoundary = new Date(release + COCKPIT_BLOCKED_MIN_AGE_MS);
    expect(deriveEventStages(AMC_EVENT, NO_EMAILS, NO_SKIPS, false, justBefore, TODAY).actual).toBe("pending");
    const blocked = deriveEventStages(AMC_EVENT, NO_EMAILS, NO_SKIPS, false, atBoundary, TODAY);
    expect(blocked.actual).toBe("blocked");
    expect(blocked.recap).toBe("blocked");
  });

  it("captured + plausible vs implausible actual", () => {
    const now = new Date("2026-07-08T21:00:00Z");
    const captured = deriveEventStages(
      { ...AMC_EVENT, actual_value: "EPS 0.99 · Rev 44500000000" },
      NO_EMAILS, NO_SKIPS, false, now, TODAY
    );
    expect(captured.actual).toBe("captured");
    // 3x consensus EPS → implausible per isPlausibleEarnings ratio guard
    const implausible = deriveEventStages(
      { ...AMC_EVENT, actual_value: "EPS 2.82 · Rev 44500000000" },
      NO_EMAILS, NO_SKIPS, false, now, TODAY
    );
    expect(implausible.actual).toBe("implausible");
  });

  it("reaction captured surfaces source; malformed JSON stays pending", () => {
    const now = new Date("2026-07-09T01:00:00Z");
    const captured = deriveEventStages(
      { ...AMC_EVENT, reaction_snapshot: JSON.stringify({ source: "tws" }) },
      NO_EMAILS, NO_SKIPS, false, now, TODAY
    );
    expect(captured.reaction).toEqual({ state: "captured", source: "tws", readyAt: null });
    const malformed = deriveEventStages(
      { ...AMC_EVENT, reaction_snapshot: "{not json" },
      NO_EMAILS, NO_SKIPS, false, now, TODAY
    );
    expect(malformed.reaction.state).toBe("pending");
    expect(malformed.reaction.readyAt).toBe(new Date(Date.parse("2026-07-08T20:20:00Z") + REACTION_READY_MS).toISOString());
  });

  it("null release_time: unknown released state today; carryover (yesterday) counts as released + blocked when no actual", () => {
    const now = new Date("2026-07-08T14:00:00Z");
    const noTime = { ...AMC_EVENT, release_time: null };
    const today = deriveEventStages(noTime, NO_EMAILS, NO_SKIPS, false, now, TODAY);
    expect(today.released.state).toBe("unknown");
    expect(today.preview).toBe("pending");
    expect(today.actual).toBe("pending");

    const yesterday = deriveEventStages(
      { ...noTime, event_date: "2026-07-07" },
      NO_EMAILS, NO_SKIPS, false, now, TODAY
    );
    expect(yesterday.released.state).toBe("released");
    expect(yesterday.preview).toBe("missed");
    expect(yesterday.actual).toBe("blocked");
  });

  it("carryover row with known late release instant: < 2h elapsed → pending; ≥ 2h → blocked", () => {
    // 2026-07-07 23:50 ET = 2026-07-08 03:50 UTC
    const ev = { ...AMC_EVENT, event_date: "2026-07-07", release_time: "23:50" };
    const todayEt = "2026-07-08";

    // 15 min after release: still pending
    const justAfter = new Date("2026-07-08T04:05:00Z");
    const s1 = deriveEventStages(ev, NO_EMAILS, NO_SKIPS, false, justAfter, todayEt);
    expect(s1.actual).toBe("pending");
    expect(s1.recap).toBe("waiting");

    // Exactly 2h after release: blocked
    const atBoundary = new Date("2026-07-08T05:50:00Z");
    const s2 = deriveEventStages(ev, NO_EMAILS, NO_SKIPS, false, atBoundary, todayEt);
    expect(s2.actual).toBe("blocked");
    expect(s2.recap).toBe("blocked");
  });
});

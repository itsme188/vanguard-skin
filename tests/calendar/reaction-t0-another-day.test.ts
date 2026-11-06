/**
 * A stored reaction whose release instant (t0) falls on a different Eastern
 * day than the event's date is not this print's measurement (QA finding
 * 2026-11-06: a feed row moved from one date to another kept the snapshot
 * captured for the earlier date, and the rebuilt recap scoreboard printed it
 * as the new print's T+2h move). The sync never clears enrichment, so the
 * reader is where the mismatch is caught. Synthetic figures throughout.
 */
import { describe, it, expect } from "vitest";
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot-core";
import {
  readReactionLegs,
  reactionLegVerdict,
  assessReactionSnapshot,
} from "@/lib/calendar/reaction-validity";
import { reactionSummaryPairs } from "@/app/dashboard/components/calendar/EnrichmentChips";

// 16:15 ET on 2026-10-28 (EDT, UTC-4), captured after the window.
const T0 = "2026-10-28T20:15:00.000Z";
const CAPTURED = "2026-10-28T22:20:00.000Z";

function snap(extra: Partial<ReactionSnapshot> = {}): ReactionSnapshot {
  return {
    t0_utc: T0,
    window_min: 120,
    source: "tws",
    captured_at: CAPTURED,
    symbol: { symbol: "ZZA", t_pre: 100, t_post: 99, delta_pct: -1 },
    spy: { t_pre: 600, t_post: 597, delta_pct: -0.5 },
    qqq: { t_pre: 500, t_post: 494, delta_pct: -1.2 },
    ...extra,
  } as ReactionSnapshot;
}

describe("a reaction t0 on another Eastern day than the event", () => {
  it("is measured when the event is dated the t0's Eastern day", () => {
    expect(reactionLegVerdict(snap(), snap().spy, { eventDate: "2026-10-28" })).toEqual({ state: "measured" });
  });

  it("is pending with its own reason when the event is dated another day", () => {
    expect(reactionLegVerdict(snap(), snap().spy, { eventDate: "2026-11-05" })).toEqual({
      state: "pending",
      reason: "t0_on_another_day",
    });
  });

  it("compares the Eastern day, not the UTC day", () => {
    // 20:00 ET on 2026-10-28 is 00:00 UTC on 10-29: still the 28th in New York.
    const late = snap({ t0_utc: "2026-10-29T00:00:00.000Z", captured_at: "2026-10-29T02:30:00.000Z" });
    expect(reactionLegVerdict(late, late.spy, { eventDate: "2026-10-28" }).state).toBe("measured");
    expect(reactionLegVerdict(late, late.spy, { eventDate: "2026-10-29" }).state).toBe("pending");
  });

  it("ignores an unreadable or absent event date and an unreadable t0", () => {
    expect(reactionLegVerdict(snap(), snap().spy, { eventDate: null }).state).toBe("measured");
    expect(reactionLegVerdict(snap(), snap().spy, { eventDate: "someday" }).state).toBe("measured");
    const noT0 = snap({ t0_utc: undefined as unknown as string, captured_at: undefined });
    expect(reactionLegVerdict(noT0, noT0.spy, { eventDate: "2026-11-05" }).state).toBe("measured");
  });

  it("readReactionLegs lists every leg as pending for the text readers", () => {
    const read = readReactionLegs(JSON.stringify(snap()), { eventDate: "2026-11-05" });
    expect(read).not.toBeNull();
    expect(Object.keys(read!.measured)).toEqual([]);
    expect(read!.pending).toEqual(["symbol", "spy", "qqq"]);
  });

  it("assessReactionSnapshot reports the reason so the repair script can clear it", () => {
    const a = assessReactionSnapshot(snap(), { eventDate: "2026-11-05" });
    expect(a.valid).toBe(false);
    expect(a.pendingLegs.map((p) => p.reason)).toEqual(["t0_on_another_day", "t0_on_another_day", "t0_on_another_day"]);
  });

  it("the week-ahead chip shows pending, never the percent, for the mismatched row", () => {
    const pairs = reactionSummaryPairs(snap(), { preferEventSymbol: true, eventDate: "2026-11-05" });
    expect(pairs.map((p) => p.pending ?? false)).toEqual([true, true]);
    expect(pairs.map((p) => p.pct)).toEqual([null, null]);
    const same = reactionSummaryPairs(snap(), { preferEventSymbol: true, eventDate: "2026-10-28" });
    expect(same.map((p) => p.pct)).toEqual([-1, -0.5]);
  });
});

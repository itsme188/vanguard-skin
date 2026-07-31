import { describe, it, expect } from "vitest";
import {
  parseReactionSnapshot,
  reactionSummaryPairs,
} from "@/app/dashboard/components/calendar/EnrichmentChips";
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot";

const base: ReactionSnapshot = {
  t0_utc: "2026-07-30T20:01:00.000Z",
  window_min: 120,
  source: "yahoo",
  spy: { t_pre: 741.4, t_post: 742.23, delta_pct: 0.11 },
  qqq: { t_pre: 683.53, t_post: 687.28, delta_pct: 0.55 },
  tlt: { t_pre: 82.83, t_post: 82.72, delta_pct: -0.13 },
};

describe("reactionSummaryPairs (week-ahead reaction line)", () => {
  it("defaults to SPY/QQQ — the existing Calendar row treatment", () => {
    expect(reactionSummaryPairs(base)).toEqual([
      { label: "SPY", pct: 0.11 },
      { label: "QQQ", pct: 0.55 },
    ]);
  });

  it("preferEventSymbol leads with the event's own stock when the snapshot has one", () => {
    const snap: ReactionSnapshot = {
      ...base,
      symbol: { symbol: "AMZN", t_pre: 235.58, t_post: 257, delta_pct: 9.09 },
    };
    expect(reactionSummaryPairs(snap, { preferEventSymbol: true })).toEqual([
      { label: "AMZN", pct: 9.09 },
      { label: "SPY", pct: 0.11 },
    ]);
  });

  it("preferEventSymbol degrades to SPY/QQQ when the snapshot has no symbol reaction (macro rows)", () => {
    expect(reactionSummaryPairs(base, { preferEventSymbol: true })).toEqual([
      { label: "SPY", pct: 0.11 },
      { label: "QQQ", pct: 0.55 },
    ]);
  });

  it("returns empty for a null snapshot", () => {
    expect(reactionSummaryPairs(null)).toEqual([]);
  });

  it("parseReactionSnapshot survives malformed JSON", () => {
    expect(parseReactionSnapshot("{not json")).toBeNull();
    expect(parseReactionSnapshot(null)).toBeNull();
  });
});

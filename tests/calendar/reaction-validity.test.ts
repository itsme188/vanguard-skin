/**
 * lib/calendar/reaction-validity.ts — the one test of "is this reaction a
 * measurement yet?" shared by the capture gate, the renderers and the repair
 * script. All prices are invented round figures.
 */
import { describe, it, expect } from "vitest";
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot-core";
import {
  admitCapturedReaction,
  assessReactionSnapshot,
  isReactionWindowElapsed,
  parseUtcInstantMs,
  reactionLegState,
  reactionLegVerdict,
  reactionWindowEndMs,
  withoutReactionLegs,
} from "@/lib/calendar/reaction-validity";

const T0 = "2026-01-05T15:00:00.000Z";
const T0_MS = Date.parse(T0);
const MIN = 60 * 1000;

function snap(extra: Partial<ReactionSnapshot> = {}): ReactionSnapshot {
  return {
    t0_utc: T0,
    window_min: 120,
    source: "yahoo",
    spy: { t_pre: 500, t_post: 505, delta_pct: 1 },
    qqq: { t_pre: 400, t_post: 398, delta_pct: -0.5 },
    tlt: { t_pre: 90, t_post: 90.45, delta_pct: 0.5 },
    ...extra,
  };
}

describe("window arithmetic", () => {
  it("the window ends at release + window_min", () => {
    expect(reactionWindowEndMs(T0_MS)).toBe(T0_MS + 120 * MIN);
    expect(reactionWindowEndMs(T0_MS, 60)).toBe(T0_MS + 60 * MIN);
  });

  it("elapsed only once now has reached the end; NaN fails closed", () => {
    expect(isReactionWindowElapsed(T0_MS, T0_MS + 7 * MIN)).toBe(false);
    expect(isReactionWindowElapsed(T0_MS, T0_MS + 119 * MIN)).toBe(false);
    expect(isReactionWindowElapsed(T0_MS, T0_MS + 120 * MIN)).toBe(true);
    expect(isReactionWindowElapsed(NaN, T0_MS)).toBe(false);
  });

  it("reads both ISO and SQLite UTC timestamps", () => {
    expect(parseUtcInstantMs("2026-01-05T15:00:00.000Z")).toBe(T0_MS);
    expect(parseUtcInstantMs("2026-01-05 15:00:00")).toBe(T0_MS);
    expect(parseUtcInstantMs(null)).toBeNull();
    expect(parseUtcInstantMs("not a date")).toBeNull();
  });
});

describe("reactionLegState", () => {
  it("a leg captured before its window elapsed is pending, whatever its figure", () => {
    const s = snap({ captured_at: new Date(T0_MS + 7 * MIN).toISOString() });
    expect(reactionLegVerdict(s, s.spy)).toEqual({
      state: "pending",
      reason: "captured_before_window_end",
    });
    expect(reactionLegState(s, s.qqq)).toBe("pending");
  });

  it("a leg captured at or after the window end is measured, even a flat one", () => {
    const s = snap({
      captured_at: new Date(T0_MS + 120 * MIN).toISOString(),
      tlt: { t_pre: 90, t_post: 90, delta_pct: 0 },
    });
    expect(reactionLegState(s, s.spy)).toBe("measured");
    expect(reactionLegState(s, s.tlt)).toBe("measured");
  });

  it("no capture stamp: an identical pre/post pair is pending", () => {
    const s = snap({ symbol: { symbol: "ZZA", t_pre: 100, t_post: 100, delta_pct: 0 } });
    expect(reactionLegVerdict(s, s.symbol)).toEqual({
      state: "pending",
      reason: "identical_pre_post",
    });
    // The other legs of the same snapshot stay measured.
    expect(reactionLegState(s, s.spy)).toBe("measured");
  });

  it("no capture stamp: a 0.00% leg on a row enriched minutes into the window is pending", () => {
    // The reported shape: prices a fraction of a cent apart, rounding to 0.00%.
    const s = snap({ symbol: { symbol: "ZZA", t_pre: 100.006, t_post: 100.01, delta_pct: 0 } });
    const enrichedSevenMinutesIn = "2026-01-05 15:07:00";
    expect(reactionLegVerdict(s, s.symbol, { rowEnrichedAt: enrichedSevenMinutesIn })).toEqual({
      state: "pending",
      reason: "zero_move_enriched_before_window_end",
    });
    // A non-zero leg on the same row is NOT condemned by the enrichment stamp
    // alone: a cloud actual can stamp enriched_at early while the reaction
    // arrives two hours later.
    expect(reactionLegState(s, s.spy, { rowEnrichedAt: enrichedSevenMinutesIn })).toBe("measured");
  });

  it("no capture stamp: a 0.00% leg on a row enriched after the window is measured", () => {
    const s = snap({ symbol: { symbol: "ZZA", t_pre: 100.006, t_post: 100.01, delta_pct: 0 } });
    expect(reactionLegState(s, s.symbol, { rowEnrichedAt: "2026-01-05 17:05:00" })).toBe("measured");
    // Inside the matcher's own 10-minute tolerance counts as on time.
    expect(reactionLegState(s, s.symbol, { rowEnrichedAt: "2026-01-05 16:52:00" })).toBe("measured");
    // No enrichment stamp at all: nothing to say it was early.
    expect(reactionLegState(s, s.symbol)).toBe("measured");
  });

  it("a dead-quote placeholder leg is absent, never pending or measured", () => {
    const s = snap({ qqq: { t_pre: 0, t_post: 0, delta_pct: 0 } });
    expect(reactionLegState(s, s.qqq)).toBe("absent");
    expect(reactionLegState(s, undefined)).toBe("absent");
    expect(reactionLegState(null, { t_pre: 1, t_post: 2, delta_pct: 100 })).toBe("absent");
  });

  it("a capture stamp with an unreadable t0 fails closed", () => {
    const s = snap({ t0_utc: "garbage", captured_at: new Date(T0_MS + 200 * MIN).toISOString() });
    expect(reactionLegState(s, s.spy)).toBe("pending");
  });
});

describe("admitCapturedReaction (the capture gate)", () => {
  it("refuses a snapshot taken before release + window", () => {
    expect(admitCapturedReaction(snap(), T0_MS + 7 * MIN)).toBeNull();
    expect(admitCapturedReaction(snap(), T0_MS + 119 * MIN)).toBeNull();
    expect(admitCapturedReaction(null, T0_MS + 500 * MIN)).toBeNull();
  });

  it("admits a snapshot taken at or after the window end and stamps captured_at", () => {
    const at = T0_MS + 121 * MIN;
    const out = admitCapturedReaction(snap(), at)!;
    expect(out.captured_at).toBe(new Date(at).toISOString());
    expect(out.spy).toEqual({ t_pre: 500, t_post: 505, delta_pct: 1 });
    expect(assessReactionSnapshot(out).valid).toBe(true);
  });

  it("never stores the all-zero placeholder as a leg", () => {
    const out = admitCapturedReaction(
      snap({ qqq: { t_pre: 0, t_post: 0, delta_pct: 0 } }),
      T0_MS + 121 * MIN,
    )!;
    expect("qqq" in out).toBe(false);
    expect(out.spy).toBeDefined();
  });

  it("no usable SPY/QQQ/TLT leg left means no snapshot", () => {
    const dead = { t_pre: 0, t_post: 0, delta_pct: 0 };
    const out = admitCapturedReaction(
      snap({ spy: dead, qqq: dead, tlt: dead, symbol: { symbol: "ZZA", t_pre: 10, t_post: 11, delta_pct: 10 } }),
      T0_MS + 121 * MIN,
    );
    expect(out).toBeNull();
  });

  it("does not mutate its input", () => {
    const input = snap({ qqq: { t_pre: 0, t_post: 0, delta_pct: 0 } });
    admitCapturedReaction(input, T0_MS + 121 * MIN);
    expect(input.qqq).toEqual({ t_pre: 0, t_post: 0, delta_pct: 0 });
    expect(input.captured_at).toBeUndefined();
  });
});

describe("assessReactionSnapshot / withoutReactionLegs", () => {
  it("a clean legacy snapshot is valid", () => {
    const a = assessReactionSnapshot(snap(), { rowEnrichedAt: "2026-01-05 15:07:00" });
    expect(a.valid).toBe(true);
    expect(a.measuredLegs).toEqual(["spy", "qqq", "tlt"]);
  });

  it("classifies premature, pending and placeholder legs", () => {
    const early = assessReactionSnapshot(snap({ captured_at: new Date(T0_MS + 7 * MIN).toISOString() }));
    expect(early.premature).toBe(true);
    expect(early.valid).toBe(false);

    const mixed = assessReactionSnapshot(
      snap({
        qqq: { t_pre: 0, t_post: 0, delta_pct: 0 },
        symbol: { symbol: "ZZA", t_pre: 100.006, t_post: 100.01, delta_pct: 0 },
      }),
      { rowEnrichedAt: "2026-01-05 15:07:00" },
    );
    expect(mixed.premature).toBe(false);
    expect(mixed.placeholderLegs).toEqual(["qqq"]);
    expect(mixed.pendingLegs).toEqual([
      { key: "symbol", reason: "zero_move_enriched_before_window_end" },
    ]);
    expect(mixed.measuredLegs).toEqual(["spy", "tlt"]);
    expect(mixed.valid).toBe(false);
  });

  it("stripping legs keeps the measured ones; nothing core left gives null", () => {
    const s = snap({ qqq: { t_pre: 0, t_post: 0, delta_pct: 0 } });
    const stripped = withoutReactionLegs(s, ["qqq"])!;
    expect("qqq" in stripped).toBe(false);
    expect(stripped.spy).toEqual(s.spy);
    expect(withoutReactionLegs(s, ["spy", "qqq", "tlt"])).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  buildFactSentence,
  checkNarrativePlausibility,
  composeLevelNarrative,
  extractProximityClaims,
  resolveAcceptedThesis,
} from "@/lib/levels/narrative-guard";

/**
 * "within N% of current level" is a distance claim with no above/below word.
 * It used to pass the guard, so a card could say "within 0.5% of current
 * level" beside a chip that read +12%. It is now held to the chip like every
 * other distance: N is a ceiling on the chip's figure, to rounding.
 */
describe("proximity claims ('within N% of current …') are held to the chip", () => {
  // Chip: (112 - 100) / 100 = +12.0%.
  const level = {
    price: 112,
    type: "resistance" as const,
    touches: 3,
    firstTouchDate: "2026-08-03",
    lastTouchDate: "2026-08-20",
  };
  const stale =
    "Tested 112 multiple times in August as resistance, creating rejection pattern within 0.5% of current level";

  it("reads the claim only when it is tied to the current price", () => {
    expect(extractProximityClaims(stale)).toEqual([
      { raw: "within 0.5% of current", withinPct: 0.5 },
    ]);
    expect(extractProximityClaims("Sits within roughly 2% of the current price.")).toHaveLength(1);
    expect(extractProximityClaims("Sits within 3% of its last close.")).toHaveLength(1);
    // Cluster tightness, not a distance from the price: left alone.
    expect(extractProximityClaims("Three touches within 1% of each other.")).toEqual([]);
    expect(extractProximityClaims("Each test came within 1% of the level.")).toEqual([]);
    expect(extractProximityClaims("Held within 5 sessions of the gap.")).toEqual([]);
  });

  it("a claim the chip contradicts fails, and the card hides the sentence", () => {
    expect(checkNarrativePlausibility(stale, 100, 112).plausible).toBe(false);
    expect(composeLevelNarrative({ ...level, narrative: stale }, 100)).toBe(buildFactSentence(level));
    expect(resolveAcceptedThesis({ ...level, confidence: "medium", narrative: stale }, 100)).toBe(
      buildFactSentence(level),
    );
  });

  it("a claim the chip agrees with stays, unedited", () => {
    // Chip: (100.4 - 100) / 100 = +0.4%.
    const near = { ...level, price: 100.4 };
    const text = "Rejected three times in August, now within 0.5% of current level.";
    expect(checkNarrativePlausibility(text, 100, 100.4).plausible).toBe(true);
    expect(composeLevelNarrative({ ...near, narrative: text }, 100)).toBe(
      `${buildFactSentence(near)} ${text}`,
    );
  });

  it("the ceiling uses the chip's rounding tolerance (half a point)", () => {
    // Chip +1.0% against "within 0.5%": 1.0 <= 0.5 + 0.5, so it passes.
    expect(checkNarrativePlausibility("Now within 0.5% of current price.", 100, 101).plausible).toBe(true);
    // Chip +1.2%: outside.
    expect(checkNarrativePlausibility("Now within 0.5% of current price.", 100, 101.2).plausible).toBe(false);
  });

  it("without a current price nothing is judged (fail open)", () => {
    expect(composeLevelNarrative({ ...level, narrative: stale }, null)).toBe(
      `${buildFactSentence(level)} ${stale}`,
    );
  });
});

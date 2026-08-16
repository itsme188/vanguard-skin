import { describe, it, expect } from "vitest";
import {
  extractNarrativeClaims,
  checkNarrativePlausibility,
  buildFallbackNarrative,
  guardNarrative,
  resolveAcceptedThesis,
} from "@/lib/levels/narrative-guard";

// Verbatim repro from QA finding
// security-detail-suggested-levels--narrative-magnitude-contradiction-regression-6:
// META, live price $591.33, support level $495.60 (LAST 2024-09-11). The
// card's own chip says -16.2% (distance TO the level from suggested-levels.ts
// distancePct, a DIFFERENT figure denominated off currentPrice). The true
// price-vs-level distance the narrative is trying to describe is
// (591.33 - 495.60) / 495.60 * 100 = +19.3%, but the model wrote "1619%".
const CURRENT_PRICE = 591.33;
const LEVEL_PRICE = 495.6;
const BAD_NARRATIVE =
  "Single touch on 2024-09-11 offers minimal support confirmation; price currently 1619% above this historical level.";
const GOOD_NARRATIVE =
  "Single touch on 2024-09-11 offers minimal support confirmation; price currently 19.3% above this historical level.";

const SAMPLE_LEVEL = {
  price: LEVEL_PRICE,
  type: "support" as const,
  touches: 1,
  lastTouchDate: "2024-09-11",
};

describe("extractNarrativeClaims", () => {
  it("extracts a percent claim in 'N% above/below' form", () => {
    const claims = extractNarrativeClaims(BAD_NARRATIVE, LEVEL_PRICE);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimedPct).toBeCloseTo(1619, 5);
    expect(claims[0].direction).toBe("above");
  });

  it("extracts a dollar claim ('$N above/below') normalized to percent-of-level", () => {
    // $95.73 above a $495.60 level ~= 19.31%
    const claims = extractNarrativeClaims(
      "Price sits $95.73 above this level, a modest premium.",
      LEVEL_PRICE,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].claimedPct).toBeCloseTo((95.73 / LEVEL_PRICE) * 100, 2);
    expect(claims[0].direction).toBe("above");
  });

  it("extracts a points claim ('N+ points above/below') normalized to percent-of-level", () => {
    const claims = extractNarrativeClaims(
      "Price trades 96+ points above this pivot.",
      LEVEL_PRICE,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].claimedPct).toBeCloseTo((96 / LEVEL_PRICE) * 100, 2);
    expect(claims[0].direction).toBe("above");
  });

  it("returns no claims for prose with no magnitude language", () => {
    const claims = extractNarrativeClaims(
      "Tested as support 4 times since December, coinciding with the 50-day SMA.",
      LEVEL_PRICE,
    );
    expect(claims).toHaveLength(0);
  });
});

describe("checkNarrativePlausibility", () => {
  it("flags the verbatim QA repro (1619% claimed vs 19.3% true) as implausible", () => {
    const result = checkNarrativePlausibility(BAD_NARRATIVE, CURRENT_PRICE, LEVEL_PRICE);
    expect(result.plausible).toBe(false);
  });

  it("passes a correct narrative through unchanged", () => {
    const result = checkNarrativePlausibility(GOOD_NARRATIVE, CURRENT_PRICE, LEVEL_PRICE);
    expect(result.plausible).toBe(true);
  });

  it("flags a direction contradiction even when the magnitude is close", () => {
    // Truth: price is ABOVE the level (current 591.33 > level 495.60).
    // Claim says BELOW with a plausible-looking magnitude — still wrong.
    const narrative =
      "Single touch on 2024-09-11 offers minimal support confirmation; price currently 19.3% below this historical level.";
    const result = checkNarrativePlausibility(narrative, CURRENT_PRICE, LEVEL_PRICE);
    expect(result.plausible).toBe(false);
  });

  it("forgives small rounding slack in the claimed magnitude", () => {
    // True distance is +19.31%; model rounds to "19%".
    const narrative =
      "Single touch on 2024-09-11 offers minimal support confirmation; price currently 19% above this historical level.";
    const result = checkNarrativePlausibility(narrative, CURRENT_PRICE, LEVEL_PRICE);
    expect(result.plausible).toBe(true);
  });

  it("passes prose with no numeric claim through untouched", () => {
    const narrative = "Tested as support 4 times since December, coinciding with the 50-day SMA.";
    const result = checkNarrativePlausibility(narrative, CURRENT_PRICE, LEVEL_PRICE);
    expect(result.plausible).toBe(true);
  });
});

describe("buildFallbackNarrative", () => {
  it("builds a computed-template sentence from real structured fields", () => {
    const sentence = buildFallbackNarrative(SAMPLE_LEVEL, CURRENT_PRICE);
    expect(sentence).toContain("2024-09-11");
    expect(sentence).toContain("above");
    expect(sentence).toMatch(/19\.3%/);
    expect(sentence.toLowerCase()).not.toContain("1619");
  });

  it("says 'below' when current price is under the level", () => {
    const sentence = buildFallbackNarrative(SAMPLE_LEVEL, 400);
    expect(sentence).toContain("below");
  });
});

describe("guardNarrative", () => {
  it("replaces an implausible narrative with the computed fallback", () => {
    const guarded = guardNarrative(BAD_NARRATIVE, CURRENT_PRICE, SAMPLE_LEVEL);
    expect(guarded).not.toBeNull();
    expect(guarded).not.toContain("1619");
    expect(guarded).toMatch(/19\.3%/);
  });

  it("leaves a plausible narrative untouched", () => {
    const guarded = guardNarrative(GOOD_NARRATIVE, CURRENT_PRICE, SAMPLE_LEVEL);
    expect(guarded).toBe(GOOD_NARRATIVE);
  });

  it("passes null/empty narratives through as null", () => {
    expect(guardNarrative(null, CURRENT_PRICE, SAMPLE_LEVEL)).toBeNull();
    expect(guardNarrative("", CURRENT_PRICE, SAMPLE_LEVEL)).toBeNull();
  });
});

describe("resolveAcceptedThesis (ACCEPT-path thesis persisted on level rows)", () => {
  const suggestion = {
    ...SAMPLE_LEVEL,
    confidence: "low" as const,
  };

  it("never persists an implausible narrative as the accepted thesis", () => {
    const thesis = resolveAcceptedThesis({ ...suggestion, narrative: BAD_NARRATIVE }, CURRENT_PRICE);
    expect(thesis).not.toContain("1619");
    expect(thesis).toMatch(/19\.3%/);
  });

  it("persists a plausible narrative verbatim", () => {
    const thesis = resolveAcceptedThesis({ ...suggestion, narrative: GOOD_NARRATIVE }, CURRENT_PRICE);
    expect(thesis).toBe(GOOD_NARRATIVE);
  });

  it("falls back to the structured pivot-clustering sentence when there is no narrative at all", () => {
    const thesis = resolveAcceptedThesis({ ...suggestion, narrative: null }, CURRENT_PRICE);
    expect(thesis).toContain("Auto-suggested from pivot clustering");
    expect(thesis).toContain("2024-09-11");
    expect(thesis).toContain("low");
  });

  it("skips the plausibility gate (best-effort) when currentPrice is unknown", () => {
    const thesis = resolveAcceptedThesis({ ...suggestion, narrative: BAD_NARRATIVE }, null);
    expect(thesis).toBe(BAD_NARRATIVE);
  });
});

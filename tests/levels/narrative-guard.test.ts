import { describe, it, expect } from "vitest";
import {
  extractNarrativeClaims,
  checkNarrativePlausibility,
  checkNarrativeFacts,
  chipDistancePct,
  buildFallbackNarrative,
  buildFactSentence,
  isFactSentence,
  narrativeRationale,
  composeLevelNarrative,
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
//
// 2026-10-07 (owner ruling, regression-7): the guard now holds the prose to
// the CHIP's denominator, so the sentence that agrees with this card is the
// one that says 16.2% — (591.33 - 495.60) / 591.33. "19.3%" beside a "-16.2%"
// chip is the two-denominators defect and is no longer the good case.
const CURRENT_PRICE = 591.33;
const LEVEL_PRICE = 495.6;
const BAD_NARRATIVE =
  "Single touch on 2024-09-11 offers minimal support confirmation; price currently 1619% above this historical level.";
const GOOD_NARRATIVE =
  "Single touch on 2024-09-11 offers minimal support confirmation; price currently 16.2% above this historical level.";

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

// QA finding security-detail-levels--suggestion-narrative-contradicts-chip-
// accept-persists-regression-1 (root cause b): CLAIM_RE only matched the
// NUMBER-then-direction order ("207 above"). The live sentence put the
// direction word FIRST — "a floor above current 207 level" — so the guard
// extracted nothing and the hallucinated price sailed through onto the card
// (and into `security_levels.thesis` on ACCEPT). The security's real price
// was 278.91.
const LIVE_CURRENT_PRICE = 278.91;
const LIVE_LEVEL_PRICE = 250.4;
const LIVE_BAD_NARRATIVE =
  "Four touches since October mark this shelf, with last bounce in January establishing a floor above current 207 level.";

const LIVE_LEVEL = {
  price: LIVE_LEVEL_PRICE,
  type: "support" as const,
  touches: 4,
  lastTouchDate: "2026-01-14",
};

describe("word-first price claims ('above <number>', not '<number> above')", () => {
  it("extracts the live 'floor above current 207 level' claim", () => {
    const claims = extractNarrativeClaims(LIVE_BAD_NARRATIVE, LIVE_LEVEL_PRICE);
    expect(claims).toHaveLength(1);
    expect(claims[0].direction).toBe("above");
    expect(claims[0].claimedPrice).toBeCloseTo(207, 5);
    expect(claims[0].refersToCurrent).toBe(true);
  });

  it("flags the live sentence as implausible (claims current 207, truth 278.91)", () => {
    const result = checkNarrativePlausibility(
      LIVE_BAD_NARRATIVE,
      LIVE_CURRENT_PRICE,
      LIVE_LEVEL_PRICE,
    );
    expect(result.plausible).toBe(false);
  });

  it("replaces the live sentence at the render/storage seam", () => {
    const guarded = guardNarrative(LIVE_BAD_NARRATIVE, LIVE_CURRENT_PRICE, LIVE_LEVEL);
    expect(guarded).not.toContain("207");
    expect(guarded).toContain("2026-01-14");
  });

  it("never persists the live sentence as an ACCEPT'd thesis", () => {
    const thesis = resolveAcceptedThesis(
      { ...LIVE_LEVEL, confidence: "high", narrative: LIVE_BAD_NARRATIVE },
      LIVE_CURRENT_PRICE,
    );
    expect(thesis).not.toContain("207");
  });

  it("accepts a word-first claim that states the REAL current price", () => {
    const good =
      "Four touches since October mark this shelf, with last bounce in January establishing a floor above current 278.91 level.";
    expect(
      checkNarrativePlausibility(good, LIVE_CURRENT_PRICE, LIVE_LEVEL_PRICE).plausible,
    ).toBe(true);
  });

  it("accepts a word-first claim that states the LEVEL price", () => {
    const good = "Buyers defended the shelf, holding above 250.40 on all four tests.";
    expect(
      checkNarrativePlausibility(good, LIVE_CURRENT_PRICE, LIVE_LEVEL_PRICE).plausible,
    ).toBe(true);
  });

  it("forgives a rounded restatement of the level price", () => {
    const good = "Buyers defended the shelf, holding above the 250 mark on all four tests.";
    expect(
      checkNarrativePlausibility(good, LIVE_CURRENT_PRICE, LIVE_LEVEL_PRICE).plausible,
    ).toBe(true);
  });

  // Review finding (2026-08-28): WORD_FIRST_CLAIM_RE's hedge group was a
  // REPEATED capture — `(?:the|a|current|price|of|...)\s+){0,4}` — so it kept
  // only its LAST iteration. For "above the current price of 250.40" the
  // captured hedge was just "of ", `refersToCurrent` came back false, and the
  // claim was then allowed to match EITHER known price. It matched the level
  // (250.40) and passed — even though the sentence asserts the CURRENT price
  // is 250.40 while the security actually trades at 278.91. That false
  // current-price sentence could be persisted verbatim as a thesis on ACCEPT.
  const MULTI_HEDGE_BAD =
    "Buyers keep stepping in here, establishing a floor above the current price of 250.40.";

  it("captures the COMPLETE hedge phrase, not just its last word", () => {
    const claims = extractNarrativeClaims(MULTI_HEDGE_BAD, LIVE_LEVEL_PRICE);
    expect(claims).toHaveLength(1);
    expect(claims[0].kind).toBe("price");
    expect(claims[0].claimedPrice).toBeCloseTo(250.4, 5);
    expect(claims[0].refersToCurrent).toBe(true);
  });

  it("flags 'above the current price of 250.40' when current is 278.91", () => {
    const result = checkNarrativePlausibility(
      MULTI_HEDGE_BAD,
      LIVE_CURRENT_PRICE,
      LIVE_LEVEL_PRICE,
    );
    expect(result.plausible).toBe(false);
    expect(result.reason).toContain("current price");
  });

  it("never persists the multi-hedge false current-price sentence as a thesis", () => {
    const thesis = resolveAcceptedThesis(
      { ...LIVE_LEVEL, confidence: "high", narrative: MULTI_HEDGE_BAD },
      LIVE_CURRENT_PRICE,
    );
    expect(thesis).not.toContain("floor above the current price");
    expect(thesis).toContain("2026-01-14");
  });

  it("still accepts a multi-hedge claim that states the REAL current price", () => {
    const good =
      "Buyers keep stepping in here, with the shelf sitting below the current price of 278.91.";
    expect(
      checkNarrativePlausibility(good, LIVE_CURRENT_PRICE, LIVE_LEVEL_PRICE).plausible,
    ).toBe(true);
  });

  it("still catches a word-first PERCENT claim in the wrong magnitude", () => {
    const bad = "Price sits above 1619% of this historical level.";
    expect(checkNarrativePlausibility(bad, CURRENT_PRICE, LEVEL_PRICE).plausible).toBe(false);
  });

  // Over-stripping guards: these numbers are lookback windows, calendar
  // years, and touch counts — NOT price assertions. Flagging them would
  // discard perfectly good prose.
  it.each([
    ["a moving-average period", "Price has held above the 50-day moving average since October."],
    ["a weekly lookback", "Support has stayed above its 20-week base."],
    ["a calendar year", "Price has traded above the 2024 breakout shelf all year."],
    ["a touch count", "Buyers stepped in above 4 times at this shelf."],
    ["no number at all", "Price is holding above this historical shelf on rising volume."],
  ])("does not flag %s", (_label, narrative) => {
    expect(extractNarrativeClaims(narrative, LIVE_LEVEL_PRICE)).toHaveLength(0);
    expect(
      checkNarrativePlausibility(narrative, LIVE_CURRENT_PRICE, LIVE_LEVEL_PRICE).plausible,
    ).toBe(true);
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
    // The chip's distance is 16.19%; model rounds to "16%".
    const narrative =
      "Single touch on 2024-09-11 offers minimal support confirmation; price currently 16% above this historical level.";
    const result = checkNarrativePlausibility(narrative, CURRENT_PRICE, LEVEL_PRICE);
    expect(result.plausible).toBe(true);
  });

  it("passes prose with no numeric claim through untouched", () => {
    const narrative = "Tested as support 4 times since December, coinciding with the 50-day SMA.";
    const result = checkNarrativePlausibility(narrative, CURRENT_PRICE, LEVEL_PRICE);
    expect(result.plausible).toBe(true);
  });
});

// 2026-10-07 (owner ruling, regression-3): the template states the touch
// count and dates only. It used to end "price currently N% above this
// historical level" on the level's denominator — the very sentence that
// disagreed with the chip — and a percentage goes stale as the price moves.
describe("buildFallbackNarrative", () => {
  it("builds a computed-template sentence from real structured fields", () => {
    const sentence = buildFallbackNarrative(SAMPLE_LEVEL, CURRENT_PRICE);
    expect(sentence).toBe("Support touched once, on 2024-09-11.");
    expect(sentence).toBe(buildFactSentence(SAMPLE_LEVEL));
  });

  it("states no distance, whatever the current price", () => {
    const sentence = buildFallbackNarrative(SAMPLE_LEVEL, 400);
    expect(sentence).not.toMatch(/%|above|below/);
    expect(sentence).toBe(buildFallbackNarrative(SAMPLE_LEVEL, CURRENT_PRICE));
  });
});

describe("guardNarrative", () => {
  it("replaces an implausible narrative with the computed fallback", () => {
    const guarded = guardNarrative(BAD_NARRATIVE, CURRENT_PRICE, SAMPLE_LEVEL);
    expect(guarded).not.toBeNull();
    expect(guarded).not.toContain("1619");
    expect(guarded).toBe("Support touched once, on 2024-09-11.");
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
    expect(thesis).toBe("Support touched once, on 2024-09-11.");
  });

  // 2026-10-07 (owner ruling, regression-3): the thesis is the SAME string the
  // card shows — the templated facts, then the model's sentence as rationale.
  it("persists the fact sentence followed by a plausible narrative, unedited", () => {
    const thesis = resolveAcceptedThesis({ ...suggestion, narrative: GOOD_NARRATIVE }, CURRENT_PRICE);
    expect(thesis).toBe(`Support touched once, on 2024-09-11. ${GOOD_NARRATIVE}`);
    expect(thesis).toBe(composeLevelNarrative({ ...suggestion, narrative: GOOD_NARRATIVE }, CURRENT_PRICE));
  });

  it("persists the fact sentence alone when there is no narrative at all", () => {
    const thesis = resolveAcceptedThesis({ ...suggestion, narrative: null }, CURRENT_PRICE);
    expect(thesis).toBe("Support touched once, on 2024-09-11.");
    expect(thesis).toBe(composeLevelNarrative({ ...suggestion, narrative: null }, CURRENT_PRICE));
  });

  it("skips the distance gate (best-effort) when currentPrice is unknown", () => {
    const thesis = resolveAcceptedThesis({ ...suggestion, narrative: BAD_NARRATIVE }, null);
    expect(thesis).toBe(`Support touched once, on 2024-09-11. ${BAD_NARRATIVE}`);
  });
});

// QA finding security-detail-suggested-levels--narrative-magnitude-
// contradiction-regression-7. Synthetic card: price 100, resistance at 112.
// The chip prints (112 - 100) / 100 = +12.0%. The old guard measured on the
// level, (112 - 100) / 112 = 10.7%, and its 30% / 3-point tolerance forgave
// the gap between the two, so "10.7% below" sat beside a "+12.0%" chip.
describe("distance claims are held to the chip's denominator, to rounding", () => {
  const CURRENT = 100;
  const RESISTANCE = { price: 112, type: "resistance" as const, touches: 2, lastTouchDate: "2026-03-10", firstTouchDate: "2026-01-06" };
  const SUPPORT = { price: 80, type: "support" as const, touches: 2, lastTouchDate: "2026-03-10", firstTouchDate: "2026-01-06" };

  it("chipDistancePct is the chip's own formula (over the current price, signed toward the level)", () => {
    expect(chipDistancePct(CURRENT, 112)).toBeCloseTo(12, 9);
    expect(chipDistancePct(CURRENT, 80)).toBeCloseTo(-20, 9);
  });

  it("flags the level-denominated percentage (10.7% beside a +12.0% chip)", () => {
    const prose = "Sellers capped two rallies here; price currently 10.7% below this historical level.";
    expect(checkNarrativePlausibility(prose, CURRENT, 112).plausible).toBe(false);
    expect(narrativeRationale(prose, CURRENT, RESISTANCE)).toBeNull();
  });

  it("flags the level-denominated percentage on a support (25% beside a -20.0% chip)", () => {
    const prose = "Buyers stepped in here; price currently 25% above this historical level.";
    expect(checkNarrativePlausibility(prose, CURRENT, 80).plausible).toBe(false);
    expect(narrativeRationale(prose, CURRENT, SUPPORT)).toBeNull();
  });

  it.each([
    ["the chip's figure", "price now 12.0% below this resistance."],
    ["a whole-percent rounding", "price now 12% below this resistance."],
    ["half a point of slack", "price now 12.5% below this resistance."],
  ])("passes %s", (_label, prose) => {
    expect(checkNarrativePlausibility(prose, CURRENT, 112).plausible).toBe(true);
  });

  it("flags a percentage more than half a point from the chip", () => {
    expect(checkNarrativePlausibility("price now 12.6% below this resistance.", CURRENT, 112).plausible).toBe(false);
    expect(checkNarrativePlausibility("price now 11.4% below this resistance.", CURRENT, 112).plausible).toBe(false);
  });

  it("puts a dollar claim on the same denominator", () => {
    expect(checkNarrativePlausibility("Price sits $12 below this level.", CURRENT, 112).plausible).toBe(true);
    expect(checkNarrativePlausibility("Price sits $15 below this level.", CURRENT, 112).plausible).toBe(false);
  });

  it("hides the disagreeing sentence and never rewrites it: the card shows the fact sentence alone", () => {
    const prose = "Sellers capped two rallies here; price currently 10.7% below this historical level.";
    const shown = composeLevelNarrative({ ...RESISTANCE, narrative: prose }, CURRENT);
    expect(shown).toBe("Resistance touched 2 times between 2026-01-06 and 2026-03-10.");
    expect(shown).not.toContain("%");
  });
});

// QA finding security-detail-levels--suggestion-narrative-contradicts-chip-
// accept-persists-regression-3. Synthetic shapes of the two filed cards:
// chip "1× · last 2026-05-29" with prose about July and August, and chip
// "11× · last 2025-12-10" with prose "most recently July 30".
describe("touch-count and date claims are held to the chip's metadata", () => {
  const ONE_TOUCH = { price: 112, type: "resistance" as const, touches: 1, lastTouchDate: "2026-05-29", firstTouchDate: "2026-05-29" };
  const ELEVEN = { price: 80, type: "support" as const, touches: 11, lastTouchDate: "2025-12-10", firstTouchDate: "2025-06-02" };

  it("flags 'multiple times in August' on a one-touch level last touched in May", () => {
    const prose = "Stock surged through this shelf on July 31, tested it multiple times in August, now approaching from below.";
    expect(checkNarrativeFacts(prose, ONE_TOUCH).plausible).toBe(false);
    expect(composeLevelNarrative({ ...ONE_TOUCH, narrative: prose }, 100)).toBe(
      "Resistance touched once, on 2026-05-29.",
    );
  });

  it("flags 'tested twice' on a one-touch level", () => {
    expect(checkNarrativeFacts("Resistance tested twice in the past week.", ONE_TOUCH).plausible).toBe(false);
  });

  it("flags 'most recently July 30' when the last touch is 2025-12-10", () => {
    const prose = "Support held 11 times since June, most recently July 30, confirming structural demand.";
    const result = checkNarrativeFacts(prose, ELEVEN);
    expect(result.plausible).toBe(false);
    expect(result.reason).toContain("last touch");
  });

  it("flags 'since December' when the first touch is in June", () => {
    expect(checkNarrativeFacts("Defended 11 times since December.", ELEVEN).plausible).toBe(false);
  });

  it("flags a wrong touch count in digits, words and the × form", () => {
    expect(checkNarrativeFacts("Held 9 times this year.", ELEVEN).plausible).toBe(false);
    expect(checkNarrativeFacts("Four touches mark this shelf.", ELEVEN).plausible).toBe(false);
    expect(checkNarrativeFacts("A 7× tested shelf.", ELEVEN).plausible).toBe(false);
  });

  it("flags a month outside the touch window and an ISO date after the last touch", () => {
    expect(checkNarrativeFacts("Buyers returned in March.", ELEVEN).plausible).toBe(false);
    expect(checkNarrativeFacts("Rebounded off this level on 2026-02-03.", ELEVEN).plausible).toBe(false);
  });

  it.each([
    ["the right count and both ends of the window", "Held 11 times since June, most recently in December."],
    ["a month inside the window", "Eleven touches, with a sharp bounce in September."],
    ["the exact last touch day", "Defended again, most recently December 10."],
    ["no count and no date", "Coincides with the 50-day moving average and a prior gap."],
    ["'may' as a verb", "May act as a floor if sellers return."],
    ["'once' that is not a count", "Once resistance, now a shelf buyers defend."],
  ])("passes %s", (_label, prose) => {
    expect(checkNarrativeFacts(prose, ELEVEN)).toEqual({ plausible: true });
  });

  it("fails open on window checks when the first touch date is unknown", () => {
    const noFirst = { price: 80, type: "support" as const, touches: 4, lastTouchDate: "2026-01-14" };
    expect(checkNarrativeFacts("Four touches since October, last bounce in January.", noFirst).plausible).toBe(true);
    // ...but the last-touch claim still needs no window.
    expect(checkNarrativeFacts("Four touches, last bounce in March.", noFirst).plausible).toBe(false);
  });
});

describe("the templated fact sentence and the composed card text", () => {
  const level = { price: 80, type: "support" as const, touches: 11, lastTouchDate: "2025-12-10", firstTouchDate: "2025-06-02" };

  it("writes the facts from the chip's metadata, in three shapes", () => {
    expect(buildFactSentence(level)).toBe("Support touched 11 times between 2025-06-02 and 2025-12-10.");
    expect(buildFactSentence({ ...level, firstTouchDate: undefined })).toBe(
      "Support touched 11 times, most recently on 2025-12-10.",
    );
    expect(buildFactSentence({ ...level, type: "resistance", touches: 1, firstTouchDate: "2025-12-10" })).toBe(
      "Resistance touched once, on 2025-12-10.",
    );
  });

  it("recognises its own sentences and nothing else", () => {
    expect(isFactSentence(buildFactSentence(level))).toBe(true);
    expect(isFactSentence(buildFactSentence({ ...level, firstTouchDate: undefined }))).toBe(true);
    expect(isFactSentence("Resistance touched once, on 2025-12-10.")).toBe(true);
    expect(isFactSentence("Support touched 11 times since June.")).toBe(false);
  });

  it("appends a rationale that passes every check, unedited", () => {
    const rationale = "Coincides with the 50-day moving average and a prior gap.";
    expect(composeLevelNarrative({ ...level, narrative: rationale }, 100)).toBe(
      `Support touched 11 times between 2025-06-02 and 2025-12-10. ${rationale}`,
    );
  });

  it("does not print a stored fact sentence twice", () => {
    // The storage seam keeps the fact sentence when the model's fails the guard.
    const stored = guardNarrative("Held 9 times, most recently July 30.", 100, level);
    expect(stored).toBe(buildFactSentence(level));
    expect(composeLevelNarrative({ ...level, narrative: stored }, 100)).toBe(buildFactSentence(level));
  });

  it("render and ACCEPT are one string", () => {
    const sug = { ...level, confidence: "high", narrative: "Coincides with the 50-day moving average." };
    expect(resolveAcceptedThesis(sug, 100)).toBe(composeLevelNarrative(sug, 100));
    const bad = { ...level, confidence: "high", narrative: "Held 9 times; price currently 25% above this level." };
    expect(resolveAcceptedThesis(bad, 100)).toBe(buildFactSentence(level));
  });
});

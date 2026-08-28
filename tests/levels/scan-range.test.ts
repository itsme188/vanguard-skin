/**
 * Regression pin (qa:levels-suggestions--accept-arms-level-beyond-plausibility-
 * scan-range-regression-2): the scanner refuses to evaluate any non-option
 * level more than LEVEL_PLAUSIBILITY_MAX_DISTANCE away from the current price.
 * That band lived only inside checkLevelTriggerState, so the suggestion engine
 * kept offering un-scannable levels and the armed list kept presenting them as
 * live coverage. The band is now one exported predicate — these tests pin its
 * shape (in-band / beyond-band / options exemption / boundary / missing input)
 * so a UI surface and the scanner can never disagree again.
 */

import { describe, it, expect } from "vitest";
import {
  isLevelBeyondScanRange,
  LEVEL_PLAUSIBILITY_MAX_DISTANCE,
  moveNeededPct,
  scanRangeDistancePct,
} from "@/lib/levels/scan-range";

describe("isLevelBeyondScanRange", () => {
  it("keeps the band at 50% (changing the constant is a separate decision)", () => {
    expect(LEVEL_PLAUSIBILITY_MAX_DISTANCE).toBe(0.5);
  });

  it("returns false for a level the scanner will evaluate (in band)", () => {
    // 130 vs 100: |100 - 130| / 130 = 23% away
    expect(isLevelBeyondScanRange(130, 100, "stock")).toBe(false);
    // 80 vs 100: |100 - 80| / 80 = 25% away
    expect(isLevelBeyondScanRange(80, 100, "stock")).toBe(false);
  });

  it("returns true for a level the scanner permanently skips (beyond band)", () => {
    // 300 vs 100: |100 - 300| / 300 = 66.7% away
    expect(isLevelBeyondScanRange(300, 100, "stock")).toBe(true);
    // 40 vs 100: |100 - 40| / 40 = 150% away
    expect(isLevelBeyondScanRange(40, 100, "stock")).toBe(true);
  });

  it("measures distance against the LEVEL price, matching the scanner's denominator", () => {
    // level 60, price 100 → 66.7% by the level's denominator (40% by spot's).
    // The scanner divides by the level, so this one is out of range.
    expect(isLevelBeyondScanRange(60, 100, "stock")).toBe(true);
  });

  it("treats exactly-at-the-edge as in band (guard is strictly greater-than)", () => {
    // 100 vs 150: |150 - 100| / 100 = exactly 0.5
    expect(isLevelBeyondScanRange(100, 150, "stock")).toBe(false);
  });

  it("exempts options at any distance (premiums legitimately halve/double)", () => {
    expect(isLevelBeyondScanRange(300, 100, "option")).toBe(false);
    expect(isLevelBeyondScanRange(300, 100, "Option")).toBe(false);
    expect(isLevelBeyondScanRange(300, 100, "OPTION")).toBe(false);
  });

  it("treats a missing / unknown security type as non-option", () => {
    expect(isLevelBeyondScanRange(300, 100, null)).toBe(true);
    expect(isLevelBeyondScanRange(300, 100, undefined)).toBe(true);
    expect(isLevelBeyondScanRange(300, 100)).toBe(true);
  });

  it("never flags when a price is missing — unknown is not 'out of range'", () => {
    expect(isLevelBeyondScanRange(null, 100, "stock")).toBe(false);
    expect(isLevelBeyondScanRange(300, null, "stock")).toBe(false);
    expect(isLevelBeyondScanRange(null, null, "stock")).toBe(false);
  });
});

// Regression pin (qa:alerts-armed--distance-pct-uses-level-denominator-
// overstates-move): the Armed tab quoted scanRangeDistancePct's LEVEL-
// denominator figure as "away", which reads as a much bigger move than the
// security page's own spot-denominator %. moveNeededPct uses CURRENT price
// as the denominator so the Armed tab and the security page can never
// disagree.
describe("moveNeededPct", () => {
  it("is positive for an upside target above current price", () => {
    // level 130, current 100 → (130 - 100) / 100 = +30%
    expect(moveNeededPct(100, 130)).toBeCloseTo(30, 10);
  });

  it("is negative for a downside target below current price", () => {
    // level 45.4, current 100 → (45.4 - 100) / 100 = -54.6%
    expect(moveNeededPct(100, 45.4)).toBeCloseTo(-54.6, 10);
  });

  it("differs from scanRangeDistancePct's level-denominator figure on the same inputs", () => {
    // level 45.4, current 100: level-denominator distance is huge (120.2%),
    // spot-denominator move needed is the modest, security-page-matching -54.6%.
    const levelDenominator = scanRangeDistancePct(45.4, 100);
    const spotDenominator = moveNeededPct(100, 45.4);
    expect(levelDenominator).toBeCloseTo(120.26, 1);
    expect(spotDenominator).toBeCloseTo(-54.6, 10);
  });

  it("returns null when current price is 0 (can't divide by spot)", () => {
    expect(moveNeededPct(0, 130)).toBeNull();
  });

  it("returns null when either input is missing", () => {
    expect(moveNeededPct(null, 130)).toBeNull();
    expect(moveNeededPct(100, undefined)).toBeNull();
    expect(moveNeededPct(null, null)).toBeNull();
  });
});

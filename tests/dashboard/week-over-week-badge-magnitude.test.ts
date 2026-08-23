import { describe, it, expect } from "vitest";
import { formatWeekOverWeekMagnitude } from "@/app/dashboard/components/analysis/WeekOverWeekBadge";

describe("formatWeekOverWeekMagnitude", () => {
  it("is NOT zero for a delta that is well above eps and survives rounding", () => {
    expect(formatWeekOverWeekMagnitude(0.12, 2, false)).toEqual({
      isZero: false,
      magnitude: "0.12",
    });
    expect(formatWeekOverWeekMagnitude(-0.015, 2, true)).toEqual({
      isZero: false,
      magnitude: "1.50%",
    });
  });

  it("clears the raw eps floor but rounds to zero at the displayed digits — regression for the SPY/QQQ '-0.00' badge bug", () => {
    // |0.004| > eps (0.001), but toFixed(2) rounds it to "0.00": this used
    // to fall through to the arrow branch and render "↓ 0.00 / 7d" with a
    // "-0.00" title.
    expect(formatWeekOverWeekMagnitude(0.004, 2, false)).toEqual({
      isZero: true,
      magnitude: "0.00",
    });
    expect(formatWeekOverWeekMagnitude(-0.004, 2, false)).toEqual({
      isZero: true,
      magnitude: "0.00",
    });
  });

  it("is zero when the raw value is below eps (unchanged)", () => {
    expect(formatWeekOverWeekMagnitude(0.0002, 2, false)).toEqual({
      isZero: true,
      magnitude: "0.00",
    });
  });

  it("respects a non-default digits count (e.g. PositionRisk's digits=1) for both the zero check and the magnitude string", () => {
    // 0.03 clears eps (0.001) but rounds away to "0.0" at digits=1.
    expect(formatWeekOverWeekMagnitude(0.03, 1, false)).toEqual({
      isZero: true,
      magnitude: "0.0",
    });
    // 0.06 rounds to "0.1" at digits=1 — a real, non-zero change.
    expect(formatWeekOverWeekMagnitude(0.06, 1, false)).toEqual({
      isZero: false,
      magnitude: "0.1",
    });
  });

  it("never produces a negative-zero magnitude string", () => {
    const { magnitude } = formatWeekOverWeekMagnitude(-0.001, 2, false);
    expect(magnitude).not.toMatch(/^-/);
  });
});

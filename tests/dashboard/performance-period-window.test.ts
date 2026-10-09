import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// QA finding `analysis-performance--annualized-return-window-30-days-longer-
// than-days-label` (HIGH, reproduced 2026-09-02 and 2026-09-03): the Period
// window card described one window (first in-window snapshot → end) while the
// annualized figures beside it described another (measurement anchor → end,
// ~30 days longer). Three numbers, two windows, one card.
//
// User ruling 2026-09-02 — Option 1: the card's START becomes the measurement
// anchor and DAYS = anchor → END, so the card and the annualizer describe ONE
// window. The annualizer's own window is NOT touched (f7a9cf9 stands: the
// return really was earned over the anchor window).
describe("Period window card and the annualized figures describe ONE window", () => {
  const src = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");

  it("the Start cell renders the measurement anchor, not the first in-window snapshot", () => {
    expect(src).toContain("fmtDate(twrResult?.measurementStartDate)");
    // `startDate` (first in-window snapshot) must not feed the card again —
    // that is the exact pairing that produced the mismatch.
    expect(src).not.toContain("fmtDate(twrResult?.startDate)");
  });

  it("the Days cell renders totalDays — the same denominator annualize() uses", () => {
    expect(src).toContain("twrResult?.totalDays ?? ");
    // displayDays is gone from the compute layer; nothing may reintroduce it.
    expect(src).not.toContain("displayDays");
  });

  it("carries a one-line caption explaining the anchored start", () => {
    expect(src).toContain("Chained from the prior month-end anchor");
  });

  // B4 ruling (2026-10-08): a fixed period (1Y / 3Y / 5Y) is the full span
  // ending at the last statement anchor. The card still reads the chain's own
  // measurementStartDate / endDate / totalDays (pins above, unchanged); what
  // changed is the window handed to the chain, so the card now shows the full
  // span. The chain must be bounded at BOTH ends by the shared window rule.
  it("the chain behind the card is bounded by the shared window rule at both ends", () => {
    const flat = src.replace(/\s+/g, " ");
    expect(flat).toContain("startDate: chainStart, endDate: chainEnd,");
    expect(flat).toContain("const chainStart = perfWindow.chainStartDate;");
    expect(src).not.toContain("startDateForPeriod");
  });

  it("the per-account coverage window under the annualized column uses the same anchor", () => {
    expect(src).toContain("fmtMonthYear(acc.measurementStartDate)");
    expect(src).not.toContain("fmtMonthYear(acc.startDate)");
  });
});

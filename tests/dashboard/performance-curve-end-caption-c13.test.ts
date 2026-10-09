/**
 * C13 — the equity-curve caption names BOTH ends of the daily series.
 *
 * The curve plots every daily point the book has, so it can run past the
 * Period window card's End (the last month-end anchor the TWR chain reaches).
 * The caption says so instead of leaving two end dates on one page.
 * PerformanceView opens the production db at import and the repo has no DOM
 * harness, so the copy is pinned by reading the source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const view = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

const curveAt = anchorIndex(view, "<PerformanceCurveChart");
const curve = flat(view.slice(curveAt, anchorIndex(view, "{attribution && (", curveAt)));

describe("equity-curve caption names the end overshoot", () => {
  it("compares the curve's own last plotted day with the TWR window's end", () => {
    expect(curve).toContain("const windowEnd = twrResult?.endDate ?? null;");
    expect(curve).toContain(
      "const runsPastWindow = curveEnd !== null && windowEnd !== null && curveEnd > windowEnd;",
    );
  });

  it("names both dates and says which figure stops at the anchor", () => {
    const at = anchorIndex(curve, "{runsPastWindow && (");
    const tail = curve.slice(at);
    expect(tail).toContain("daily history runs to {fmtDate(curveEnd ?? undefined)}");
    expect(tail).toContain("past the Period window’s {fmtDate(windowEnd ?? undefined)} month-end anchor");
    expect(tail).toContain("the TWR above stops at that anchor");
  });

  it("renders when only the end overshoots (a period the daily history fully covers)", () => {
    expect(curve).toContain("return notice || runsPastWindow ? (");
  });

  // B4 ruling (2026-10-08) deliberately changed this pin: a FIXED period
  // (1Y / 3Y / 5Y) now ends the curve at the last statement anchor, the same
  // end as the TWR beside it. YTD and All still plot every daily point to
  // today, which is where the overshoot caption above still applies.
  it("the curve ends at the page window's end: today for YTD / All, the statement anchor for a fixed period", () => {
    // U13 changed the loader (one summed series for the whole scope, started
    // at the scope's first statement); the END this test pins is unchanged.
    expect(flat(view)).toContain(
      "getDailyValuationsForAccounts(db, scopeAccountIds ?? [], { startDate: curveSeriesStart, endDate: dailyEnd, fullCoverageOnly: true, })",
    );
    expect(flat(view)).toContain("const dailyEnd = perfWindow.endDate;");
    expect(flat(view)).not.toContain("{ startDate: effectiveStart, endDate: twrResult");
  });
});

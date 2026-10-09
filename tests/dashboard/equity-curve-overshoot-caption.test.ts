/**
 * The equity-curve caption always names the start and end of the daily data
 * the curve is computed from.
 *
 * Browser finding (IBKR scope, YTD): when the daily history fully covered the
 * selected period there was no "computed from daily data" notice, and the
 * caption read only "Equity curve: the daily history runs to <end>, past the
 * Period window's <anchor> month-end anchor", with no start date. The other
 * scopes opened with "computed from daily data <start> – <end>".
 * Caption text only: no computation is touched.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { equityCurveOvershootClause } from "@/lib/compute/performance-window-caption";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const TAIL =
  "The daily history runs to Oct 7, 2026, past the Period window’s Sep 30, 2026 month-end anchor — the TWR above stops at that anchor";

describe("equityCurveOvershootClause", () => {
  it("no shorter-history notice: opens the caption and names the start and end of the daily data", () => {
    expect(
      equityCurveOvershootClause({
        afterNotice: false,
        curveStart: "2026-01-02",
        curveEnd: "2026-10-07",
        windowEnd: "2026-09-30",
      }),
    ).toBe(`Equity curve: computed from daily data Jan 2, 2026 – Oct 7, 2026. ${TAIL}`);
  });

  it("after the shorter-history notice (which already names both dates): only the overshoot sentence", () => {
    expect(
      equityCurveOvershootClause({
        afterNotice: true,
        curveStart: "2026-03-16",
        curveEnd: "2026-10-07",
        windowEnd: "2026-09-30",
      }),
    ).toBe(`. ${TAIL}`);
  });
});

describe("PerformanceView renders the overshoot through the builder", () => {
  const view = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8").replace(/\s+/g, " ");
  const at = anchorIndex(view, "{runsPastWindow &&");
  const tail = view.slice(at, anchorIndex(view, "{attribution && (", at));

  it("passes the curve's own first and last plotted day", () => {
    expect(tail).toContain("equityCurveOvershootClause({");
    expect(tail).toContain("afterNotice: notice !== null,");
    expect(tail).toContain("curveStart,");
    expect(tail).toContain("curveEnd,");
    expect(tail).toContain("windowEnd,");
  });

  it("has no hand-written opening left that could drop the start date", () => {
    expect(tail).not.toContain("Equity curve: the");
  });
});

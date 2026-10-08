/**
 * B17 — Performance captions say what they describe.
 *
 * PerformanceView and PeriodAttributionSection are server components that
 * open the production db singleton at import and the repo has no DOM harness,
 * so the copy is pinned by reading the source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const view = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");
const section = readFileSync("app/dashboard/components/PeriodAttributionSection.tsx", "utf8");
/** JSX text with line breaks and indentation folded to single spaces. */
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("cross-check banner names where the drawer is", () => {
  it("both branches point at the Workspace view and the strip cell that opens the drawer", () => {
    const pointer = "in the trust drawer on the Workspace view (open its “Cross-checked (Modified Dietz)” cell)";
    expect(view.split(pointer)).toHaveLength(3);
    // No branch is left with the bare pointer to a drawer this view lacks.
    expect(view).not.toMatch(/in the trust drawer\.\s/);
  });

  it("the trust claim stays gated on the month's own band", () => {
    const gate = anchorIndex(view, 'reconciliation.band === "consistent" ? (');
    const claim = anchorIndex(view, "Independently cross-checked (Modified Dietz) through", gate);
    const fallback = anchorIndex(view, "Latest independent check for", claim);
    expect(fallback).toBeGreaterThan(claim);
  });
});

describe("the two daily-data captions cannot share wording with different dates", () => {
  const curveAt = anchorIndex(view, "<PerformanceCurveChart");
  const curve = flat(view.slice(curveAt, anchorIndex(view, "{attribution && (", curveAt)));

  it("the equity-curve caption names its metric", () => {
    expect(curve).toContain("Equity curve: {notice.charAt(0).toLowerCase() + notice.slice(1)}");
    expect(curve).not.toContain('<p className="text-xs text-ink-faint -mt-2">{notice}</p>');
  });

  it("when its window is not the risk tiles' window it gives the reason and names theirs", () => {
    expect(curve).toContain("riskStart !== curveStart || riskEnd !== curveEnd");
    const at = anchorIndex(curve, "{curveWindowDiffers && (");
    const tail = curve.slice(at);
    expect(tail).toContain("It plots only days that also have a {BENCHMARK_SYMBOL} close");
    expect(tail).toContain("{fmtDate(riskStart ?? undefined)}");
    expect(tail).toContain("{fmtDate(riskEnd ?? undefined)}");
  });

  it("the risk caption still names Max drawdown & Sharpe and reads the risk series", () => {
    expect(flat(view)).toContain("riskResult?.seriesStart ?? null, riskResult?.seriesEnd ?? null,");
    expect(view).toContain("Max drawdown &amp; Sharpe: {notice.charAt(0).toLowerCase() + notice.slice(1)}");
  });
});

describe("beta/alpha card says what its parts add up to", () => {
  const cardAt = anchorIndex(section, "Beta vs alpha decomposition");
  const card = flat(section.slice(cardAt));

  it("states the decomposed daily-series return through <Pct> and the observation count", () => {
    expect(card).toContain("The two parts add up to");
    expect(card).toContain("<Pct value={attribution.decomposedReturn.portfolioReturn * 100} digits={2} signed />");
    expect(card).toContain("{attribution.decomposedReturn.observations} daily observations");
  });

  it("says it is not the TWR tile, and makes no claim that the two agree", () => {
    expect(card).toContain("a different measure from the TWR tile above");
    expect(card).toContain("so the two need not match");
    expect(card).not.toMatch(/reconcil/i);
  });

  it("the window caption is still rendered", () => {
    expect(card).toContain("{betaWindowCaption && (");
  });
});

describe("dead cumulativeGain is gone", () => {
  it("PerformanceView no longer declares it", () => {
    expect(view).not.toContain("cumulativeGain");
  });
});

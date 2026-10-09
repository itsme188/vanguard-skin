import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

// Source-pin: the account equity curve plots through the shape-preserving
// anchor correction (owner ruling 2026-10-06), shows its caption, and
// surfaces the recorded daily value in the tooltip.
const src = () => readFileSync("app/dashboard/components/EquityCurveChart.tsx", "utf8");

describe("EquityCurveChart anchor-correction wiring", () => {
  it("imports the pure anchor module", () => {
    expect(src()).toMatch(
      /import\s*\{[^}]*\banchorDailiesToStatements\b[^}]*\bequityCurveRangeCaption\b[^}]*\bformatAnchoredTooltipValue\b[^}]*\}\s*from\s*"@\/lib\/chart\/equity-curve-anchor"/,
    );
  });

  it("builds chart data through anchorDailiesToStatements", () => {
    const text = src();
    const body = sliceBetween(text, "function buildChartData(", "// ─── Performance benchmark overlay chart");
    expect(body).toContain("anchorDailiesToStatements(");
    const chart = text.slice(anchorIndex(text, "export function EquityCurveChart"));
    expect(chart).toContain("buildChartData(snapshots, dailyValuations, flows)");
  });

  it("the old interpolation / progress-rescale / multiplicative-trailing code is gone", () => {
    const text = src();
    for (const dead of [
      "mergeSnapshotsAndDaily",
      "addTrailingDailyData",
      "useTimeInterpolation",
      "snapRange",
      "dailyRange",
      "* scale",
    ]) {
      expect(text).not.toContain(dead);
    }
  });

  it("renders the caption from equityCurveCaption in a small muted line", () => {
    const chart = src().slice(anchorIndex(src(), "export function EquityCurveChart"));
    expect(chart).toContain("const anchorCaption = equityCurveRangeCaption(anchorSummary, rangeCutoffIso(selectedRange));");
    expect(chart).toMatch(
      /\{anchorCaption && \(\s*<p className="text-\[10px\] text-ink-faint mt-2">\{anchorCaption\}<\/p>/,
    );
  });

  it("every account-chart Tooltip routes the total through formatAnchoredTooltipValue with the privacy formatter", () => {
    const chart = src().slice(anchorIndex(src(), "export function EquityCurveChart"));
    const tooltips = chart.match(/<Tooltip[\s\S]*?\/>/g) ?? [];
    expect(tooltips.length).toBeGreaterThanOrEqual(2);
    for (const block of tooltips) {
      const f = block.slice(anchorIndex(block, "formatter={"));
      expect(f).toContain("formatAnchoredTooltipValue(");
      expect(f).toContain("recordedValue");
      expect(f).toContain("currencyTooltipFormatter");
    }
  });
});

describe("equity-curve flow wiring", () => {
  it("the server page fetches flows and passes them down to the chart", () => {
    const page = readFileSync("app/dashboard/accounts/page.tsx", "utf8");
    expect(page).toContain("fetchNetFlowsByDate(");
    expect(page).toContain("equityFlows={equityFlows}");
    const detail = readFileSync("app/dashboard/components/AccountDetail.tsx", "utf8");
    expect(detail).toContain("flows={equityFlows}");
  });

  it("the chart hands flows to the anchor module", () => {
    expect(src()).toMatch(/anchorDailiesToStatements\([\s\S]*?,\s*flows\s*\)/);
  });
});

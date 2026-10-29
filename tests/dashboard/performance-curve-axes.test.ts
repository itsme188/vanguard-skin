/**
 * Performance equity curve: the tooltip names the year and the value axis
 * frames the plotted index instead of anchoring at zero.
 *
 * QA: dashboard-analysis-view-performance-equity-curve-tooltip-equity-curve-tooltip-date-has-no-year-on-a-chart-that
 * QA: dashboard-analysis-view-performance-equity-curve-y-axis-performance-equity-curve-y-axis-starts-at-0-squashing-
 *
 * Source-pin tests (no DOM harness): the chart file is read and the two
 * props are located inside the PerformanceCurveChart component. Synthetic
 * values only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import {
  equityCurveYAxis,
  formatEquityCurveDate,
  isoDateToEpochMs,
} from "@/lib/chart/equity-curve-anchor";

const FILE = "app/dashboard/components/EquityCurveChart.tsx";

function performanceChartSource(): string {
  const src = readFileSync(FILE, "utf8");
  const start = anchorIndex(src, "export function PerformanceCurveChart(");
  return src.slice(start);
}

describe("Performance equity curve tooltip date", () => {
  it("the label formatter uses the full style, which carries the year", () => {
    const whole = readFileSync(FILE, "utf8");
    const fn = anchorIndex(whole, "function performanceTooltipDate(");
    const body = whole.slice(fn, fn + 200);
    expect(body).toContain('"full"');
    expect(body).not.toContain('"day"');
    const src = performanceChartSource();
    anchorIndex(src, "labelFormatter={(label, payload) => performanceTooltipDate(");
  });

  it("two Januaries on one chart get different labels", () => {
    const a = formatEquityCurveDate(isoDateToEpochMs("2025-01-06"), "full");
    const b = formatEquityCurveDate(isoDateToEpochMs("2026-01-09"), "full");
    expect(a).toBe("Jan 6, 2025");
    expect(b).toBe("Jan 9, 2026");
    expect(a).not.toBe(formatEquityCurveDate(isoDateToEpochMs("2026-01-06"), "full"));
  });
});

describe("Performance equity curve value axis", () => {
  it("the YAxis takes its domain and ticks from equityCurveYAxis over both series", () => {
    const src = performanceChartSource();
    const yAxis = anchorIndex(src, "const yAxis = equityCurveYAxis(");
    const call = src.slice(yAxis, yAxis + 120);
    expect(call).toContain("d.portfolio");
    expect(call).toContain("d.benchmark");
    const axis = anchorIndex(src, "<YAxis");
    const axisProps = src.slice(axis, src.indexOf("/>", axis));
    expect(axisProps).toContain("domain={yAxis?.domain}");
    expect(axisProps).toContain("ticks={yAxis?.ticks}");
  });

  it("an index running 100 to 125 is framed near its own range, not from zero", () => {
    const axis = equityCurveYAxis([100, 104.2, 112.5, 125, 100, 103, 118]);
    expect(axis).not.toBeNull();
    const [lo, hi] = axis!.domain;
    expect(lo).toBeGreaterThanOrEqual(90);
    expect(lo).toBeLessThanOrEqual(100);
    expect(hi).toBeGreaterThanOrEqual(125);
    expect(hi).toBeLessThanOrEqual(140);
    expect(axis!.ticks[0]).toBe(lo);
  });
});

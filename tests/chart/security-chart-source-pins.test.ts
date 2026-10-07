import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

// SecurityChart cannot be rendered in vitest (dynamic import of
// lightweight-charts, no DOM harness), so the wiring is pinned at the source.
const src = readFileSync(
  join(process.cwd(), "app/dashboard/components/SecurityChart.tsx"),
  "utf8",
);

describe("privacy mode leaves public chart data readable (qa: charts-privacy--masks-public-price-axis-and-last-price-badge)", () => {
  it("has no mask literal anywhere in the chart", () => {
    expect(src).not.toContain("\\u2022");
    expect(src).not.toContain("•");
  });

  it("formats the axis through chartAxisPriceLabel with no privacy branch", () => {
    const formatter = sliceBetween(src, "priceFormatter: (p: number) =>", "\n");
    expect(formatter).toContain("chartAxisPriceLabel(currencyRef.current, p)");
    expect(formatter).not.toMatch(/isPrivate/);
    // One definition only — the privacy effect no longer re-installs one.
    expect(src.split("priceFormatter:").length - 1).toBe(1);
  });

  it("no longer renders the OHLC legend or volume through a masking component", () => {
    // <Money> is no longer imported (comments may still name it).
    expect(src).toContain('import { Count } from "@/lib/privacy/components";');
    const chartMoney = src.slice(anchorIndex(src, "function ChartMoney("));
    const body = chartMoney.slice(0, anchorIndex(chartMoney, "\n}\n"));
    expect(body).not.toMatch(/usePrivacy|isPrivate/);
    expect(src).toContain("{formatNumber(legend.volume)}");
  });

  it("still masks trade share counts: every marker update receives the privacy flag", () => {
    const calls = src.match(/updateMarkers\(\s*lc,[\s\S]*?\);/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const call of calls) {
      expect(call).toMatch(/isPrivateRef\.current|isPrivate,/);
    }
  });

  it("masks the count of trades left off the chart", () => {
    const note = src.slice(anchorIndex(src, "function HiddenTradesNote("));
    expect(note.slice(0, anchorIndex(note, "\n}\n"))).toContain("<Count value=");
  });
});

describe("toolbar and crosshair legend are separate rows (qa: charts-toolbar-single--txns-sr-refresh-offscreen-1280-rail-open, charts-toolbar--hover-ohlc-readout-shifts-controls-135px, security-detail-chart-toolbar--refresh-button-outside-panel-1280-rail-open)", () => {
  const toolbar = sliceBetween(src, "<ScrollFade", "</ScrollFade>");

  it("keeps the OHLC readout out of the toolbar row", () => {
    expect(toolbar).not.toContain("legend.open");
    expect(toolbar).not.toContain("legend &&");
    expect(toolbar).toContain("handleRefresh");
  });

  it("renders the readout after the toolbar in a row with a reserved height", () => {
    const after = src.slice(anchorIndex(src, "</ScrollFade>"));
    const rowStart = anchorIndex(after, '<div className="chart-legend shrink-0 h-6');
    expect(rowStart).toBeLessThan(anchorIndex(after, "legend.open"));
    // Reserved even with no bar hovered: the row is not conditional on `legend`.
    expect(after.slice(0, rowStart)).toMatch(/\{!compact && \(\s*$/);
  });

  it("lets the control groups wrap from md up instead of overflowing (qa: charts-watchlist-panel-toolbar--clips-last-five-controls-horizontal-scroll)", () => {
    expect(toolbar).toMatch(/px-3 py-1\.5 min-w-0 md:flex-wrap/);
    expect(toolbar).toMatch(/ml-auto md:shrink md:min-w-0 md:flex-wrap/);
  });

  it("orders the indicator readouts like the toolbar", () => {
    expect(src).toContain("INDICATORS.filter((ind) => legend.indicators?.[ind.key] != null)");
  });
});

describe("compact panel rows cannot be crushed (qa: mobile-charts-2x2--bars-footer-crushed-blank-strip)", () => {
  it("pins the staleness footer and lets the chart area give way", () => {
    expect(src).toContain(
      '<div className="chart-chrome shrink-0 px-3 py-1 border-t border-edge text-xs text-ink-faint truncate">',
    );
    expect(src).toContain('compact ? "min-h-[160px]" : "min-h-[300px]"');
  });
});

describe("resize keeps the visible bars (qa: charts--stale-bar-spacing-after-rail-resize-blank-left-band, charts-watchlist--twin-panels-same-symbol-same-range-render-different-date-windows)", () => {
  const observer = sliceBetween(src, "new ResizeObserver((entries) => {", "resizeObserver.observe(");

  it("captures the logical range before resizing and re-applies it after", () => {
    const capture = anchorIndex(observer, "getVisibleLogicalRange()");
    const apply = anchorIndex(observer, "chart.applyOptions({ width, height })");
    const restore = anchorIndex(observer, "setVisibleLogicalRange(rangeBefore)");
    expect(capture).toBeLessThan(apply);
    expect(apply).toBeLessThan(restore);
  });

  it("fits when there is no range to keep, and only on a width change", () => {
    expect(observer).toContain("fitChartContent(chart, candleSeries, markerSummaryRef.current)");
    expect(observer).toContain("const widthChanged = width !== lastObservedWidth;");
  });
});

describe("chart wiring for the remaining rows", () => {
  it("rejects an add-level click at or below zero", () => {
    const click = sliceBetween(src, "chart.subscribeClick((param) => {", "setAddPopover(");
    expect(click).toContain("if (price <= 0) return;");
  });

  it("keeps the true-last-price line inside the autoscale", () => {
    expect(src).toContain(
      "priceRange: extendPriceRangeToInclude(info.priceRange, overridePriceRef.current)",
    );
    const effect = sliceBetween(src, "overridePriceRef.current = override", "createPriceLine(");
    expect(effect).toContain("series.applyOptions(");
  });

  it("filters suggestions against the active levels before drawing, and redraws when they change", () => {
    const draw = sliceBetween(src, "const draw = () => {", "redrawSuggestedRef.current = draw;");
    expect(anchorIndex(draw, "dedupeSuggestedLevels(fetched, active")).toBeLessThan(
      anchorIndex(draw, "createPriceLine("),
    );
    // The only createPriceLine for suggestions is the filtered one.
    const effect = sliceBetween(src, "// Suggested support/resistance overlay", "}, [securityId, showSuggested, seriesReady]);");
    expect(effect.split("createPriceLine(").length - 1).toBe(1);
    expect(src).toMatch(/redrawSuggestedRef\.current\?\.\(\);\s*\n\s*\}, \[activeLevelKey\]\);/);
  });

  it("refuses to switch on an average that cannot be drawn, and says why", () => {
    const toggle = sliceBetween(src, "const toggleIndicator = (key: IndicatorKey) => {", "setActiveIndicators((prev)");
    expect(toggle).toContain("setIndicatorNote(reason);");
    expect(toggle).toContain("return;");
  });

  it("maps trades to bars itself rather than leaving it to the chart library", () => {
    const fn = src.slice(anchorIndex(src, "function updateMarkers("));
    expect(fn).toContain("placeTransactionMarkers(transactions, barDates)");
    expect(fn).toContain("time: barDate as");
    expect(fn).not.toContain("time: t.date");
  });
});

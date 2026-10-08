/**
 * C04 -- source pins for the time axis in EquityCurveChart.tsx (no DOM
 * harness). All three XAxis blocks are numeric time axes on the epoch field,
 * rows are date-ordered before charting, and every tooltip label resolves the
 * hovered point's own date.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/EquityCurveChart.tsx", "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

const perfAt = anchorIndex(src, "export function PerformanceCurveChart");
const accountAt = anchorIndex(src, "export function EquityCurveChart");
const perf = src.slice(perfAt, accountAt);
const account = src.slice(accountAt);

function xAxisBlocks(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("<XAxis", from);
    if (at === -1) break;
    const end = anchorIndex(text, "/>", at, "XAxis end");
    out.push(flat(text.slice(at, end)));
    from = end;
  }
  return out;
}

describe("the three XAxis blocks are numeric time axes", () => {
  const blocks = [...xAxisBlocks(perf), ...xAxisBlocks(account)];

  it("there are exactly three: benchmark overlay, split lines, area", () => {
    expect(xAxisBlocks(perf)).toHaveLength(1);
    expect(xAxisBlocks(account)).toHaveLength(2);
  });

  it.each([0, 1, 2])("block %i: epoch field, number type, time scale, data-bounded domain", (i) => {
    const b = blocks[i];
    expect(b).toContain('dataKey="t"');
    expect(b).toContain('type="number"');
    expect(b).toContain('scale="time"');
    expect(b).toContain('domain={["dataMin", "dataMax"]}');
    expect(b).toContain("ticks={");
    expect(b).toContain("minTickGap={40}");
    expect(b).not.toContain('dataKey="date"');
  });

  it("no category axis on the date string is left anywhere in the file", () => {
    expect(src).not.toContain('<XAxis dataKey="date"');
    expect(flat(src)).not.toMatch(/<XAxis[^>]*dataKey="date"/);
  });

  it("ticks and labels come from the pure tick function", () => {
    expect(perf).toContain("const xAxisTime = equityCurveTimeTicks(series[0]?.t, series[series.length - 1]?.t);");
    expect(flat(xAxisBlocks(perf)[0])).toContain("ticks={xAxisTime.ticks}");
    expect(flat(xAxisBlocks(perf)[0])).toContain("formatEquityCurveTick(t, xAxisTime.unit)");
    expect(account).toContain("const xAxisTime = equityCurveTimeTicks(data[0]?.t, data[data.length - 1]?.t);");
    expect(account).toContain("const xTickFormatter = (t: number) => formatEquityCurveTick(t, xAxisTime.unit);");
    expect(account).toContain("const xTicks = xAxisTime.ticks;");
    for (const b of xAxisBlocks(account)) {
      expect(b).toContain("tickFormatter={xTickFormatter}");
      expect(b).toContain("ticks={xTicks}");
    }
  });
});

describe("rows are date-ordered before charting", () => {
  it("the account chart filters the range on real dates, then orders by date", () => {
    expect(account).toContain("const data = toTimeSeries(filterByRange(rawData, selectedRange));");
    const filter = sliceBetween(src, "function filterByRange<", "// ─── Chart data types");
    expect(filter).toContain("return data.filter((d) => d.date >= cutoffStr);");
    // both charts plot `data`
    expect(account.match(/data=\{data\}/g)).toHaveLength(2);
  });

  it("the benchmark overlay plots the date-ordered series", () => {
    expect(perf).toContain("const series = toTimeSeries(data);");
    expect(perf).toContain("<LineChart data={series}");
    expect(perf).not.toContain("<LineChart data={data}");
  });

  it("the caption, badge and value axis still read the same filtered rows", () => {
    expect(account).toContain("const granularity = equityCurveGranularity(data.map((d) => d.date));");
    expect(account).toContain("const yAxis = equityCurveYAxis(");
  });
});

describe("tooltip labels keep the point's date key", () => {
  it("both account tooltips resolve the date from the hovered point, then format as before", () => {
    const hits = account.match(
      /labelFormatter=\{\(label, payload\) => dateFormatter\(equityCurveTooltipDate\(label, payload\) \?\? ""\)\}/g,
    );
    expect(hits).toHaveLength(2);
    expect(account).toContain('const dateFormatter = granularity === "monthly" ? formatDate : formatDateFull;');
  });

  it("the benchmark overlay tooltip does the same with the short date", () => {
    expect(perf).toContain(
      'labelFormatter={(label, payload) => shortDate(equityCurveTooltipDate(label, payload) ?? "")}',
    );
  });

  it("no label is read as a raw string any more", () => {
    expect(src).not.toContain("String(label)");
  });

  it("date formatting goes through the UTC formatter, never a local-time Date", () => {
    expect(src).not.toContain('new Date(date + "T00:00:00")');
    const fmts = sliceBetween(src, "function formatDate(", "// ─── Data filtering");
    expect(fmts).toContain('formatEquityCurveDate(isoDateToEpochMs(date), "month-year")');
    expect(fmts).toContain('formatEquityCurveDate(isoDateToEpochMs(date), "full")');
  });
});

describe("nothing compensates for the time axis", () => {
  it("no index-spaced tick helper and no extra caption", () => {
    expect(src).not.toContain("monthStartTicks");
    expect(account.match(/<p className="text-\[10px\] text-ink-faint mt-2">/g)).toHaveLength(2);
  });
});

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  splitAllocationForDonut,
  donutChartData,
  donutSliceColorByGroup,
} from "@/app/dashboard/components/AnalysisView";
import type { AllocationEntry } from "@/lib/queries/analysis";
import { anchorIndex } from "../helpers/source-anchor";

// [qa:analysis-allocation-donut--shorts-rendered-as-positive-slices]
// Owner ruling 2026-08-31, option 1: a pie cannot draw a negative slice, so
// the donut is LONG-ONLY and a caption under it discloses the excluded net
// short. Synthetic book — invented symbols and round numbers only.

function row(group_name: string, total_market_value: number, net: number): AllocationEntry {
  return {
    group_name,
    total_market_value,
    percentage: (total_market_value * 100) / net,
    net_exposure: total_market_value,
    exposure_pct: (total_market_value * 100) / net,
    position_count: 1,
  };
}

const NET = 1000 + 600 + 400 - 200 - 300;
const BOOK: AllocationEntry[] = [
  row("Sector AAA", 1000, NET),
  row("Sector BBB", 600, NET),
  row("Sector CCC", 400, NET),
  row("Sector YYY", -200, NET),
  row("Sector ZZZ", -300, NET),
];

describe("allocation donut is long-only (synthetic short book)", () => {
  it("keeps only the long rows as slices", () => {
    const book = splitAllocationForDonut(BOOK);
    expect(book.longRows.map((r) => r.group_name)).toEqual([
      "Sector AAA",
      "Sector BBB",
      "Sector CCC",
    ]);
    expect(book.shortCount).toBe(2);
    expect(book.hasShorts).toBe(true);
  });

  it("sum of slice values = the long-only total", () => {
    const book = splitAllocationForDonut(BOOK);
    const slices = donutChartData(book);
    const sliceSum = slices.reduce((s, r) => s + r.total_market_value, 0);
    expect(sliceSum).toBe(2000);
    expect(sliceSum).toBe(book.longTotal);
    expect(slices.every((s) => s.total_market_value > 0)).toBe(true);
  });

  it("the caption figure is the net short, and long + short = the net the table states", () => {
    const book = splitAllocationForDonut(BOOK);
    expect(book.shortTotal).toBe(-500);
    // netTotal is summed independently over EVERY row (what the Breakdown
    // table beside the chart adds up to), so this identity is a real check.
    const tableNet = BOOK.reduce((s, r) => s + r.total_market_value, 0);
    expect(book.netTotal).toBe(tableNet);
    expect(book.longTotal + book.shortTotal).toBe(book.netTotal);
  });

  it("the identity survives the Other roll-up (more long rows than slices)", () => {
    const many: AllocationEntry[] = [];
    for (let i = 0; i < 12; i++) many.push(row(`Long ${i}`, 1200 - i * 100, 1));
    many.push(row("Short A", -700, 1));
    const book = splitAllocationForDonut(many);
    const slices = donutChartData(book);
    expect(slices).toHaveLength(8);
    expect(slices[7].group_name).toBe("Other (5)");
    const sliceSum = slices.reduce((s, r) => s + r.total_market_value, 0);
    expect(sliceSum).toBe(book.longTotal);
    expect(sliceSum + book.shortTotal).toBe(book.netTotal);
  });

  it("a book with no shorts is unchanged: no caption, long total = net total", () => {
    const longOnly = BOOK.filter((r) => r.total_market_value > 0);
    const book = splitAllocationForDonut(longOnly);
    expect(book.hasShorts).toBe(false);
    expect(book.shortTotal).toBe(0);
    expect(book.longTotal).toBe(book.netTotal);
    expect(donutChartData(book)).toEqual(longOnly);
  });

  it("a zero-value row is neither a slice nor a short", () => {
    const book = splitAllocationForDonut([...BOOK, row("Flat", 0, NET)]);
    expect(book.longRows).toHaveLength(3);
    expect(book.shortCount).toBe(2);
    expect(book.longTotal + book.shortTotal).toBe(book.netTotal);
  });

  it("an all-short book yields no slices and still discloses the short", () => {
    const book = splitAllocationForDonut([row("Short A", -400, -400)]);
    expect(donutChartData(book)).toEqual([]);
    expect(book.hasShorts).toBe(true);
    expect(book.shortTotal).toBe(-400);
    expect(book.netTotal).toBe(-400);
  });

  it("table dots take the colour of the row's own slice; a short row has none", () => {
    // A short sorted ahead of a long must not shift the long rows' colours.
    const shuffled = [BOOK[3], BOOK[0], BOOK[1], BOOK[2], BOOK[4]];
    const colors = donutSliceColorByGroup(splitAllocationForDonut(shuffled));
    const straight = donutSliceColorByGroup(splitAllocationForDonut(BOOK));
    expect(colors.get("Sector AAA")).toBe(straight.get("Sector AAA"));
    expect(colors.get("Sector AAA")).toBeTruthy();
    expect(colors.has("Sector YYY")).toBe(false);
    expect(colors.has("Sector ZZZ")).toBe(false);
  });
});

describe("AnalysisView donut wiring (source pin)", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "app/dashboard/components/AnalysisView.tsx"),
    "utf8",
  );

  it("the Pie draws the long-only data, never the raw allocation", () => {
    const pie = src.slice(anchorIndex(src, "<Pie\n"), anchorIndex(src, "</Pie>"));
    expect(pie).toContain("data={chartData}");
    expect(src).toMatch(/const chartData = donutChartData\(donutBook\)/);
    expect(src).not.toMatch(/bucketAllocation\(allocation\)/);
  });

  it("the caption renders only with shorts, and every figure goes through <Money>", () => {
    const start = anchorIndex(src, "{donutBook.hasShorts && (");
    const caption = src.slice(start, anchorIndex(src, "</p>", start));
    expect(caption).toContain("Shorts excluded");
    expect(caption).toContain("<Money value={donutBook.shortTotal} />");
    expect(caption).toContain("<Money value={donutBook.longTotal} />");
    expect(caption).toContain("<Money value={donutBook.netTotal} />");
    expect(caption).not.toContain("formatMoney");
  });

  it("the centre figure is the long total and stays masked under privacy", () => {
    const start = anchorIndex(src, 'donutBook.hasShorts ? "Long" : "Total"');
    const centre = src.slice(start, anchorIndex(src, "</PieChart>", start));
    expect(centre).toContain('isPrivate ? "•••" : formatMoney(donutBook.longTotal)');
  });
});

// [qa:dashboard-analysis-view-diagnostics-scope-ibkr-mode-classification-dimension-sector-allocation-donut-caption-d]
// Owner ruling 2026-10-12: a slice is a bucket's LONG positions (no netting);
// the excluded figure is the WHOLE short book. Synthetic figures.
describe("donut splits long and short inside a bucket", () => {
  const split = (name: string, long: number, short: number): AllocationEntry => ({
    group_name: name,
    total_market_value: long + short,
    percentage: 0,
    net_exposure: long + short,
    exposure_pct: 0,
    position_count: 1,
    long_value: long,
    short_value: short,
  });

  it("T holds a long 1000 and a short -400; F holds only a short -100", () => {
    const book = splitAllocationForDonut([split("T", 1000, -400), split("F", 0, -100)]);
    expect(book.longTotal).toBe(1000);
    expect(book.shortTotal).toBe(-500);
    expect(book.netTotal).toBe(500);
    expect(book.hasShorts).toBe(true);
    expect(donutChartData(book).map((r) => [r.group_name, r.total_market_value])).toEqual([
      ["T", 1000],
    ]);
    expect(donutSliceColorByGroup(book).has("F")).toBe(false);
  });

  it("the caption says the table nets and the chart does not", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "app/dashboard/components/AnalysisView.tsx"),
      "utf8",
    );
    expect(src).toContain("The Breakdown table nets longs and shorts");
  });
});

// Reviewer probe on PR #123: the roll-up into "Other" must rank by LONG value,
// not by the query's net order, or a hedged bucket with the largest gross long
// is folded away and loses its colour and drill-down. Synthetic figures.
describe("donut roll-up ranks by long value", () => {
  const split = (name: string, long: number, short: number): AllocationEntry => ({
    group_name: name,
    total_market_value: long + short,
    percentage: 0,
    net_exposure: long + short,
    exposure_pct: 0,
    position_count: 1,
    long_value: long,
    short_value: short,
  });

  it("a hedged bucket with the biggest long keeps its own slice and colour", () => {
    // Net-descending input (the query's order): the hedge nets to 50, so last.
    const rows: AllocationEntry[] = [];
    for (let i = 0; i < 8; i++) rows.push(split(`Plain ${i}`, 800 - i * 10, 0));
    rows.push(split("Hedged", 9000, -8950));
    const book = splitAllocationForDonut(rows);
    expect(book.longRows[0].group_name).toBe("Hedged");
    const slices = donutChartData(book);
    expect(slices).toHaveLength(8);
    expect(slices[0].group_name).toBe("Hedged");
    expect(slices[7].group_name).toBe("Other (2)");
    const colors = donutSliceColorByGroup(book);
    expect(colors.get("Hedged")).not.toBe(colors.get("Plain 7"));
    expect(colors.get("Plain 7")).toBe(colors.get("Plain 6"));
    expect(slices.reduce((s, r) => s + r.total_market_value, 0)).toBe(book.longTotal);
  });

  it("the empty state names the missing long positions, not net-short rows", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "app/dashboard/components/AnalysisView.tsx"),
      "utf8",
    );
    expect(src).toContain("No long exposure to chart: this scope has no long positions.");
    expect(src).not.toContain("is net short.");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anchorIndex } from "@/tests/helpers/source-anchor";

/**
 * The status strips under SecurityChart take the shared chip tones. On a
 * security page the chart sits inside the always-dark module, where the
 * light theme's darkened ink measured 2.1:1 in a browser (2026-10-09). The
 * strips opt in to a dark-module override; this pins both halves.
 */
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (top: number[], alpha: number, base: number[]) =>
  top.map((c, i) => c * alpha + base[i] * (1 - alpha));
const mix = (a: number[], share: number, b: number[]) => a.map((c, i) => c * share + b[i] * (1 - share));

describe("chart status strips inside the always-dark module", () => {
  const chart = readFileSync("app/dashboard/components/SecurityChart.tsx", "utf8");
  const css = readFileSync("app/globals.css", "utf8");

  it("every strip opts in", () => {
    const start = anchorIndex(chart, "{/* Status bar */}");
    const strips = chart.slice(start, start + 1200);
    expect(strips.match(/chart-status-gold/g)?.length).toBe(3);
    expect(strips.match(/chart-status-down/g)?.length).toBe(1);
  });

  it("the override exists and reaches 4.5:1 on the module's surface, on a light page", () => {
    anchorIndex(css, ".dark-module-chart .chart-status-gold {");
    anchorIndex(css, ".dark-module-chart .chart-status-down {");
    const surface = hex("#0a0a0a");
    // Light-theme tint colours (the page is light; only the text is overridden).
    const goldBg = over(hex("#b8860b"), 0.2, surface);
    const downBg = over(hex("#c8311c"), 0.2, surface);
    expect(ratio(hex("#ffb84d"), goldBg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(mix(hex("#ef4444"), 0.8, [255, 255, 255]), downBg)).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * QA (light-theme--buy-sell-dividend-chips-and-active-range-pill-below-
 * contrast-floor, range-pill half): the selected range pill on the account
 * equity curve (11px text) measured 4.32:1 on the light theme and its state
 * was colour-only. The ratio is computed from the light tokens in
 * globals.css and the class in EquityCurveChart.tsx, the same way
 * transaction-history-chip-contrast.test.ts does for the chips.
 *
 * Also pins the B05 wiring: the value axis frames the plotted window and the
 * resolution badge is derived from the window (QA accounts-equity-curve--
 * zero-anchored-y-axis-flattens-short-ranges, --daily-badge-on-month-end-
 * only-history).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

type Rgb = [number, number, number];

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const src = readFileSync(
  join(process.cwd(), "app/dashboard/components/EquityCurveChart.tsx"),
  "utf8",
);
const chart = src.slice(anchorIndex(src, "export function EquityCurveChart"));

const lightCss = css.slice(
  anchorIndex(css, ":root {"),
  anchorIndex(css, '[data-theme="dark"] {'),
);

function lightToken(name: string): Rgb {
  const m = lightCss.match(new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})\\b`));
  if (!m) throw new Error(`light token --${name} not found as a 6-digit hex`);
  const h = m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const mix = (a: Rgb, b: Rgb, shareOfA: number): Rgb =>
  a.map((v, i) => v * shareOfA + b[i] * (1 - shareOfA)) as Rgb;

const BLACK: Rgb = [0, 0, 0];

function activePillClasses(): string {
  const start = anchorIndex(src, "const ACTIVE_PILL =");
  const m = src.slice(start).match(/"([^"]+)"/);
  if (!m) throw new Error("no class string after const ACTIVE_PILL");
  return m[1];
}

describe("equity curve selected range pill, light theme", () => {
  // The chart card is bg-panel, so the tint composites over the panel token.
  const panel = lightToken("panel");

  it("the card the pill sits on is the panel surface", () => {
    expect(chart).toContain('<div className="rounded-xl border border-edge bg-panel p-5">');
  });

  it("the old plain-token pill really was below the floor (the measurement is sound)", () => {
    const old = contrast(lightToken("gold-ink"), mix(lightToken("gold"), panel, 0.2));
    expect(old).toBeLessThan(4.5);
    expect(old).toBeGreaterThan(4.2);
  });

  it("the selected pill text reaches 4.5:1 on its tint", () => {
    const cls = activePillClasses();
    const bg = cls.match(/\bbg-([a-z]+)\/(\d+)\b/);
    if (!bg) throw new Error("no tinted background");
    const background = mix(lightToken(bg[1]), panel, Number(bg[2]) / 100);
    const mixed = cls.match(/text-\[color:color-mix\(in_srgb,var\(--([a-z-]+)\)_(\d+)%,black\)\]/);
    if (!mixed) throw new Error("no light-theme text colour found");
    const text = mix(lightToken(mixed[1]), BLACK, Number(mixed[2]) / 100);
    expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
  });

  it("the dark theme keeps the plain token", () => {
    expect(activePillClasses().split(/\s+/)).toContain("[[data-theme=dark]_&]:text-gold-ink");
  });

  it("no selected state in the chart still uses the unchecked class pair", () => {
    expect(chart).not.toContain('"bg-gold/20 text-gold-ink"');
    expect(chart.match(/\? ACTIVE_PILL/g)?.length).toBe(2);
  });

  it("the selected state is exposed to assistive tech, not colour-only", () => {
    const pills = chart.slice(anchorIndex(chart, "{DATE_RANGES.map((range, i) => ("));
    const button = pills.slice(0, pills.indexOf("</button>"));
    expect(button).toContain("aria-pressed={i === selectedRange}");
    const split = chart.slice(anchorIndex(chart, "onClick={() => setShowLines((v) => !v)}"));
    expect(split.slice(0, split.indexOf("</button>"))).toContain("aria-pressed={showLines}");
  });
});

describe("equity curve axis and badge wiring", () => {
  it("every value axis of the account chart takes the framed domain and its ticks", () => {
    expect(chart).toContain("equityCurveYAxis(");
    const axes = chart.match(/<YAxis[\s\S]*?\/>/g) ?? [];
    expect(axes.length).toBe(2);
    for (const axis of axes) {
      expect(axis).toContain("domain={yAxis?.domain}");
      expect(axis).toContain("ticks={yAxis?.ticks}");
    }
  });

  it("the framed axis is computed from the filtered window, not the full history", () => {
    const at = anchorIndex(chart, "const yAxis = equityCurveYAxis(");
    const call = chart.slice(at, chart.indexOf(";", at));
    expect(call).toContain("data.");
    expect(call).not.toContain("rawData");
  });

  it("the badge reads the window's own resolution", () => {
    expect(chart).toContain("const granularity = equityCurveGranularity(data.map((d) => d.date));");
    expect(chart).not.toMatch(/\{hasDaily && \(\s*<span[^>]*>\s*Daily\s*<\/span>/);
    expect(chart).toContain("GRANULARITY_LABEL[granularity]");
    for (const label of ['daily: "Daily"', 'monthly: "Monthly"', 'mixed: "Mixed"']) {
      expect(src).toContain(label);
    }
  });
});

/**
 * Factor Heatmap tags (Analysis · Diagnostics): 10px text in a factor hue on
 * a 12.5% tint of itself, on a THEMED panel. A browser pass on 2026-10-09
 * measured the bright hues at 1.6 to 2.5:1 in the light theme and the slate
 * "No" / "Blend" under 4.5:1 in both. The heatmap now takes its text colour
 * from factorTagTextColor; the colour map itself is unchanged, because the
 * always-dark Factor Profile card uses it as a solid fill and passes there.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LEVEL_COLORS } from "@/lib/factors";
import { BLEND_COLOR } from "@/app/dashboard/components/FactorHeatmap";
import {
  FACTOR_TAG_MIN_CONTRAST,
  FACTOR_TAG_SURFACES,
  FACTOR_TAG_TINT_ALPHA,
  factorTagContrast,
  factorTagTextColor,
  type FactorTagTheme,
} from "@/lib/factor-tag-text";
import { token, SURFACES, THEMES } from "@/tests/helpers/tint-pair-scan";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const HUES: Record<string, string> = { ...LEVEL_COLORS, Blend: BLEND_COLOR };
const two = (n: number) => Number(n.toFixed(2));

describe("factorTagTextColor", () => {
  it("measures against the real theme surfaces and the real tint strength", () => {
    for (const theme of THEMES) {
      const fromCss = SURFACES.map(
        (s) => `#${token(theme, s).map((v) => v.toString(16).padStart(2, "0")).join("")}`,
      );
      expect(FACTOR_TAG_SURFACES[theme], theme).toEqual(fromCss);
    }
    // The tag background is written as `${color}20`: hex alpha 0x20.
    expect(FACTOR_TAG_TINT_ALPHA).toBeCloseTo(32 / 255, 10);
    expect(FACTOR_TAG_MIN_CONTRAST).toBe(4.5);
  });

  const CASES = Object.entries(HUES).flatMap(([level, hue]) =>
    THEMES.map((theme) => [level, hue, theme] as const),
  );
  it.each(CASES)("%s (%s) reaches 4.5:1 on its own tint, %s theme", (_level, hue, theme) => {
    const text = factorTagTextColor(hue, theme);
    expect(text).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(factorTagContrast(hue, text, theme)).toBeGreaterThanOrEqual(4.5);
  });

  it("the raw hues really were under the floor (the bound is real)", () => {
    const raw = (level: string, theme: FactorTagTheme) =>
      two(factorTagContrast(HUES[level], HUES[level], theme));
    expect({
      Moderate: raw("Moderate", "light"),
      Low: raw("Low", "light"),
      High: raw("High", "light"),
      Value: raw("Value", "light"),
      Growth: raw("Growth", "light"),
      International: raw("International", "light"),
      "Very High": raw("Very High", "light"),
      "No light": raw("No", "light"),
      "No dark": raw("No", "dark"),
      "Blend light": raw("Blend", "light"),
      "Blend dark": raw("Blend", "dark"),
    }).toEqual({
      Moderate: 1.42,
      Low: 1.6,
      High: 1.86,
      Value: 1.94,
      Growth: 2.07,
      International: 2.21,
      "Very High": 2.22,
      "No light": 3.69,
      "No dark": 3.53,
      "Blend light": 3.69,
      "Blend dark": 3.53,
    });
  });

  it("pins the derived colour and its ratio for every hue in both themes", () => {
    const table = Object.fromEntries(
      Object.entries(HUES).map(([level, hue]) => [
        level,
        THEMES.map((theme) => {
          const text = factorTagTextColor(hue, theme);
          return `${text} ${two(factorTagContrast(hue, text, theme)).toFixed(2)}`;
        }),
      ]),
    );
    expect(table).toEqual({
      No: ["#556376 4.74", "#7b899c 4.72"],
      Low: ["#1d7454 4.75", "#34D399 7.93"],
      Moderate: ["#7e6012 5.00", "#FBBF24 8.89"],
      High: ["#975824 4.61", "#FB923C 6.88"],
      "Very High": ["#a14949 4.72", "#F87171 5.79"],
      Growth: ["#3a6396 5.02", "#60A5FA 6.19"],
      Value: ["#79622f 4.80", "#C9A44E 6.60"],
      Yes: ["#a14949 4.72", "#F87171 5.79"],
      International: ["#6d5aa3 4.68", "#A78BFA 5.83"],
      Unknown: ["#334155 7.56", "#7a8491 4.73"],
      Blend: ["#556376 4.74", "#7b899c 4.72"],
    });
  });

  it("a hue that already passes is returned unchanged, so the dark theme looks as before", () => {
    for (const level of ["Low", "Moderate", "High", "Very High", "Growth", "Value", "International"]) {
      expect(factorTagTextColor(HUES[level], "dark"), level).toBe(HUES[level]);
    }
  });

  it("moves toward black in the light theme and toward white in the dark one", () => {
    const sum = (h: string) => [1, 3, 5].reduce((n, i) => n + parseInt(h.slice(i, i + 2), 16), 0);
    expect(sum(factorTagTextColor(HUES.Low, "light"))).toBeLessThan(sum(HUES.Low));
    expect(sum(factorTagTextColor(HUES.No, "dark"))).toBeGreaterThan(sum(HUES.No));
  });

  it("is deterministic, and leaves a value it cannot read alone", () => {
    expect(factorTagTextColor("#34D399", "light")).toBe(factorTagTextColor("#34D399", "light"));
    expect(factorTagTextColor("var(--gold)", "light")).toBe("var(--gold)");
  });
});

describe("FactorHeatmap takes the derived text colour", () => {
  const src = readFileSync("app/dashboard/components/FactorHeatmap.tsx", "utf8");
  const start = anchorIndex(src, "{value ? (");
  const tag = src.slice(start, anchorIndex(src, "{value}", start));

  it("sets one text colour per theme from the helper", () => {
    expect(tag).toContain('"--factor-tag-ink-light": factorTagTextColor(color, "light")');
    expect(tag).toContain('"--factor-tag-ink-dark": factorTagTextColor(color, "dark")');
    expect(tag).toContain("text-[color:var(--factor-tag-ink-light)]");
    expect(tag).toContain("[[data-theme=dark]_&]:text-[color:var(--factor-tag-ink-dark)]");
  });

  it("no longer paints the raw hue as the text; tint, border and size are as before", () => {
    expect(tag).not.toMatch(/(^|[^-\w])color:\s*color\b/);
    expect(tag).toContain("backgroundColor: `${color}20`");
    expect(tag).toContain("border: `1px solid ${color}40`");
    expect(tag).toContain("inline-block px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight");
  });

  it("the colour map is untouched (the dark Factor Profile card fills with it)", () => {
    expect(LEVEL_COLORS).toMatchObject({
      No: "#64748B",
      Low: "#34D399",
      Moderate: "#FBBF24",
      High: "#FB923C",
      "Very High": "#F87171",
      Growth: "#60A5FA",
      Value: "#C9A44E",
      International: "#A78BFA",
    });
  });
});

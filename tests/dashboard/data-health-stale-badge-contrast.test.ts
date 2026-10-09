/**
 * The days-stale badge in the Price Freshness table reaches 4.5:1 in both
 * themes.
 *
 * Browser finding: the badge ("8d") measured 4.23:1 in the light theme. Its
 * text is 12px, the small-text tier. The green, gold and red bands now take
 * the checked pairs from the shared Chip (ratios pinned in
 * chip-contrast-nowrap.test.tsx); the orange band has no Chip tone, so its
 * ratio is computed here the same way, from the classes in the source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

type Rgb = [number, number, number];
type Theme = "light" | "dark";

const src = readFileSync("app/dashboard/components/DataHealthView.tsx", "utf8");
const badge = sliceBetween(src, "function StaleBadge(", "function SummaryCard(");

const css = readFileSync("app/globals.css", "utf8");
const lightStart = anchorIndex(css, ":root {");
const darkStart = anchorIndex(css, '[data-theme="dark"] {');
const BLOCKS: Record<Theme, string> = {
  light: css.slice(lightStart, darkStart),
  dark: css.slice(darkStart, anchorIndex(css, "\n}", darkStart)),
};

const hex = (h: string): Rgb => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;

function token(theme: Theme, name: string): Rgb {
  const m = BLOCKS[theme].match(new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})\\b`));
  if (!m) throw new Error(`${theme} token --${name} not found`);
  return hex(m[1]);
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

describe("StaleBadge: checked colour pairs", () => {
  it("green, gold and red come from the shared Chip tones", () => {
    expect(src).toMatch(/import\s*\{[^}]*\bCHIP_TONE_CLASSES\b[^}]*\}\s*from\s*"\.\/Chip"/);
    expect(badge).toContain("CHIP_TONE_CLASSES.up");
    expect(badge).toContain("CHIP_TONE_CLASSES.gold");
    expect(badge).toContain("CHIP_TONE_CLASSES.down");
  });

  it("has no hand-written green, gold or red pair left", () => {
    expect(badge).not.toMatch(/bg-(up|down|gold)\/\d+/);
    expect(badge).not.toMatch(/\btext-(up|down|gold-ink)\b/);
  });

  it("the measurement is sound: the old gold pair was under the floor on a hovered row", () => {
    const old = contrast(token("light", "gold-ink"), mix(token("light", "gold"), token("light", "raised"), 0.15));
    expect(old).toBeLessThan(4.5);
  });

  it("the orange band (15 to 45 days) reaches 4.5:1 on panel and raised, both themes", () => {
    const m = badge.match(
      /bg-\[#([0-9a-f]{6})\]\/(\d+) text-\[color:color-mix\(in_srgb,#([0-9a-f]{6})_(\d+)%,black\)\] \[\[data-theme=dark\]_&\]:text-\[#([0-9a-f]{6})\]/,
    );
    if (!m) throw new Error("orange band classes not found in StaleBadge");
    const [, tintHex, tintPct, lightHex, lightPct, darkHex] = m;
    for (const surface of ["panel", "raised"]) {
      const lightBg = mix(hex(tintHex), token("light", surface), Number(tintPct) / 100);
      const lightText = mix(hex(lightHex), [0, 0, 0], Number(lightPct) / 100);
      expect(contrast(lightText, lightBg), `light ${surface}`).toBeGreaterThanOrEqual(4.5);
      const darkBg = mix(hex(tintHex), token("dark", surface), Number(tintPct) / 100);
      expect(contrast(hex(darkHex), darkBg), `dark ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

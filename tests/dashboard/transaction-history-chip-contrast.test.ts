/**
 * QA (light-theme--buy-sell-dividend-chips-and-active-range-pill-below-
 * contrast-floor): in the light theme the Buy / Sell / Dividend chips (10 to
 * 12px text) measured 3.8:1 to 4.2:1 against their own tint; small text
 * needs 4.5:1. This computes the ratio from the light tokens in globals.css
 * and the classes in TransactionHistory.tsx, so a token or class change
 * that drops a chip below the floor fails here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

type Rgb = [number, number, number];

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const src = readFileSync(
  join(process.cwd(), "app/dashboard/components/TransactionHistory.tsx"),
  "utf8",
);

// The light block is :root, which ends where the dark block starts.
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

/** The class string assigned to `const <NAME> =` in the component. */
function chipClasses(name: string): string {
  const start = anchorIndex(src, `const ${name} =`);
  const m = src.slice(start).match(/"([^"]+)"/);
  if (!m) throw new Error(`no class string after const ${name}`);
  return m[1];
}

/** Light-theme text contrast of a chip against its tint on the page canvas. */
function lightChipContrast(name: string): number {
  const cls = chipClasses(name);
  const bg = cls.match(/\bbg-([a-z]+)\/(\d+)\b/);
  if (!bg) throw new Error(`${name}: no tinted background`);
  const background = mix(lightToken(bg[1]), lightToken("canvas"), Number(bg[2]) / 100);

  const mixed = cls.match(/text-\[color:color-mix\(in_srgb,var\(--([a-z-]+)\)_(\d+)%,black\)\]/);
  const plain = cls.match(/(?:^|\s)text-([a-z-]+)(?:\s|$)/);
  const text = mixed
    ? mix(lightToken(mixed[1]), BLACK, Number(mixed[2]) / 100)
    : plain
      ? lightToken(plain[1])
      : null;
  if (!text) throw new Error(`${name}: no light-theme text colour found`);
  return contrast(text, background);
}

describe("transaction type chips, light theme", () => {
  it("the old plain-token chips really were below the floor (the measurement is sound)", () => {
    const canvas = lightToken("canvas");
    const old = (text: string, tint: string) =>
      contrast(lightToken(text), mix(lightToken(tint), canvas, 0.2));
    expect(old("up", "up")).toBeLessThan(4.5);
    expect(old("down", "down")).toBeLessThan(4.5);
    expect(old("gold-ink", "gold")).toBeLessThan(4.5);
  });

  it.each(["UP_CHIP", "DOWN_CHIP", "GOLD_CHIP", "BLUE_CHIP"])(
    "%s text reaches 4.5:1 on its tint",
    (name) => {
      expect(lightChipContrast(name)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each([
    ["UP_CHIP", "text-up"],
    ["DOWN_CHIP", "text-down"],
    ["GOLD_CHIP", "text-gold-ink"],
  ])("%s keeps the plain token in the dark theme", (name, token) => {
    expect(chipClasses(name).split(/\s+/)).toContain(`[[data-theme=dark]_&]:${token}`);
  });

  it("every coloured type uses one of the checked chip constants", () => {
    const start = anchorIndex(src, "const TYPE_STYLES");
    const map = src.slice(start, anchorIndex(src, "};", start));
    const values = [...map.matchAll(/^\s+[A-Z_]+:\s*(.+),$/gm)].map((m) => m[1]);
    expect(values.length).toBeGreaterThanOrEqual(11);
    for (const v of values) {
      expect(["UP_CHIP", "DOWN_CHIP", "GOLD_CHIP", "BLUE_CHIP"]).toContain(v);
    }
  });
});

/**
 * The shared <Chip> (app/dashboard/components/Chip.tsx).
 *
 * 1. A chip never wraps inside its pill. QA
 *    (dashboard-alerts-emails-tab-390x844-new-entry-replaced-chip-wraps...):
 *    at 390px the two-word "entry replaced" chip stacked on two lines and
 *    painted as a blob. The rule lives in the Chip base, so every chip gets
 *    it and no caller needs its own.
 * 2. Chip text is 11 to 12px, so each tone needs 4.5:1 against its own tint
 *    in BOTH themes. The ratio is computed here from the tokens in
 *    globals.css and the classes in Chip.tsx, over every surface a chip sits
 *    on (page canvas, panel, raised), so a token or class change that drops
 *    a tone below the floor fails.
 * 3. The reconciliation difference chip uses the same checked tone classes
 *    (its red measured just under the floor in both themes).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Chip, CHIP_TONE_CLASSES, type ChipTone } from "@/app/dashboard/components/Chip";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

type Rgb = [number, number, number];
type Theme = "light" | "dark";

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const lightStart = anchorIndex(css, ":root {");
const darkStart = anchorIndex(css, '[data-theme="dark"] {');
const BLOCKS: Record<Theme, string> = {
  light: css.slice(lightStart, darkStart),
  dark: css.slice(darkStart, anchorIndex(css, "\n}", darkStart)),
};

function token(theme: Theme, name: string): Rgb {
  const m = BLOCKS[theme].match(new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})\\b`));
  if (!m) throw new Error(`${theme} token --${name} not found as a 6-digit hex`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as Rgb;
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

const NAMED: Record<string, Rgb> = { black: [0, 0, 0], white: [255, 255, 255] };

/** One text utility ("text-up", or the color-mix arbitrary value) as a colour. */
function textColour(theme: Theme, utility: string): Rgb {
  const mixed = utility.match(
    /^text-\[color:color-mix\(in_srgb,var\(--([a-z-]+)\)_(\d+)%,(black|white)\)\]$/,
  );
  if (mixed) return mix(token(theme, mixed[1]), NAMED[mixed[3]], Number(mixed[2]) / 100);
  const plain = utility.match(/^text-([a-z-]+)$/);
  if (plain) return token(theme, plain[1]);
  throw new Error(`unreadable text utility: ${utility}`);
}

const DARK_PREFIX = "[[data-theme=dark]_&]:";

/** The text colour and the background a tone paints in one theme, on one surface. */
function chipColours(theme: Theme, tone: ChipTone, surface: string): { text: Rgb; bg: Rgb } {
  const classes = CHIP_TONE_CLASSES[tone].split(/\s+/);
  const base = classes.find((c) => c.startsWith("text-"));
  const dark = classes.find((c) => c.startsWith(`${DARK_PREFIX}text-`));
  if (!base) throw new Error(`${tone}: no text utility`);
  const utility = theme === "dark" && dark ? dark.slice(DARK_PREFIX.length) : base;

  const bgClass = classes.find((c) => c.startsWith("bg-"));
  if (!bgClass) throw new Error(`${tone}: no background utility`);
  const tint = bgClass.match(/^bg-([a-z-]+)\/(\d+)$/);
  const solid = bgClass.match(/^bg-([a-z-]+)$/);
  const bg = tint
    ? mix(token(theme, tint[1]), token(theme, surface), Number(tint[2]) / 100)
    : solid
      ? token(theme, solid[1])
      : null;
  if (!bg) throw new Error(`${tone}: unreadable background ${bgClass}`);
  return { text: textColour(theme, utility), bg };
}

const TONES = Object.keys(CHIP_TONE_CLASSES) as ChipTone[];
const SURFACES = ["canvas", "panel", "raised"];
const CASES = (["light", "dark"] as Theme[]).flatMap((theme) =>
  TONES.flatMap((tone) => SURFACES.map((surface) => [theme, tone, surface] as const)),
);

describe("Chip: one line, always", () => {
  it("every tone and size renders with whitespace-nowrap", () => {
    for (const tone of TONES) {
      for (const size of ["xs", "sm"] as const) {
        const html = renderToStaticMarkup(
          <Chip tone={tone} size={size}>
            entry replaced
          </Chip>,
        );
        const cls = html.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
        expect(cls, `${tone}/${size}`).toContain("whitespace-nowrap");
      }
    }
  });

  it("a caller's own classes are added, not swapped for the base", () => {
    const html = renderToStaticMarkup(<Chip className="ml-2">x</Chip>);
    const cls = html.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? [];
    expect(cls).toContain("ml-2");
    expect(cls).toContain("whitespace-nowrap");
    expect(cls).toContain("rounded-full");
  });
});

describe("Chip: small text reaches 4.5:1 on its own tint, both themes", () => {
  it("the measurement is sound: the old plain tokens were under the floor", () => {
    const old = (theme: Theme, text: string, tint: string, surface: string) =>
      contrast(token(theme, text), mix(token(theme, tint), token(theme, surface), 0.2));
    // Light: green, red and gold failed on every surface.
    for (const surface of SURFACES) {
      expect(old("light", "up", "up", surface)).toBeLessThan(4.5);
      expect(old("light", "down", "down", surface)).toBeLessThan(4.5);
      expect(old("light", "gold-ink", "gold", surface)).toBeLessThan(4.5);
      // Dark: red failed on every surface.
      expect(old("dark", "down", "down", surface)).toBeLessThan(4.5);
    }
  });

  it.each(CASES)("%s theme, %s chip on %s", (theme, tone, surface) => {
    const { text, bg } = chipColours(theme, tone, surface);
    expect(contrast(text, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("the tones that already passed keep their plain token (no needless colour change)", () => {
    expect(CHIP_TONE_CLASSES.info).toBe("bg-blue/20 text-blue");
    expect(CHIP_TONE_CLASSES.neutral).toBe("bg-raised text-ink-dim");
    expect(CHIP_TONE_CLASSES.warn).toBe("bg-warn/20 text-warn");
    // Green and gold passed in the dark theme: plain token there.
    expect(CHIP_TONE_CLASSES.up.split(/\s+/)).toContain(`${DARK_PREFIX}text-up`);
    expect(CHIP_TONE_CLASSES.gold.split(/\s+/)).toContain(`${DARK_PREFIX}text-gold-ink`);
  });
});

describe("Reconciliation difference chip", () => {
  const src = readFileSync(
    join(process.cwd(), "app/dashboard/components/ReconciliationTable.tsx"),
    "utf8",
  );
  const chip = sliceBetween(src, "title={band.label}", "<span aria-hidden=\"true\">{band.glyph}</span>");

  it("takes its green, gold and red from the checked Chip tones", () => {
    expect(src).toMatch(/import\s*\{[^}]*\bCHIP_TONE_CLASSES\b[^}]*\}\s*from\s*"\.\/Chip"/);
    expect(chip).toContain("CHIP_TONE_CLASSES.up");
    expect(chip).toContain("CHIP_TONE_CLASSES.gold");
    expect(chip).toContain("CHIP_TONE_CLASSES.down");
  });

  it("has no hand-written tint pair left", () => {
    expect(chip).not.toMatch(/bg-(up|down|gold)\/\d+/);
    expect(chip).not.toMatch(/"[^"]*\btext-(up|down|gold-ink)\b/);
  });

  it("stays on one line", () => {
    expect(chip).toContain("whitespace-nowrap");
  });

  it("the neutral band keeps readable text on the panel", () => {
    expect(chip).toContain("bg-panel text-ink-dim");
    for (const theme of ["light", "dark"] as Theme[]) {
      expect(contrast(token(theme, "ink-dim"), token(theme, "panel"))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

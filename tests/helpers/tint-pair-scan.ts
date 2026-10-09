/**
 * Finds hand-written "coloured text on its own tint" class pairs in a source
 * file and computes their WCAG contrast from the tokens in app/globals.css.
 *
 * Used by tests/repo/no-handrolled-failing-tint-pairs.test.ts. The maths is
 * the same as tests/dashboard/chip-contrast-nowrap.test.tsx: the tint is
 * composited over the surface it sits on (page canvas, panel, raised), then
 * the text colour is compared against the result.
 *
 * A "chunk" is the text between two string delimiters (a quote, a backtick,
 * or a template `${` / `}`), so the two arms of a conditional are separate
 * chunks and are measured separately.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "@/tests/helpers/source-anchor";

export type Rgb = [number, number, number];
export type Theme = "light" | "dark";
export const THEMES: Theme[] = ["light", "dark"];
export const SURFACES = ["canvas", "panel", "raised"] as const;

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const lightStart = anchorIndex(css, ":root {");
const darkStart = anchorIndex(css, '[data-theme="dark"] {');
const BLOCKS: Record<Theme, string> = {
  light: css.slice(lightStart, darkStart),
  dark: css.slice(darkStart, anchorIndex(css, "\n}", darkStart)),
};

export const hex = (h: string): Rgb =>
  [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;

export function tokenOrNull(theme: Theme, name: string): Rgb | null {
  const m = BLOCKS[theme].match(new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})\\b`));
  return m ? hex(m[1]) : null;
}

export function token(theme: Theme, name: string): Rgb {
  const c = tokenOrNull(theme, name);
  if (!c) throw new Error(`${theme} token --${name} not found as a 6-digit hex`);
  return c;
}

function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const mix = (a: Rgb, b: Rgb, shareOfA: number): Rgb =>
  a.map((v, i) => v * shareOfA + b[i] * (1 - shareOfA)) as Rgb;

/**
 * The few stock Tailwind palette colours the app uses beside its own tokens
 * (hex values of the default palette; the same in both themes).
 */
const PALETTE: Record<string, string> = {
  "emerald-300": "6ee7b7",
  "emerald-400": "34d399",
  "emerald-500": "10b981",
  "rose-300": "fda4af",
  "rose-400": "fb7185",
  "blue-400": "60a5fa",
  "blue-500": "3b82f6",
  "violet-400": "a78bfa",
  "violet-500": "8b5cf6",
  "amber-300": "fcd34d",
  "amber-400": "fbbf24",
  "orange-400": "fb923c",
  white: "ffffff",
  black: "000000",
};

/** Colour names that mean "a tone", as opposed to a neutral surface or ink. */
const SURFACE_NAMES = new Set([
  "canvas",
  "panel",
  "panel-sage",
  "panel-warm",
  "raised",
  "muted",
  "edge",
  "edge-strong",
  "ink",
  "ink-dim",
  "ink-faint",
  "transparent",
  "current",
  "inherit",
  "background",
  "foreground",
]);

/** A colour and how opaque it is (1 = solid). */
type Paint = { rgb: Rgb; alpha: number };

function namedColour(theme: Theme, name: string): Rgb | null {
  if (PALETTE[name]) return hex(PALETTE[name]);
  return tokenOrNull(theme, name);
}

/** The part after `bg-` or `text-`, as a paint. Null when it is not a colour. */
function paint(theme: Theme, value: string): Paint | null {
  let body = value;
  let alpha = 1;
  const slash = body.match(/^(.*)\/(\d+)$/);
  if (slash && !slash[1].includes("(")) {
    body = slash[1];
    alpha = Number(slash[2]) / 100;
  } else if (slash && slash[1].endsWith("]")) {
    body = slash[1];
    alpha = Number(slash[2]) / 100;
  }
  const hexed = body.match(/^\[#([0-9a-fA-F]{6})\]$/);
  if (hexed) return { rgb: hex(hexed[1]), alpha };
  const mixed = body.match(
    /^\[color:color-mix\(in_srgb,(?:var\(--([a-z-]+)\)|#([0-9a-fA-F]{6}))_(\d+)%,(black|white)\)\]$/,
  );
  if (mixed) {
    const base = mixed[1] ? tokenOrNull(theme, mixed[1]) : hex(mixed[2]);
    if (!base) return null;
    return { rgb: mix(base, hex(PALETTE[mixed[4]]), Number(mixed[3]) / 100), alpha };
  }
  if (!/^[a-z]+(-[a-z]+)*(-\d+)?$/.test(body)) return null;
  const rgb = namedColour(theme, body);
  return rgb ? { rgb, alpha } : null;
}

const DARK_VARIANTS = new Set(["dark", "[[data-theme=dark]_&]"]);
const LIGHT_VARIANTS = new Set(["[[data-theme=light]_&]"]);
/** Layout-only variants: the class applies in the resting state. */
const PASSIVE_VARIANT = /^(sm|md|lg|xl|2xl|max-[a-z0-9]+|electron|print|first|last|odd|even)$/;

/** Splits "a:b:[c:d]:e" on the colons that are not inside brackets. */
function splitVariants(cls: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of cls) {
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (ch === ":" && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

type Scope = "base" | "dark" | "light" | "state";

function classify(cls: string): { scope: Scope; utility: string } {
  const parts = splitVariants(cls);
  const utility = parts.pop() ?? "";
  let scope: Scope = "base";
  for (const v of parts) {
    if (DARK_VARIANTS.has(v)) scope = scope === "state" ? "state" : "dark";
    else if (LIGHT_VARIANTS.has(v)) scope = scope === "state" ? "state" : "light";
    else if (!PASSIVE_VARIANT.test(v)) scope = "state";
  }
  return { scope, utility: utility.replace(/!$/, "").replace(/^!/, "") };
}

export type TintPair = {
  /** 1-based line of the background class. */
  line: number;
  /** The background utility as written, e.g. "bg-up/20". */
  bg: string;
  /** The text utility in the resting state, light theme. */
  text: string;
  /** The text utility the dark theme uses (same as `text` when there is no override). */
  darkText: string;
  /** Lowest contrast over canvas, panel and raised, per theme. */
  light: number;
  dark: number;
  /** "bg text" key used by the allowlist. */
  key: string;
  /** Offsets of the string the pair sits in (start inclusive, end exclusive). */
  chunkStart: number;
  chunkEnd: number;
};

export type OrphanTint = { line: number; bg: string };

/** Lowest contrast of one text utility on one tint, over the three surfaces. */
export function worstRatio(theme: Theme, bgUtility: string, textUtility: string): number {
  const bg = paint(theme, bgUtility.replace(/^bg-/, ""));
  const fg = paint(theme, textUtility.replace(/^text-/, ""));
  if (!bg || !fg) throw new Error(`unreadable pair: ${bgUtility} ${textUtility}`);
  let worst = Infinity;
  for (const surface of SURFACES) {
    const under = mix(bg.rgb, token(theme, surface), bg.alpha);
    const over = mix(fg.rgb, under, fg.alpha);
    worst = Math.min(worst, contrast(over, under));
  }
  return worst;
}

function isTone(theme: Theme, utilityBody: string): boolean {
  const name = utilityBody.replace(/\/\d+$/, "");
  if (SURFACE_NAMES.has(name)) return false;
  return paint(theme, utilityBody) !== null;
}

/**
 * Every chunk that sets a tone-coloured tint (an opacity below 100%) and a
 * tone-coloured text in the resting state. `orphans` are tints with no text
 * colour in the same chunk: the text colour comes from somewhere else.
 */
export function scanTintPairs(src: string): { pairs: TintPair[]; orphans: OrphanTint[] } {
  const pairs: TintPair[] = [];
  const orphans: OrphanTint[] = [];
  const delimiter = /["'`]|\$\{|\}/g;
  let start = 0;
  const chunks: { text: string; offset: number }[] = [];
  for (let m = delimiter.exec(src); m; m = delimiter.exec(src)) {
    chunks.push({ text: src.slice(start, m.index), offset: start });
    start = m.index + m[0].length;
  }
  chunks.push({ text: src.slice(start), offset: start });

  for (const chunk of chunks) {
    if (!chunk.text.includes("bg-")) continue;
    const classes = [...chunk.text.matchAll(/\S+/g)].map((m) => ({
      ...classify(m[0]),
      index: chunk.offset + (m.index ?? 0),
    }));
    const tints = classes.filter((c) => {
      if (c.scope !== "base" || !c.utility.startsWith("bg-")) return false;
      const body = c.utility.slice(3);
      const p = paint("light", body);
      return p !== null && p.alpha < 1 && isTone("light", body);
    });
    if (tints.length === 0) continue;
    const textOf = (scope: Scope) =>
      classes.find(
        (c) =>
          c.scope === scope &&
          c.utility.startsWith("text-") &&
          paint("light", c.utility.slice(5)) !== null,
      )?.utility;
    const base = textOf("base");
    for (const tint of tints) {
      const line = src.slice(0, tint.index).split("\n").length;
      if (!base) {
        orphans.push({ line, bg: tint.utility });
        continue;
      }
      const lightText = textOf("light") ?? base;
      const darkText = textOf("dark") ?? base;
      pairs.push({
        line,
        bg: tint.utility,
        text: lightText,
        darkText,
        light: worstRatio("light", tint.utility, lightText),
        dark: worstRatio("dark", tint.utility, darkText),
        key: `${tint.utility} ${lightText}${darkText === lightText ? "" : ` dark:${darkText}`}`,
        chunkStart: chunk.offset,
        chunkEnd: chunk.offset + chunk.text.length,
      });
    }
  }
  return { pairs, orphans };
}

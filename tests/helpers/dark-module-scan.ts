/**
 * Two scans for the misses a browser pass found on 2026-10-09 that the
 * class-pair scans could not see:
 *
 * 1. An inline grey (`color: "#555"`) in a file that paints the always-dark
 *    module surface. Theme tokens do not apply there, so the grey is written
 *    as hex and nothing measured it.
 * 2. A resting-state `opacity-<n>` on an element that also sets a small text
 *    size: the fade multiplies into every label inside it.
 *
 * Same maths as tests/helpers/tint-pair-scan.ts. Used by
 * tests/repo/no-dim-grey-on-dark-module.test.ts.
 */
import {
  classify,
  contrast,
  hex,
  mix,
  paint,
  token,
  SURFACES,
  type Rgb,
  type Theme,
} from "@/tests/helpers/tint-pair-scan";
import { stripComments } from "@/tests/helpers/small-text-scan";

/** The surfaces the always-dark modules paint (chart panel, KPI strip, cards). */
export const DARK_MODULE_SURFACES = ["0a0a0a", "0b0b0b", "0d0d0d"] as const;

/** Lowest contrast of a 6-digit hex (no `#`) over the dark-module surfaces. */
export function darkModuleRatio(textHex: string): number {
  return Math.min(...DARK_MODULE_SURFACES.map((s) => contrast(hex(textHex), hex(s))));
}

function expand(h: string): string {
  return h.length === 3 ? [...h].map((c) => c + c).join("") : h;
}

/** A file that paints a dark-module surface itself, or is built from the terminal parts. */
export function isDarkModuleSource(src: string): boolean {
  return (
    /background(Color)?:\s*["'`]#0[a-d]0[a-d]0[a-d]["'`]/i.test(src) ||
    /from\s+["'][^"']*\/(TerminalSection|dark-module-text)["']/.test(src)
  );
}

export type InlineGrey = { line: number; hex: string; ratio: number };

/**
 * Every neutral grey written as a hex or rgb() literal on a line that sets an
 * inline `color` (ternaries included), with its lowest contrast on the dark
 * module. A grey is a colour whose channels are within 16 of each other.
 * `borderColor`, `background` and `accentColor` lines are not text.
 */
export function scanInlineGreys(src: string): InlineGrey[] {
  const out: InlineGrey[] = [];
  const lines = stripComments(src).split("\n");
  lines.forEach((text, i) => {
    const m = /(^|[^A-Za-z-])color:\s*(.*)$/.exec(text);
    if (!m) return;
    const found: string[] = [];
    for (const h of m[2].matchAll(/["'`]#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})["'`]/g)) {
      found.push(expand(h[1]).toLowerCase());
    }
    for (const r of m[2].matchAll(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
      found.push([r[1], r[2], r[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join(""));
    }
    for (const h of found) {
      const c = hex(h);
      if (Math.max(...c) - Math.min(...c) > 16) continue;
      out.push({ line: i + 1, hex: `#${h}`, ratio: darkModuleRatio(h) });
    }
  });
  return out;
}

const SMALL_NAMED = new Set(["text-xs", "text-sm", "text-base"]);

/** True for a text-size utility of 17px or less. */
export function isSmallTextSize(utility: string): boolean {
  if (SMALL_NAMED.has(utility)) return true;
  const px = /^text-\[(\d+(?:\.\d+)?)px\]$/.exec(utility);
  if (px) return Number(px[1]) <= 17;
  const rem = /^text-\[(\d*\.?\d+)rem\]$/.exec(utility);
  return rem ? Number(rem[1]) * 16 <= 17 : false;
}

export type FadedSmallText = {
  line: number;
  /** The opacity utility, e.g. "opacity-70". */
  opacity: string;
  /** The text-size utility it sits with. */
  size: string;
  /** The text colour measured: the one in the same class string, else ink-faint. */
  text: string;
  light: number;
  dark: number;
};

function fadedRatio(theme: Theme, textUtility: string, opacity: number): number {
  const fg = paint(theme, textUtility.replace(/^text-/, ""));
  if (!fg) throw new Error(`unreadable text utility: ${textUtility}`);
  let worst = Infinity;
  for (const surface of SURFACES) {
    const under: Rgb = token(theme, surface);
    worst = Math.min(worst, contrast(mix(fg.rgb, under, fg.alpha * opacity), under));
  }
  return worst;
}

/**
 * Class strings that set, in the resting state, both an `opacity-<n>` below
 * 100 and a small text size. The fade is measured with the text colour the
 * same string sets; when it sets none the colour is inherited and unknown, so
 * it is measured as `text-ink-faint`, the dimmest ink that passes on its own.
 */
export function scanFadedSmallText(src: string): FadedSmallText[] {
  const clean = stripComments(src);
  const out: FadedSmallText[] = [];
  const delimiter = /["'`]|\$\{|\}/g;
  let start = 0;
  const check = (text: string, offset: number) => {
    if (!text.includes("opacity-")) return;
    const words = [...text.matchAll(/\S+/g)].map((m) => ({
      ...classify(m[0]),
      index: offset + (m.index ?? 0),
    }));
    const resting = words.filter((w) => w.scope === "base");
    const fade = resting.find((w) => /^opacity-\d+$/.test(w.utility));
    if (!fade) return;
    const n = Number(fade.utility.slice("opacity-".length));
    if (n <= 0 || n >= 100) return;
    const size = resting.find((w) => isSmallTextSize(w.utility));
    if (!size) return;
    const colourOf = (scope: "base" | "light" | "dark") =>
      words.find(
        (w) =>
          w.scope === scope &&
          w.utility.startsWith("text-") &&
          !isSmallTextSize(w.utility) &&
          paint("light", w.utility.slice(5)) !== null,
      )?.utility;
    const base = colourOf("base") ?? "text-ink-faint";
    out.push({
      line: clean.slice(0, fade.index).split("\n").length,
      opacity: fade.utility,
      size: size.utility,
      text: base,
      light: fadedRatio("light", colourOf("light") ?? base, n / 100),
      dark: fadedRatio("dark", colourOf("dark") ?? base, n / 100),
    });
  };
  for (let m = delimiter.exec(clean); m; m = delimiter.exec(clean)) {
    check(clean.slice(start, m.index), start);
    start = m.index + m[0].length;
  }
  check(clean.slice(start), start);
  return out;
}

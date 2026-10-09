/**
 * Finds small-text colour classes that are written without a tint, and
 * measures them on the plain surfaces (page canvas, panel, raised).
 *
 * Companion to tests/helpers/tint-pair-scan.ts, which covers text on its own
 * tint. Same maths: the text colour, with its opacity composited over the
 * surface, against that surface. Used by
 * tests/repo/no-faded-small-status-text.test.ts.
 */
import {
  classify,
  contrast,
  mix,
  paint,
  token,
  SURFACES,
  type Theme,
} from "@/tests/helpers/tint-pair-scan";

/** Lowest contrast of one text utility over canvas, panel and raised. */
export function plainRatio(theme: Theme, textUtility: string): number {
  const fg = paint(theme, textUtility.replace(/^text-/, ""));
  if (!fg) throw new Error(`unreadable text utility: ${textUtility}`);
  let worst = Infinity;
  for (const surface of SURFACES) {
    const under = token(theme, surface);
    worst = Math.min(worst, contrast(mix(fg.rgb, under, fg.alpha), under));
  }
  return worst;
}

/**
 * Blanks comment text and keeps every newline, so line numbers still match
 * the file. Covers whole-line `//` comments, block comments and JSX comments.
 */
export function stripComments(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank);
}

export type RestingClass = { line: number; utility: string };

/** Every class-like word that applies in the resting state (no hover, focus or disabled variant). */
export function restingClasses(src: string): RestingClass[] {
  const clean = stripComments(src);
  const out: RestingClass[] = [];
  for (const m of clean.matchAll(/[^\s"'`{}$,;()<>=?]+/g)) {
    const word = m[0];
    if (!word.includes("-")) continue;
    const { scope, utility } = classify(word);
    if (scope !== "base") continue;
    out.push({ line: clean.slice(0, m.index ?? 0).split("\n").length, utility });
  }
  return out;
}

export type FadedText = { line: number; utility: string; light: number; dark: number };

/** Resting-state `text-<colour>/<opacity>` classes, measured on the plain surfaces. */
export function scanFadedText(src: string): FadedText[] {
  return restingClasses(src).flatMap((c) => {
    if (!/^text-.+\/\d+$/.test(c.utility)) return [];
    const p = paint("light", c.utility.slice(5));
    if (!p || p.alpha >= 1) return [];
    return [
      {
        line: c.line,
        utility: c.utility,
        light: plainRatio("light", c.utility),
        dark: plainRatio("dark", c.utility),
      },
    ];
  });
}

/** Lines that use one exact text utility in the resting state. */
export function linesUsing(src: string, utility: string): number[] {
  return restingClasses(src)
    .filter((c) => c.utility === utility)
    .map((c) => c.line);
}

/**
 * Lines where one class string sets both utilities in the resting state
 * (for example a solid `bg-gold` with `text-canvas`). A class string is the
 * text between two string delimiters.
 */
export function linesPairing(src: string, a: string, b: string): number[] {
  const clean = stripComments(src);
  const lines: number[] = [];
  const delimiter = /["'`]|\$\{|\}/g;
  let start = 0;
  const check = (text: string, offset: number) => {
    const words = [...text.matchAll(/\S+/g)].map((m) => ({
      ...classify(m[0]),
      index: offset + (m.index ?? 0),
    }));
    const first = words.find((w) => w.scope === "base" && w.utility === a);
    if (first && words.some((w) => w.scope === "base" && w.utility === b)) {
      lines.push(clean.slice(0, first.index).split("\n").length);
    }
  };
  for (let m = delimiter.exec(clean); m; m = delimiter.exec(clean)) {
    check(clean.slice(start, m.index), start);
    start = m.index + m[0].length;
  }
  check(clean.slice(start), start);
  return lines;
}

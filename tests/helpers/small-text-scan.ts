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
  splitVariants,
  worstRatio,
  SURFACES,
  THEMES,
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

// ─── Hover state ────────────────────────────────────────────────

const HOVER_VARIANT = /^(group-|peer-)?hover(\/[a-z0-9-]+)?$/;
const DARK_VARIANT = /^(dark|\[\[data-theme=dark\]_&\])$/;
const LIGHT_VARIANT = /^\[\[data-theme=light\]_&\]$/;
/** Variants that do not change which state a class belongs to. */
const NEUTRAL_VARIANT = /^(sm|md|lg|xl|2xl|max-[a-z0-9]+|electron|print|first|last|odd|even|enabled)$/;

type StateClass = { hover: boolean; theme: Theme | "both"; utility: string; raw: string };

/** Null for a class of another state (disabled, focus, active ...): not ours to measure. */
function stateClass(word: string): StateClass | null {
  const parts = splitVariants(word);
  const utility = (parts.pop() ?? "").replace(/!$/, "").replace(/^!/, "");
  let hover = false;
  let theme: Theme | "both" = "both";
  for (const v of parts) {
    if (HOVER_VARIANT.test(v)) hover = true;
    else if (DARK_VARIANT.test(v)) theme = "dark";
    else if (LIGHT_VARIANT.test(v)) theme = "light";
    else if (!NEUTRAL_VARIANT.test(v)) return null;
  }
  return { hover, theme, utility, raw: word };
}

export type HoverChange = {
  line: number;
  /** The hover classes that change the colour, as written, joined by a space. */
  hover: string;
  /** Contrast before and while hovered, per theme (lowest of canvas, panel, raised). */
  resting: Record<Theme, number | null>;
  hovered: Record<Theme, number>;
};

/**
 * Every class string whose hover state changes the text colour or the fill
 * behind it, with the contrast before and while hovered.
 *
 * A class string is the text between two string delimiters, as in
 * `linesPairing`. The text colour while hovered is the hover text colour, or
 * the resting one when the hover only changes the fill; the same for the
 * fill. A string with no text colour of its own is skipped (its text is
 * coloured somewhere else and cannot be read from here).
 */
export function scanHoverChanges(src: string): HoverChange[] {
  const clean = stripComments(src);
  const out: HoverChange[] = [];
  const delimiter = /["'`]|\$\{|\}/g;
  let start = 0;
  const colour = (prefix: "text-" | "bg-", c: StateClass) =>
    c.utility.startsWith(prefix) && paint("light", c.utility.slice(prefix.length)) !== null;
  const check = (text: string, offset: number) => {
    if (!/hover[:/]/.test(text)) return;
    const classes = [...text.matchAll(/\S+/g)].flatMap((m) => {
      const c = stateClass(m[0]);
      return c ? [{ ...c, index: offset + (m.index ?? 0) }] : [];
    });
    const changes = classes.filter((c) => c.hover && (colour("text-", c) || colour("bg-", c)));
    if (changes.length === 0) return;
    const pick = (prefix: "text-" | "bg-", hover: boolean, theme: Theme) => {
      const pool = classes.filter((c) => c.hover === hover && colour(prefix, c));
      return (pool.find((c) => c.theme === theme) ?? pool.find((c) => c.theme === "both"))?.utility;
    };
    const ratio = (text: string, bg: string | undefined, theme: Theme) =>
      bg ? worstRatio(theme, bg, text) : plainRatio(theme, text);
    const resting = {} as Record<Theme, number | null>;
    const hovered = {} as Record<Theme, number>;
    for (const theme of THEMES) {
      const restText = pick("text-", false, theme);
      const restBg = pick("bg-", false, theme);
      const hoverText = pick("text-", true, theme) ?? restText;
      const hoverBg = pick("bg-", true, theme) ?? restBg;
      if (!hoverText) return;
      resting[theme] = restText ? ratio(restText, restBg, theme) : null;
      hovered[theme] = ratio(hoverText, hoverBg, theme);
    }
    out.push({
      line: clean.slice(0, changes[0].index).split("\n").length,
      hover: changes.map((c) => c.raw).join(" "),
      resting,
      hovered,
    });
  };
  for (let m = delimiter.exec(clean); m; m = delimiter.exec(clean)) {
    check(clean.slice(start, m.index), start);
    start = m.index + m[0].length;
  }
  check(clean.slice(start), start);
  return out;
}

/**
 * The changes that leave hovered text under `floor` in a theme where the
 * hover also lowered the contrast (or where there is no resting colour to
 * compare with). A hover must not make text harder to read.
 */
export function hoverFailures(src: string, floor: number): HoverChange[] {
  return scanHoverChanges(src).filter((c) =>
    THEMES.some((t) => {
      const before = c.resting[t];
      return c.hovered[t] < floor && (before === null || c.hovered[t] < before - 1e-9);
    }),
  );
}

/** Hover-state `text-<colour>/<opacity>` classes: text that fades while hovered. */
export function fadedHoverText(src: string): { line: number; hover: string }[] {
  return scanHoverChanges(src).flatMap((c) => {
    const faded = c.hover.split(" ").filter((word) => {
      const utility = stateClass(word)?.utility ?? "";
      if (!/^text-.+\/\d+$/.test(utility)) return false;
      const p = paint("light", utility.slice(5));
      return p !== null && p.alpha < 1;
    });
    return faded.length > 0 ? [{ line: c.line, hover: faded.join(" ") }] : [];
  });
}

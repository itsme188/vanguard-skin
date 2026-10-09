/**
 * Readable text colour for a factor tag on a THEMED surface (the Factor
 * Heatmap on Analysis · Diagnostics).
 *
 * A tag there is a hue from LEVEL_COLORS (lib/factors.ts) as 10px text on a
 * 12.5% tint of itself (the `20` hex alpha), over the page's panel. Those
 * hues are bright 400-level colours picked for the always-dark Factor
 * Profile card, where they pass. On a light panel they measured 1.6 to
 * 2.5:1, and the slate "No" / "Blend" measured under 4.5:1 in both themes.
 *
 * So the map stays as it is (the dark card and every swatch still use it),
 * and the heatmap asks this helper for the TEXT colour: the same hue mixed
 * toward black (light theme) or white (dark theme) in 5% steps until it
 * reaches 4.5:1 on its own tint over every themed surface. A hue that
 * already passes is returned unchanged.
 *
 * Pure and deterministic. tests/dashboard/factor-tag-text.test.ts runs it
 * over every colour in the map in both themes, pins the results, and checks
 * the surface values below against app/globals.css.
 */
export type FactorTagTheme = "light" | "dark";

/** Opacity of the tag's own tint: the two-digit hex alpha `20`. */
export const FACTOR_TAG_TINT_ALPHA = 0x20 / 255;

/** Small-text contrast floor. */
export const FACTOR_TAG_MIN_CONTRAST = 4.5;

/** canvas, panel, raised per theme (mirrors app/globals.css; pinned by the test). */
export const FACTOR_TAG_SURFACES: Record<FactorTagTheme, readonly string[]> = {
  light: ["#fafaf3", "#ffffff", "#f4f3ea"],
  dark: ["#0a0a0a", "#0d0d0d", "#111111"],
};

type Rgb = [number, number, number];

function parseHex(value: string): Rgb | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!m) return null;
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as Rgb;
}

function toHex(c: Rgb): string {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
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

/** Lowest contrast of `text` on the tag's tint of `hue`, over the theme's surfaces. */
export function factorTagContrast(hue: string, text: string, theme: FactorTagTheme): number {
  const h = parseHex(hue);
  const t = parseHex(text);
  if (!h || !t) return 0;
  let worst = Infinity;
  for (const surface of FACTOR_TAG_SURFACES[theme]) {
    const s = parseHex(surface);
    if (!s) return 0;
    worst = Math.min(worst, contrast(t, mix(h, s, FACTOR_TAG_TINT_ALPHA)));
  }
  return worst;
}

/**
 * The text colour for a tag of `hue` in `theme`, as a 6-digit hex.
 * A value that is not a 6-digit hex is returned as given (nothing to derive from).
 */
export function factorTagTextColor(hue: string, theme: FactorTagTheme): string {
  const base = parseHex(hue);
  if (!base) return hue;
  const far: Rgb = theme === "light" ? [0, 0, 0] : [255, 255, 255];
  for (let share = 100; share >= 0; share -= 5) {
    // Measure the ROUNDED colour: that is what the browser paints.
    const candidate = toHex(mix(base, far, share / 100));
    if (factorTagContrast(hue, candidate, theme) >= FACTOR_TAG_MIN_CONTRAST) {
      return share === 100 ? hue : candidate;
    }
  }
  return toHex(far);
}

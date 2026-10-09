/**
 * Small text inside the always-dark modules, and small text under a fade.
 *
 * A browser pass on 2026-10-09 measured, after the class-pair sweeps:
 *
 * - inline greys on the chart panel's near-black: `#555` at 2.6:1 (the "$"
 *   prefix, "· ATR ≈", the suggested-levels show/hide word, the empty-state
 *   lines), `#666` at 3.4:1 (the Factor Profile section labels, the Inactive
 *   tag) and `#777` at 4.3 to 4.4:1 ("as of <date>" under a stat tile);
 * - the Levels sort picker inside that panel on a LIGHT page: the "Sort:"
 *   label at 2.68:1 and the active pill at 2.10:1 (light-theme ink on
 *   near-black);
 * - the chart footer legend under `opacity-70`: 3.2 to 3.5:1.
 *
 * The class-pair scans read theme classes; they cannot see an inline hex or
 * a fade on a wrapper. The two scans here can, for the forms that are
 * practical to read from source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DARK_MODULE_DIM_TEXT } from "@/app/dashboard/components/dark-module-text";
import { contrast, hex, mix, token } from "@/tests/helpers/tint-pair-scan";
import {
  DARK_MODULE_SURFACES,
  darkModuleRatio,
  isDarkModuleSource,
  isSmallTextSize,
  scanFadedSmallText,
  scanInlineGreys,
} from "@/tests/helpers/dark-module-scan";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const FLOOR = 4.5;
const two = (n: number) => Number(n.toFixed(2));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES = walk("app");
const SOURCES = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));
const read = (file: string) => {
  const src = SOURCES.get(file);
  if (!src) throw new Error(`no such source: ${file}`);
  return src;
};

// ─── 1. The dim grey ────────────────────────────────────────────

describe("DARK_MODULE_DIM_TEXT", () => {
  const on = (grey: string) => DARK_MODULE_SURFACES.map((s) => two(contrast(hex(grey), hex(s))));

  it("is #8a8a8a and reaches 4.5:1 on every dark-module surface", () => {
    expect(DARK_MODULE_DIM_TEXT).toBe("#8a8a8a");
    // #0a0a0a (panel), #0b0b0b (stat strip), #0d0d0d (command strip, cards).
    expect(on("8a8a8a")).toEqual([5.73, 5.7, 5.63]);
  });

  it("the greys it replaced were under the floor (the bound is real)", () => {
    expect(on("555555")).toEqual([2.66, 2.64, 2.61]);
    expect(on("666666")).toEqual([3.45, 3.43, 3.38]);
    expect(on("777777")).toEqual([4.42, 4.4, 4.34]);
  });

  it("the dark-module surfaces are the ones the panel paints", () => {
    const panel = read("app/dashboard/components/MarketDataPanel.tsx");
    for (const s of DARK_MODULE_SURFACES) expect(panel, s).toContain(`background: "#${s}"`);
  });
});

describe("the named sites take the constant", () => {
  const count = (src: string, needle: string) => src.split(needle).length - 1;

  it("the chart panel: the price prefix and both stat-tile prefixes", () => {
    const src = read("app/dashboard/components/MarketDataPanel.tsx");
    expect(count(src, "color: DARK_MODULE_DIM_TEXT")).toBe(3);
    expect(src).not.toContain('"#555"');
  });

  it("the Levels list: loading line, ATR note, show/hide word, empty state, Inactive tag", () => {
    const src = read("app/dashboard/components/LevelsPanel.tsx");
    expect(count(src, "color: DARK_MODULE_DIM_TEXT")).toBe(5);
    expect(src).not.toContain('"#666"');
    const atr = src.slice(anchorIndex(src, "Suggested · Auto-detected"), anchorIndex(src, '{expanded ? "hide" : "show"}'));
    expect(count(atr, "color: DARK_MODULE_DIM_TEXT")).toBe(2);
    const empty = anchorIndex(src, "{levels.length === 0");
    expect(src.slice(empty - 700, empty)).toContain("color: DARK_MODULE_DIM_TEXT");
  });

  it("the stat tile's second line (as of <date>)", () => {
    const src = read("app/dashboard/components/TerminalSection.tsx");
    const at = anchorIndex(src, "{subvalue != null && (");
    expect(src.slice(at, at + 300)).toContain("color: DARK_MODULE_DIM_TEXT");
    expect(src).not.toContain('"#777"');
  });

  it("the Factor Profile section labels", () => {
    const src = read("app/dashboard/security/[id]/FactorProfileSection.tsx");
    const at = anchorIndex(src, "function BlockLabel(");
    expect(src.slice(at, at + 400)).toContain("color: DARK_MODULE_DIM_TEXT");
  });
});

/**
 * Greys under the floor that stay, with how many times and why.
 * Key: "<file> | <hex>". A new use changes the count and fails.
 */
const GREY_ALLOWLIST: Record<string, { uses: number; reason: string }> = {
  "app/dashboard/components/LevelsPanel.tsx | #0a0a0a": {
    uses: 2,
    reason: "Near-black text on a solid bright level-colour tag, not on the dark surface itself.",
  },
  "app/dashboard/components/LevelsPanel.tsx | #555555": {
    uses: 1,
    reason: "The Reactivate button while it is disabled (already alerted today): a disabled control, which is exempt.",
  },
};

/** Rendered inside the dark chart panel without painting a surface of their own. */
const ALSO_DARK = ["app/dashboard/components/LevelsPanel.tsx", "app/dashboard/components/SortableHeader.tsx"];

describe("app/: no inline grey under 4.5:1 in a dark-module file", () => {
  const darkFiles = [...SOURCES].filter(([file, src]) => ALSO_DARK.includes(file) || isDarkModuleSource(src));
  const failing = darkFiles.flatMap(([file, src]) =>
    scanInlineGreys(src)
      .filter((g) => g.ratio < FLOOR)
      .map((g) => ({ ...g, file, id: `${file} | ${g.hex}` })),
  );

  it("the scan reads a plain colour, a ternary and an rgb(), and skips what is not text", () => {
    const src = [
      'const a = { color: "#555", fontSize: "11px" };',
      'const b = { color: on ? "#666" : "#22c55e" };',
      "const c = { color: 'rgb(85, 85, 85)' };",
      'const d = { borderColor: "#333", background: "#111", accentColor: "#444" };',
      'const e = { border: "1px solid #333" };',
      'const f = { color: "#8a8a8a" };',
      'const g = { color: "#ef4444" };',
      '// color: "#555" in a comment',
    ].join("\n");
    expect(
      scanInlineGreys(src)
        .filter((x) => x.ratio < FLOOR)
        .map((x) => `${x.line} ${x.hex} ${x.ratio.toFixed(2)}`),
    ).toEqual(["1 #555555 2.61", "2 #666666 3.38", "3 #555555 2.61"]);
    expect(two(darkModuleRatio("8a8a8a"))).toBe(5.63);
  });

  it("knows a dark-module file by its painted surface or its terminal parts", () => {
    expect(isDarkModuleSource('const s = { background: "#0a0a0a" };')).toBe(true);
    expect(isDarkModuleSource('import { TerminalTag } from "../../components/TerminalSection";')).toBe(true);
    expect(isDarkModuleSource('import { DARK_MODULE_DIM_TEXT } from "./dark-module-text";')).toBe(true);
    expect(isDarkModuleSource('const s = { background: "#ffffff" };')).toBe(false);
    const found = darkFiles.map(([file]) => file);
    for (const file of [
      "app/dashboard/components/MarketDataPanel.tsx",
      "app/dashboard/components/LevelsPanel.tsx",
      "app/dashboard/components/SecurityChart.tsx",
      "app/dashboard/components/TerminalSection.tsx",
      "app/dashboard/security/[id]/FactorProfileSection.tsx",
    ]) {
      expect(found, file).toContain(file);
    }
  });

  it("every failing grey is on the allowlist, the stated number of times", () => {
    const uses = new Map<string, number>();
    for (const f of failing) uses.set(f.id, (uses.get(f.id) ?? 0) + 1);
    const unexpected = failing
      .filter((f) => !(f.id in GREY_ALLOWLIST))
      .map(
        (f) =>
          `${f.file}:${f.line} [${f.hex}] ${f.ratio.toFixed(2)}:1 on the dark module: ` +
          "use DARK_MODULE_DIM_TEXT (app/dashboard/components/dark-module-text.ts) or a lighter grey",
      );
    expect(unexpected).toEqual([]);
    for (const [id, { uses: allowed }] of Object.entries(GREY_ALLOWLIST)) {
      expect(uses.get(id) ?? 0, id).toBe(allowed);
    }
  });

  it("every allowlist entry carries a reason", () => {
    for (const [id, { reason }] of Object.entries(GREY_ALLOWLIST)) {
      expect(reason.length, id).toBeGreaterThan(20);
    }
  });
});

// ─── 2. The sort picker inside the dark panel ───────────────────

describe("the Levels sort picker inside the always-dark panel, on a light page", () => {
  const picker = read("app/dashboard/components/SortPicker.tsx");
  const css = readFileSync("app/globals.css", "utf8");
  const surface = hex("0a0a0a");

  it("the label opts in to the panel's chrome colour and keeps its own colour elsewhere", () => {
    expect(picker).toContain('<span className="chart-chrome text-[11px] text-ink-faint mr-1">{label}</span>');
    const rule = css.slice(anchorIndex(css, ".dark-module-chart .chart-chrome {"));
    expect(rule.slice(0, 80)).toContain("color: #8a8a8a;");
    // Before: the light theme's ink-faint on near-black. After: the rule's grey.
    expect(two(contrast(token("light", "ink-faint"), surface))).toBe(2.68);
    expect(two(contrast(hex("8a8a8a"), surface))).toBe(5.73);
    // A dark page was already fine and takes the same grey now.
    expect(two(contrast(token("dark", "ink-faint"), surface))).toBe(5.58);
  });

  it("the active pill opts in to the panel's gold", () => {
    expect(picker).toContain("? `chart-status-gold ${CHIP_TONE_CLASSES.gold}`");
    anchorIndex(css, ".dark-module-chart .chart-status-gold {");
    const tint = mix(token("light", "gold"), surface, 0.2);
    const oldInk = mix(token("light", "gold-ink"), hex("000000"), 0.8);
    expect(two(contrast(oldInk, tint))).toBe(2.1);
    expect(two(contrast(hex("ffb84d"), tint))).toBe(9.03);
    expect(two(contrast(hex("ffb84d"), mix(token("dark", "gold"), surface, 0.2)))).toBe(7.78);
  });

  it("the Levels list is the user inside the panel", () => {
    expect(read("app/dashboard/components/LevelsPanel.tsx")).toContain("<SortPicker");
    expect(read("app/dashboard/components/MarketDataPanel.tsx")).toContain('className="dark-module-chart ');
  });
});

// ─── 3. A fade on small text ────────────────────────────────────

/** Faded small text that stays, with the reason. Key: "<file> | <opacity> <size>". */
const FADE_ALLOWLIST: Record<string, string> = {};

describe("app/: no resting-state fade on an element that sets a small text size", () => {
  const found = [...SOURCES].flatMap(([file, src]) =>
    scanFadedSmallText(src)
      .filter((f) => f.light < FLOOR || f.dark < FLOOR)
      .map((f) => ({ ...f, file, id: `${file} | ${f.opacity} ${f.size}` })),
  );

  it("the scan flags the legend's old wrapper and measures it as the browser did", () => {
    const [f] = scanFadedSmallText(
      'const a = <div className="hidden sm:flex items-center gap-2 text-[10px] opacity-70" />;',
    );
    expect(f.opacity).toBe("opacity-70");
    expect(f.size).toBe("text-[10px]");
    // Inherited ink-faint at 70%: lowest of canvas, panel, raised.
    expect([two(f.light), two(f.dark)]).toEqual([3.33, 3.21]);
  });

  it("ignores state-only fades, fades with no text size, and fades that still pass", () => {
    const src = [
      'const a = "text-xs text-ink-dim disabled:opacity-50 hover:opacity-80";',
      'const b = "w-2 h-2 rounded-sm opacity-70";',
      "const c = `text-xs ${struck ? \"opacity-60\" : \"\"}`;",
      'const d = "text-xs text-ink opacity-90";',
      'const e = "text-2xl text-ink-faint opacity-50";',
      'const f = "text-sm text-ink-faint opacity-100";',
    ].join("\n");
    expect(scanFadedSmallText(src).filter((f) => f.light < FLOOR || f.dark < FLOOR)).toEqual([]);
    expect(isSmallTextSize("text-[17px]")).toBe(true);
    expect(isSmallTextSize("text-[18px]")).toBe(false);
    expect(isSmallTextSize("text-lg")).toBe(false);
    expect(isSmallTextSize("text-ink")).toBe(false);
  });

  it("every fade under the floor is on the allowlist", () => {
    const unexpected = found
      .filter((f) => !(f.id in FADE_ALLOWLIST))
      .map(
        (f) =>
          `${f.file}:${f.line} [${f.opacity} with ${f.size}, measured as ${f.text}] ` +
          `light ${f.light.toFixed(2)}, dark ${f.dark.toFixed(2)}: fade the decoration, not the text`,
      );
    expect(unexpected).toEqual([]);
  });

  it("every allowlist entry still matches and carries a reason", () => {
    const live = new Set(found.map((f) => f.id));
    expect(Object.keys(FADE_ALLOWLIST).filter((id) => !live.has(id))).toEqual([]);
    for (const [id, reason] of Object.entries(FADE_ALLOWLIST)) {
      expect(reason.length, id).toBeGreaterThan(20);
    }
  });
});

describe("the chart footer legend", () => {
  const chart = read("app/dashboard/components/SecurityChart.tsx");

  it("the labels are not faded; only the swatch is", () => {
    const at = anchorIndex(chart, '<LegendDot color="#ffb84d" label="last price" />');
    const wrapper = chart.slice(chart.lastIndexOf("<div", at), at);
    expect(wrapper).toContain('className="hidden sm:flex items-center gap-2 text-[10px]"');
    expect(wrapper).not.toContain("opacity-");
    const dot = chart.slice(anchorIndex(chart, "function LegendDot("));
    const swatch = dot.slice(anchorIndex(dot, "aria-hidden"), anchorIndex(dot, "<span>{label}</span>"));
    expect(swatch).toContain("opacity-70");
    expect(dot.slice(0, anchorIndex(dot, "aria-hidden"))).not.toContain("opacity-");
  });

  it("the footer still opts in to the dark panel's chrome colour", () => {
    const at = anchorIndex(chart, '<LegendDot color="#ffb84d" label="last price" />');
    const footer = chart.slice(chart.lastIndexOf("chart-chrome", at), at);
    expect(footer).toContain("text-ink-faint");
  });

  it("pins the label contrast before and after, in the panel and on the Charts page", () => {
    const faded = (ink: number[], under: number[]) =>
      two(contrast(mix(ink as [number, number, number], under as [number, number, number], 0.7), under as [number, number, number]));
    const module = hex("0a0a0a");
    // Inside the always-dark panel (either page theme): the chrome grey.
    expect(faded(hex("8a8a8a"), module)).toBe(3.33);
    expect(two(contrast(hex("8a8a8a"), module))).toBe(5.73);
    // On the Charts page the footer sits on a themed panel.
    expect(faded(token("light", "ink-faint"), token("light", "panel"))).toBe(3.53);
    expect(faded(token("dark", "ink-faint"), token("dark", "panel"))).toBe(3.24);
    expect(two(contrast(token("light", "ink-faint"), token("light", "panel")))).toBe(7.38);
    expect(two(contrast(token("dark", "ink-faint"), token("dark", "panel")))).toBe(5.48);
  });
});

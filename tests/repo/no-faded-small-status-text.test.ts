/**
 * Small coloured text that is NOT on its own tint must still reach 4.5:1 in
 * both themes. Sibling of no-handrolled-failing-tint-pairs.test.ts, which
 * covers text on a tint.
 *
 * A browser pass on 2026-10-09 measured four families under the floor:
 *
 * 1. Faded status text (`text-up/80`, `text-down/70`, `text-gold/80` ...) on
 *    a plain surface: 2.1 to 3.9:1. It now takes the full-strength checked
 *    ink, `CHIP_TONE_TEXT.<tone>`.
 * 2. Small `text-gold` in the light theme: 2.9 to 3.25:1. `--gold` is the
 *    large-text and accent gold; small gold copy takes `text-gold-ink`.
 * 3. Solid gold buttons, `bg-gold text-canvas`: 3.10:1 in the light theme.
 *    They take `GOLD_FILL_CLASSES`.
 * 4. Solid red buttons, the grades bar letters, the violet OPT tag and the
 *    factor "No" pill: pinned one by one below.
 *
 * 5. Hover states (second browser pass, 2026-10-09): `hover:text-gold/80`
 *    on a small gold link (2.31:1 while hovered), `hover:text-gold` (2.92:1),
 *    a 10% gold tint under gold-ink text (4.34:1) and a 30% blue tint under
 *    blue text (4.35:1 in the dark theme). A hover must not make text harder
 *    to read: the affordance is now an underline, a thicker underline, a
 *    brightness filter, or a colour that still reaches the floor.
 *
 * The scans read class names only. They cannot read text size, so text of
 * 18px and up, icons and decorative glyphs that stay on the plain gold are
 * allowlisted with the reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHIP_TONE_TEXT } from "@/app/dashboard/components/chip-tone-text";
import {
  DANGER_FILL_CLASSES,
  GOLD_FILL_CLASSES,
  GOLD_FILL_TEXT,
  GOLD_OUTLINE_HOVER,
} from "@/app/dashboard/components/chip-tone-text";
import {
  GRADE_BAR_FILL,
  GRADE_BAR_TEXT,
} from "@/app/dashboard/components/trade-grade-bar";
import { tagTextColor } from "@/app/dashboard/components/TerminalSection";
import { LEVEL_COLORS } from "@/lib/factors";
import { toneClass } from "@/lib/analysis/interpret";
import {
  classify,
  contrast,
  hex,
  worstRatio,
  THEMES,
  type Theme,
} from "@/tests/helpers/tint-pair-scan";
import {
  fadedHoverText,
  hoverFailures,
  linesPairing,
  linesUsing,
  plainRatio,
  scanFadedText,
  scanHoverChanges,
} from "@/tests/helpers/small-text-scan";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const FLOOR = 4.5;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES = walk("app");
const SOURCES = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));

/** The fill and text a class string renders in one theme (resting state). */
function rendered(classes: string, theme: Theme): { bg?: string; text?: string } {
  const words = classes.split(/\s+/).map(classify);
  const pick = (prefix: string) => {
    const own = words.find((w) => w.scope === theme && w.utility.startsWith(prefix));
    const base = words.find((w) => w.scope === "base" && w.utility.startsWith(prefix));
    return (own ?? base)?.utility;
  };
  return { bg: pick("bg-"), text: pick("text-") };
}

function textIn(classes: string, theme: Theme): string {
  const { text } = rendered(classes, theme);
  if (!text) throw new Error(`no text utility in: ${classes}`);
  return text;
}

function fillRatio(classes: string, theme: Theme): number {
  const { bg, text } = rendered(classes, theme);
  if (!bg || !text) throw new Error(`no fill or text in: ${classes}`);
  return worstRatio(theme, bg, text);
}

// ─── 1. Faded status text ───────────────────────────────────────

describe("the checked inks on a plain surface", () => {
  it.each(["up", "down", "gold"] as const)("%s reaches 4.5:1 in both themes", (tone) => {
    for (const theme of THEMES) {
      expect(plainRatio(theme, textIn(CHIP_TONE_TEXT[tone], theme)), theme).toBeGreaterThanOrEqual(
        FLOOR,
      );
    }
  });

  it("pins the measured figures (lowest of canvas, panel, raised)", () => {
    const figure = (tone: "up" | "down" | "gold", theme: Theme) =>
      Number(plainRatio(theme, textIn(CHIP_TONE_TEXT[tone], theme)).toFixed(2));
    expect({
      up: [figure("up", "light"), figure("up", "dark")],
      down: [figure("down", "light"), figure("down", "dark")],
      gold: [figure("gold", "light"), figure("gold", "dark")],
    }).toEqual({ up: [6.51, 8.29], down: [6.74, 6.32], gold: [6.63, 10.98] });
  });

  it("the faded forms they replaced really do fail (the bound is real)", () => {
    expect(plainRatio("light", "text-up/80")).toBeLessThan(FLOOR);
    expect(plainRatio("light", "text-up/70")).toBeLessThan(FLOOR);
    expect(plainRatio("light", "text-down/80")).toBeLessThan(FLOOR);
    expect(plainRatio("dark", "text-down/80")).toBeLessThan(FLOOR);
    expect(plainRatio("dark", "text-down/70")).toBeLessThan(FLOOR);
    expect(plainRatio("light", "text-gold/80")).toBeLessThan(FLOOR);
    expect(plainRatio("light", "text-gold/70")).toBeLessThan(FLOOR);
    expect(plainRatio("light", "text-ink-faint/70")).toBeLessThan(FLOOR);
    expect(plainRatio("dark", "text-ink-faint/60")).toBeLessThan(FLOOR);
  });

  it("the analysis caption tones are the checked inks", () => {
    expect(toneClass("good")).toBe(CHIP_TONE_TEXT.up);
    expect(toneClass("bad")).toBe(CHIP_TONE_TEXT.down);
    expect(toneClass("neutral")).toBe("text-ink-faint");
    for (const theme of THEMES) {
      expect(plainRatio(theme, "text-ink-faint")).toBeGreaterThanOrEqual(FLOOR);
    }
  });
});

/** Faded text that stays, each with the reason. Key: "<file> | <utility>". */
const FADED_ALLOWLIST: Record<string, string> = {
  "app/dashboard/components/FactorHeatmap.tsx | text-ink-faint/30":
    "The dash in an empty heatmap cell: a decorative placeholder that carries no information.",
  "app/dashboard/components/ManageSourcesModal.tsx | text-ink-faint/40":
    "The delete icon of a source that cannot be deleted (cursor-not-allowed): a disabled control, which is exempt.",
};

type Faded = { id: string; where: string; light: number; dark: number };

function fadedIn(file: string, src: string): Faded[] {
  return scanFadedText(src)
    .filter((f) => f.light < FLOOR || f.dark < FLOOR)
    .map((f) => ({
      id: `${file} | ${f.utility}`,
      where: `${file}:${f.line}`,
      light: f.light,
      dark: f.dark,
    }));
}

describe("app/: no faded small text under 4.5:1 on a plain surface", () => {
  const found = [...SOURCES].flatMap(([file, src]) => fadedIn(file, src));

  it("the scan flags a faded tone and ignores hover and disabled states", () => {
    const src = [
      'const a = "text-xs text-up/80";',
      "const b = ok ? \"text-down/70\" : `text-gold/70 ${x}`;",
      'const c = "text-gold-ink hover:text-gold/80 disabled:text-ink-faint/50";',
      "// a comment that mentions text-down/80",
      'const d = "text-blue/80 text-warn/90";',
    ].join("\n");
    expect(fadedIn("x.tsx", src).map((f) => f.id)).toEqual([
      "x.tsx | text-up/80",
      "x.tsx | text-down/70",
      "x.tsx | text-gold/70",
    ]);
  });

  it("every faded class under the floor is on the allowlist", () => {
    const unexpected = found
      .filter((f) => !(f.id in FADED_ALLOWLIST))
      .map(
        (f) =>
          `${f.where} [${f.id.split(" | ")[1]}] light ${f.light.toFixed(2)}, dark ${f.dark.toFixed(2)}: ` +
          "use the full-strength checked ink, CHIP_TONE_TEXT.<tone> (app/dashboard/components/chip-tone-text.ts)",
      );
    expect(unexpected).toEqual([]);
  });

  it("every allowlist entry still matches and carries a reason", () => {
    const live = new Set(found.map((f) => f.id));
    expect(Object.keys(FADED_ALLOWLIST).filter((id) => !live.has(id))).toEqual([]);
    for (const [id, reason] of Object.entries(FADED_ALLOWLIST)) {
      expect(reason.length, id).toBeGreaterThan(20);
    }
  });
});

// ─── 2. Small text-gold ─────────────────────────────────────────

/**
 * Files that keep the plain `text-gold`, with how many times and why.
 * A new use in a listed file changes the count and fails, so it gets looked at.
 */
const PLAIN_GOLD_ALLOWLIST: Record<string, { uses: number; reason: string }> = {
  "app/dashboard/layout.tsx": { uses: 1, reason: "Large text: the app title, 18px on a phone and 20px from md up." },
  "app/dashboard/today/page.tsx": { uses: 1, reason: "Large text: the 24px Today page heading." },
  "app/dashboard/today/WeekAheadView.tsx": { uses: 1, reason: "Large text: the 24px week range heading." },
  "app/dashboard/levels/performance/page.tsx": { uses: 1, reason: "Large text: the 24px Source Performance heading." },
  "app/dashboard/security/[id]/page.tsx": { uses: 1, reason: "Large text: the 18px semibold symbol link in the security header." },
  "app/dashboard/components/WelcomeOverlay.tsx": { uses: 1, reason: "Large text: the 30px welcome heading." },
  "app/dashboard/components/MobileNavDrawer.tsx": { uses: 1, reason: "Large text: the 18px app title in the drawer header." },
  "app/dashboard/components/DataHealthView.tsx": {
    uses: 2,
    reason: "Large text: the 24px figure of a summary tile and the 20px Data Health heading.",
  },
  "app/dashboard/components/analysis/ClassificationCard.tsx": {
    uses: 2,
    reason: "Large text: both colour the 20px figure of a concentration tile.",
  },
  "app/dashboard/components/CanonicalCsvGuide.tsx": { uses: 1, reason: "An icon (a 20px svg), not text." },
  "app/dashboard/components/ChatDrawer.tsx": { uses: 1, reason: "An icon (the chat bubble svg), not text." },
  "app/dashboard/components/OpenChatButton.tsx": { uses: 1, reason: "An icon (the chat bubble svg), not text." },
  "app/dashboard/components/PrivacyToggle.tsx": { uses: 1, reason: "An icon button (the eye svg), not text." },
  "app/dashboard/components/LevelsPanel.tsx": {
    uses: 2,
    reason:
      "Rendered inside the always-dark chart module, where the light theme's darker gold-ink would land on near-black. Not measured here: needs a browser check before it changes.",
  },
};

describe("app/: small gold text uses text-gold-ink", () => {
  const found = new Map(
    [...SOURCES]
      .map(([file, src]) => [file, linesUsing(src, "text-gold")] as const)
      .filter(([, lines]) => lines.length > 0),
  );

  it("plain gold fails as small text in the light theme and gold-ink passes", () => {
    expect(plainRatio("light", "text-gold")).toBeLessThan(FLOOR);
    expect(Number(plainRatio("light", "text-gold").toFixed(2))).toBe(2.92);
    expect(Number(plainRatio("light", "text-gold-ink").toFixed(2))).toBe(4.78);
    // The dark theme has one gold: the switch changes nothing there.
    expect(plainRatio("dark", "text-gold-ink")).toBe(plainRatio("dark", "text-gold"));
    expect(plainRatio("dark", "text-gold")).toBeGreaterThanOrEqual(FLOOR);
  });

  it("the scan reads the resting state only", () => {
    const src = 'const a = on ? "text-gold" : "text-ink-faint hover:text-gold"; const b = "text-gold-ink";';
    expect(linesUsing(src, "text-gold")).toEqual([1]);
  });

  it("every file that uses the plain gold is listed with its count", () => {
    const unexpected = [...found]
      .filter(([file, lines]) => PLAIN_GOLD_ALLOWLIST[file]?.uses !== lines.length)
      .map(
        ([file, lines]) =>
          `${file} lines ${lines.join(", ")}: small text takes text-gold-ink ` +
          `(listed uses: ${PLAIN_GOLD_ALLOWLIST[file]?.uses ?? 0})`,
      );
    expect(unexpected).toEqual([]);
  });

  it("every allowlist entry still matches and carries a reason", () => {
    expect(Object.keys(PLAIN_GOLD_ALLOWLIST).filter((file) => !found.has(file))).toEqual([]);
    for (const [file, entry] of Object.entries(PLAIN_GOLD_ALLOWLIST)) {
      expect(entry.reason.length, file).toBeGreaterThan(20);
    }
  });
});

// ─── 3. Solid gold fill ─────────────────────────────────────────

/** Files that keep a hand-written `bg-gold text-canvas`, with the reason. */
const SOLID_GOLD_ALLOWLIST: Record<string, string> = {
  "app/dashboard/components/ChatInterface.tsx":
    "Protected file (the chat send button). Reported to the owner: it should take GOLD_FILL_CLASSES.",
};

describe("solid gold fill", () => {
  it("the old pair fails in the light theme only", () => {
    expect(Number(worstRatio("light", "bg-gold", "text-canvas").toFixed(2))).toBe(3.1);
    expect(Number(worstRatio("dark", "bg-gold", "text-canvas").toFixed(2))).toBe(11.52);
  });

  it("GOLD_FILL_CLASSES reaches 4.5:1 in both themes", () => {
    expect(Number(fillRatio(GOLD_FILL_CLASSES, "light").toFixed(2))).toBe(6.08);
    expect(Number(fillRatio(GOLD_FILL_CLASSES, "dark").toFixed(2))).toBe(11.52);
  });

  it("the dark theme renders exactly the old pair", () => {
    expect(rendered(GOLD_FILL_CLASSES, "dark")).toEqual({ bg: "bg-gold", text: "text-canvas" });
    expect(GOLD_FILL_CLASSES).toBe(`bg-gold ${GOLD_FILL_TEXT}`);
  });

  it("a lighter hover fill only raises the light-theme ratio", () => {
    expect(worstRatio("light", "bg-gold/90", "text-ink")).toBeGreaterThan(
      fillRatio(GOLD_FILL_CLASSES, "light"),
    );
  });

  it("the other candidate, gold-ink as the fill with cream text, is lower", () => {
    expect(Number(worstRatio("light", "bg-gold-ink", "text-canvas").toFixed(2))).toBe(5.08);
  });

  it("the scan finds a hand-written pair, split or adjacent", () => {
    const src = [
      'const a = "px-2 bg-gold text-canvas";',
      'const b = "bg-gold px-3 text-[13px] text-canvas disabled:opacity-50";',
      'const c = "h-0.5 bg-gold rounded-full";',
      "const d = `px-2 ${GOLD_FILL_CLASSES}`;",
    ].join("\n");
    expect(linesPairing(src, "bg-gold", "text-canvas")).toEqual([1, 2]);
  });

  it("no file under app/ hand-writes bg-gold with text-canvas", () => {
    const found = [...SOURCES]
      .map(([file, src]) => [file, linesPairing(src, "bg-gold", "text-canvas")] as const)
      .filter(([, lines]) => lines.length > 0);
    const unexpected = found
      .filter(([file]) => !(file in SOLID_GOLD_ALLOWLIST))
      .map(([file, lines]) => `${file} lines ${lines.join(", ")}: use GOLD_FILL_CLASSES`);
    expect(unexpected).toEqual([]);
    const live = new Set(found.map(([file]) => file));
    expect(Object.keys(SOLID_GOLD_ALLOWLIST).filter((file) => !live.has(file))).toEqual([]);
  });

  it("the skip link is near-black on gold in both themes", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const rule = css.slice(anchorIndex(css, ".skip-link {"), anchorIndex(css, ".skip-link:focus"));
    expect(rule).toContain("background: var(--color-gold);");
    expect(rule).toContain("color: var(--color-ink);");
    expect(rule).toMatch(/\[data-theme="dark"\] \.skip-link \{\s*color: var\(--color-canvas\);/);
  });
});

// ─── 4. One-off elements ────────────────────────────────────────

describe("solid red destructive buttons", () => {
  it("the old fill failed in the dark theme", () => {
    expect(Number(worstRatio("light", "bg-down/90", "text-white").toFixed(2))).toBe(4.64);
    expect(Number(worstRatio("dark", "bg-down/90", "text-white").toFixed(2))).toBe(4.44);
    // Full red with white is worse still in the dark theme.
    expect(worstRatio("dark", "bg-down", "text-white")).toBeLessThan(FLOOR);
  });

  it("DANGER_FILL_CLASSES reaches 4.5:1 in both themes", () => {
    expect(Number(fillRatio(DANGER_FILL_CLASSES, "light").toFixed(2))).toBe(5.37);
    expect(Number(fillRatio(DANGER_FILL_CLASSES, "dark").toFixed(2))).toBe(5.51);
  });

  it.each([
    "app/dashboard/components/ConfirmDialog.tsx",
    "app/dashboard/today/EarningsDeleteButton.tsx",
  ])("%s takes the shared classes", (file) => {
    const src = SOURCES.get(file) ?? "";
    expect(src).toContain("${DANGER_FILL_CLASSES}");
    expect(src).not.toContain("bg-down/90");
  });
});

describe("trade review grades bar", () => {
  const GRADES = ["A", "B", "C", "D", "F"] as const;
  const ratio = (grade: string, theme: Theme, text = textIn(GRADE_BAR_TEXT[grade], theme)) =>
    worstRatio(theme, GRADE_BAR_FILL[grade], text);

  it("the old faded cream letters were under the floor on every segment in the light theme", () => {
    for (const g of GRADES) {
      expect(worstRatio("light", GRADE_BAR_FILL[g], "text-canvas/80"), g).toBeLessThan(FLOOR);
    }
  });

  it("each segment takes whichever of canvas or ink reads better, per theme (B in the dark theme takes white)", () => {
    for (const g of GRADES) {
      for (const theme of THEMES) {
        const best = Math.max(
          worstRatio(theme, GRADE_BAR_FILL[g], "text-canvas"),
          worstRatio(theme, GRADE_BAR_FILL[g], "text-ink"),
        );
        if (g === "B" && theme === "dark") {
          // Neither theme colour reaches the floor on the 60% green, so the
          // letter is white there (a browser measured the ink at 4.21:1).
          expect(Number(best.toFixed(2))).toBe(4.11);
          expect(textIn(GRADE_BAR_TEXT.B, "dark")).toBe("text-white");
          expect(ratio(g, theme)).toBeGreaterThan(best);
          continue;
        }
        expect(ratio(g, theme), `${g} ${theme}`).toBe(best);
      }
    }
  });

  it("pins the figures; every segment reaches 4.5:1 in both themes", () => {
    const table = Object.fromEntries(
      GRADES.map((g) => [g, THEMES.map((t) => Number(ratio(g, t).toFixed(2)))]),
    );
    expect(table).toEqual({
      A: [4.96, 8.69],
      B: [7.41, 5.18],
      C: [6.08, 11.52],
      D: [6.8, 6.04],
      F: [5.12, 5.26],
    });
    const under = GRADES.flatMap((g) =>
      THEMES.filter((t) => ratio(g, t) < FLOOR).map((t) => `${g} ${t}`),
    );
    expect(under).toEqual([]);
  });

  it("B keeps the ink in the light theme, where white would be 2.52:1", () => {
    expect(textIn(GRADE_BAR_TEXT.B, "light")).toBe("text-ink");
    expect(Number(worstRatio("light", GRADE_BAR_FILL.B, "text-white").toFixed(2))).toBe(2.52);
  });
});

describe("factor tags (the security page Factor Profile)", () => {
  it("every factor colour gets text that reaches 4.5:1", () => {
    for (const [level, fill] of Object.entries(LEVEL_COLORS)) {
      const text = tagTextColor(fill);
      expect(contrast(hex(text.slice(1)), hex(fill.slice(1))), level).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it("the grey No pill moves from near-black (4.16:1) to white (4.76:1)", () => {
    const no = hex(LEVEL_COLORS.No.slice(1));
    expect(Number(contrast(hex("0a0a0a"), no).toFixed(2))).toBe(4.16);
    expect(tagTextColor(LEVEL_COLORS.No)).toBe("#ffffff");
    expect(Number(contrast(hex("ffffff"), no).toFixed(2))).toBe(4.76);
  });

  it("the bright fills keep the near-black text", () => {
    for (const level of ["Low", "Moderate", "High", "Very High", "Growth", "International"]) {
      expect(tagTextColor(LEVEL_COLORS[level]), level).toBe("#0a0a0a");
    }
  });

  it("a colour that is not a 6-digit hex keeps the near-black text", () => {
    expect(tagTextColor("var(--gold)")).toBe("#0a0a0a");
  });
});

// ─── 5. Hover states ────────────────────────────────────────────

/**
 * Hover changes that leave text under 4.5:1, each with the reason.
 * Key: "<file> | <the hover classes as written>".
 */
const HOVER_ALLOWLIST: Record<string, string> = {
  "app/dashboard/components/PrivacyToggle.tsx | hover:text-gold/80":
    "An icon button (the eye svg), not text; the plain gold it rests on is allowlisted above for the same reason.",
  "app/dashboard/components/LevelsPanel.tsx | hover:bg-gold/5":
    "Rendered inside the always-dark chart module: the light-theme figure does not apply there, and the dark figure passes (10.14:1).",
  "app/dashboard/components/LevelsPanel.tsx | hover:text-emerald-300":
    "Rendered inside the always-dark chart module, where the hover brightens the text (9.82 to 12.39:1); the light figure does not apply.",
  "app/dashboard/components/LevelsPanel.tsx | hover:text-rose-300":
    "Rendered inside the always-dark chart module, where the hover brightens the text (7.02 to 9.99:1); the light figure does not apply.",
};

/** Hover text that fades (an opacity suffix) and stays, each with the reason. */
const FADED_HOVER_ALLOWLIST: Record<string, string> = {
  "app/dashboard/components/PrivacyToggle.tsx | hover:text-gold/80":
    "An icon button (the eye svg), not text: the fade is the pressed-state cue of an icon.",
};

describe("app/: a hover never drops small text under 4.5:1", () => {
  const failures = [...SOURCES].flatMap(([file, src]) =>
    hoverFailures(src, FLOOR).map((c) => ({ ...c, id: `${file} | ${c.hover}`, where: `${file}:${c.line}` })),
  );
  const fades = [...SOURCES].flatMap(([file, src]) =>
    fadedHoverText(src).map((c) => ({ id: `${file} | ${c.hover}`, where: `${file}:${c.line}` })),
  );

  it("the forms that were replaced really do fail (the bound is real)", () => {
    expect(Number(plainRatio("light", "text-gold/80").toFixed(2))).toBe(2.31);
    expect(Number(plainRatio("light", "text-gold").toFixed(2))).toBe(2.92);
    expect(plainRatio("light", "text-down/80")).toBeLessThan(FLOOR);
    expect(plainRatio("dark", "text-down/80")).toBeLessThan(FLOOR);
    expect(Number(worstRatio("light", "bg-gold/10", "text-gold-ink").toFixed(2))).toBe(4.34);
    expect(Number(worstRatio("dark", "bg-blue/30", "text-blue").toFixed(2))).toBe(4.35);
    // The resting states they sit on pass.
    expect(plainRatio("light", "text-gold-ink")).toBeGreaterThanOrEqual(FLOOR);
    expect(worstRatio("dark", "bg-blue/20", "text-blue")).toBeGreaterThanOrEqual(FLOOR);
  });

  it("the scan reads the hovered text on the hovered fill, per theme", () => {
    const src = [
      'const a = "text-xs text-gold-ink hover:text-gold/80";',
      'const b = "text-gold-ink hover:underline";',
      'const c = "bg-blue/20 text-blue hover:bg-blue/30 disabled:opacity-50";',
      'const d = "text-ink-faint hover:text-ink";',
      'const e = "text-gold-ink enabled:hover:bg-gold/10 disabled:hover:text-gold/50";',
      "// a comment that mentions hover:text-gold/80",
      'const f = "text-ink group-hover:text-gold";',
      'const g = "hover:bg-gold/10";',
    ].join("\n");
    expect(scanHoverChanges(src).map((c) => `${c.line} ${c.hover}`)).toEqual([
      "1 hover:text-gold/80",
      "3 hover:bg-blue/30",
      "4 hover:text-ink",
      "5 enabled:hover:bg-gold/10",
      "7 group-hover:text-gold",
    ]);
    const failed = hoverFailures(src, FLOOR);
    expect(failed.map((c) => `${c.line} ${c.hover}`)).toEqual([
      "1 hover:text-gold/80",
      "3 hover:bg-blue/30",
      "5 enabled:hover:bg-gold/10",
      "7 group-hover:text-gold",
    ]);
    // Line 3 fails in the dark theme only; line 1 in the light theme only.
    expect(failed[1].hovered.light).toBeGreaterThanOrEqual(FLOOR);
    expect(failed[1].hovered.dark).toBeLessThan(FLOOR);
    expect(failed[0].hovered.dark).toBeGreaterThanOrEqual(FLOOR);
    expect(fadedHoverText(src).map((c) => `${c.line} ${c.hover}`)).toEqual(["1 hover:text-gold/80"]);
  });

  it("a hover that raises a failing resting contrast is not this scan's business", () => {
    // The resting state is covered by the scans above.
    expect(hoverFailures('const a = "bg-up/20 text-up hover:bg-up/10";', FLOOR)).toEqual([]);
  });

  it("GOLD_OUTLINE_HOVER reaches 4.5:1 on its own tint in both themes", () => {
    const [change] = scanHoverChanges(`const x = "${GOLD_OUTLINE_HOVER}";`);
    expect(change.hover).toBe(GOLD_OUTLINE_HOVER);
    expect([Number(change.hovered.light.toFixed(2)), Number(change.hovered.dark.toFixed(2))]).toEqual([6.03, 9.18]);
  });

  it("every hover that leaves text under the floor is on the allowlist", () => {
    const fmt = (n: number | null) => (n === null ? "none" : n.toFixed(2));
    const unexpected = failures
      .filter((f) => !(f.id in HOVER_ALLOWLIST))
      .map(
        (f) =>
          `${f.where} [${f.hover}] light ${fmt(f.resting.light)} to ${fmt(f.hovered.light)}, ` +
          `dark ${fmt(f.resting.dark)} to ${fmt(f.hovered.dark)}: keep the resting colour and use ` +
          "hover:underline (hover:decoration-2 on an underlined link), hover:brightness-95 on a tinted " +
          "button, or GOLD_OUTLINE_HOVER on a gold outline button",
      );
    expect(unexpected).toEqual([]);
  });

  it("no small coloured text fades on hover, whatever the figure", () => {
    const unexpected = fades
      .filter((f) => !(f.id in FADED_HOVER_ALLOWLIST))
      .map((f) => `${f.where} [${f.hover}]: a hover must not fade text; use hover:underline`);
    expect(unexpected).toEqual([]);
  });

  it("every allowlist entry still matches and carries a reason", () => {
    const liveFailures = new Set(failures.map((f) => f.id));
    const liveFades = new Set(fades.map((f) => f.id));
    expect(Object.keys(HOVER_ALLOWLIST).filter((id) => !liveFailures.has(id))).toEqual([]);
    expect(Object.keys(FADED_HOVER_ALLOWLIST).filter((id) => !liveFades.has(id))).toEqual([]);
    for (const [id, reason] of [...Object.entries(HOVER_ALLOWLIST), ...Object.entries(FADED_HOVER_ALLOWLIST)]) {
      expect(reason.length, id).toBeGreaterThan(20);
    }
  });

  it("the protected chat file carries no hover fade (it could not be fixed here)", () => {
    const chat = SOURCES.get("app/dashboard/components/ChatInterface.tsx") ?? "";
    expect(chat.length).toBeGreaterThan(0);
    expect(hoverFailures(chat, FLOOR)).toEqual([]);
  });
});

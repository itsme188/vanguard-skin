/**
 * No hand-written "coloured small text on its own tint" pair under app/ may
 * sit below 4.5:1 in either theme.
 *
 * The shared Chip table (app/dashboard/components/Chip.tsx) holds the checked
 * green, red and gold pairs. Before the 2026-10-09 sweep about sixty files
 * still hand-wrote the plain pairs (`bg-up/20 text-up`, `bg-down/20
 * text-down`, `bg-gold/20 text-gold-ink`, and 10% / 15% variants), which
 * measure 3.6:1 to 4.3:1 in the light theme and, for red, about 4.1:1 in the
 * dark theme. They now take `CHIP_TONE_CLASSES.<tone>` (tint and text) or
 * `CHIP_TONE_TEXT.<tone>` (text only, the element keeps its own tint).
 *
 * This scan measures every tint-and-text pair written in one class string,
 * in both themes, on the page canvas, a panel and a raised surface, with the
 * interpolated Chip classes expanded to what they render. A new failing pair
 * fails the suite; so does an allowlist entry that no longer matches.
 *
 * What it cannot see: a tint on a parent with the coloured text on a child,
 * and a pair split across two strings. Text size is not read either, so a
 * pair on large text (18px and up) that fails 4.5:1 needs an allowlist entry
 * saying so.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHIP_TONE_CLASSES, type ChipTone } from "@/app/dashboard/components/Chip";
import { CHIP_TONE_TEXT } from "@/app/dashboard/components/chip-tone-text";
import { scanTintPairs, worstRatio, THEMES } from "@/tests/helpers/tint-pair-scan";

const FLOOR = 4.5;
const DARK_PREFIX = "[[data-theme=dark]_&]:";

/** Failing pairs that stay, each with the reason. Key: "<file> | <bg> <text>". */
const ALLOWLIST: Record<string, string> = {
  "app/dashboard/components/DataConfidenceIndicator.tsx | bg-down/20 text-down":
    "A code comment describing the old pair, not a class string.",
};

/** Files the scan leaves alone. */
const SKIP = new Set([
  // The checked table itself; tests/dashboard/chip-contrast-nowrap.test.tsx pins it.
  "app/dashboard/components/Chip.tsx",
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Replaces `${CHIP_TONE_CLASSES.up}` and `${CHIP_TONE_TEXT.up}` with the classes they render. */
function expandChipClasses(src: string): string {
  return src.replace(/\$\{CHIP_TONE_(CLASSES|TEXT)\.([a-z]+)\}/g, (whole, table, tone) => {
    const source = table === "CLASSES" ? CHIP_TONE_CLASSES : CHIP_TONE_TEXT;
    return source[tone as ChipTone] ?? whole;
  });
}

type Failure = { id: string; where: string; light: number; dark: number };

function failuresIn(file: string, src: string): Failure[] {
  return scanTintPairs(expandChipClasses(src))
    .pairs.filter((p) => p.light < FLOOR || p.dark < FLOOR)
    .map((p) => ({
      id: `${file} | ${p.key}`,
      where: `${file}:${p.line}`,
      light: p.light,
      dark: p.dark,
    }));
}

const FILES = walk("app").filter((f) => !SKIP.has(f));
const FAILURES = FILES.flatMap((f) => failuresIn(f, readFileSync(f, "utf8")));

describe("the scan is sound", () => {
  it("flags the old hand-written pairs", () => {
    const src = [
      'const a = "px-2 bg-up/20 text-up";',
      'const b = ok ? "bg-down/20 text-down" : "bg-gold/15 text-gold-ink";',
      "const c = `rounded ${on ? \"text-gold bg-gold/10\" : \"\"}`;",
    ].join("\n");
    const found = failuresIn("x.tsx", src).map((f) => f.id);
    expect(found).toEqual([
      "x.tsx | bg-up/20 text-up",
      "x.tsx | bg-down/20 text-down",
      "x.tsx | bg-gold/15 text-gold-ink",
      "x.tsx | bg-gold/10 text-gold",
    ]);
  });

  it("flags a pair that passes in the light theme and fails in the dark one", () => {
    const src =
      'const sell = "bg-down/20 text-[color:color-mix(in_srgb,var(--down)_80%,black)] [[data-theme=dark]_&]:text-down";';
    const [f] = failuresIn("x.tsx", src);
    expect(f.light).toBeGreaterThanOrEqual(FLOOR);
    expect(f.dark).toBeLessThan(FLOOR);
  });

  it("passes the same pairs once they take the Chip classes", () => {
    const src = [
      "const a = `px-2 ${CHIP_TONE_CLASSES.up}`;",
      "const b = `bg-gold/15 ${CHIP_TONE_TEXT.gold} hover:bg-gold/25`;",
      "const c = `bg-down/10 border border-down/30 ${CHIP_TONE_TEXT.down}`;",
    ].join("\n");
    expect(scanTintPairs(expandChipClasses(src)).pairs).toHaveLength(3);
    expect(failuresIn("x.tsx", src)).toEqual([]);
  });

  it("ignores hover-only tints and neutral surfaces", () => {
    const src = 'const a = "text-up hover:bg-up/20"; const b = "bg-raised/50 text-up";';
    expect(scanTintPairs(src).pairs).toEqual([]);
  });

  it("walks a real tree", () => {
    expect(FILES.length).toBeGreaterThan(200);
  });
});

describe("CHIP_TONE_TEXT: the Chip text colours on a tint the element keeps", () => {
  it("is the Chip tone minus its background", () => {
    for (const tone of Object.keys(CHIP_TONE_CLASSES) as ChipTone[]) {
      const text = CHIP_TONE_TEXT[tone].split(/\s+/);
      expect(text.some((c) => c.startsWith("bg-")), tone).toBe(false);
      expect(CHIP_TONE_CLASSES[tone].split(/\s+/).filter((c) => !c.startsWith("bg-"))).toEqual(text);
    }
  });

  // 25% is the strongest tint in use (the A, C and F trade grades). At 30%
  // green and red drop under the floor, so a 30% tint must not take these.
  const CASES = (["up", "down", "gold"] as const).flatMap((tone) =>
    [5, 10, 15, 20, 25].flatMap((pct) => THEMES.map((theme) => [tone, pct, theme] as const)),
  );
  it.each(CASES)("%s text on a %i%% tint, %s theme", (tone, pct, theme) => {
    const classes = CHIP_TONE_TEXT[tone].split(/\s+/);
    const dark = classes.find((c) => c.startsWith(DARK_PREFIX));
    const base = classes.find((c) => c.startsWith("text-"));
    const text = theme === "dark" && dark ? dark.slice(DARK_PREFIX.length) : base;
    if (!text) throw new Error(`${tone}: no text utility`);
    expect(worstRatio(theme, `bg-${tone}/${pct}`, text)).toBeGreaterThanOrEqual(FLOOR);
  });

  it("green and red really do fail on a 30% tint (the bound above is real)", () => {
    const up = CHIP_TONE_TEXT.up.split(/\s+/).find((c) => c.startsWith("text-"));
    const down = CHIP_TONE_TEXT.down.split(/\s+/).find((c) => c.startsWith("text-"));
    expect(worstRatio("light", "bg-up/30", up ?? "")).toBeLessThan(FLOOR);
    expect(worstRatio("light", "bg-down/30", down ?? "")).toBeLessThan(FLOOR);
  });
});

describe("app/: no hand-written tint pair under 4.5:1", () => {
  it("every failing pair is on the allowlist", () => {
    const unexpected = FAILURES.filter((f) => !(f.id in ALLOWLIST)).map(
      (f) =>
        `${f.where} [${f.id.split(" | ")[1]}] light ${f.light.toFixed(2)}, dark ${f.dark.toFixed(2)}: ` +
        "use CHIP_TONE_CLASSES.<tone> (app/dashboard/components/Chip.tsx), or CHIP_TONE_TEXT.<tone> to keep the tint",
    );
    expect(unexpected).toEqual([]);
  });

  it("every allowlist entry still matches a failing pair", () => {
    const live = new Set(FAILURES.map((f) => f.id));
    const stale = Object.keys(ALLOWLIST).filter((id) => !live.has(id));
    expect(stale).toEqual([]);
  });

  it("every allowlist entry carries a reason", () => {
    for (const [id, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, id).toBeGreaterThan(20);
    }
  });
});

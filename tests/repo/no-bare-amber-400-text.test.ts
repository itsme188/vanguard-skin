import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Guard: a bare `text-amber-300/400/500` is near-invisible on the light cream theme
 * (fails the 4.5:1 rule). Use the theme-aware `text-warn` token instead.
 * Only the `dark:`-prefixed form (`dark:text-amber-400`) is allowed; any other
 * variant (`hover:`, `md:`, `group-hover:` ...) still shows on the light theme.
 */
const AMBER_TOKEN_RE = /[^\s"'`{}()]*text-amber-(?:300|400|500)\b/g;

/** True when a line uses text-amber-300/400/500 outside a `dark:`-led class. */
export function hasBareAmber(line: string): boolean {
  for (const m of line.matchAll(AMBER_TOKEN_RE)) {
    const tok = m[0];
    if (/[\w-]text-amber/.test(tok)) continue; // e.g. bg-text-amber: not the utility
    if (!tok.startsWith("dark:")) return true;
  }
  return false;
}
const REPO = path.resolve(__dirname, "../..");
// UI classes live in app/ and in JSX components under lib/ (e.g. lib/privacy).
const SCAN_ROOTS = ["app", "lib"].map((d) => path.join(REPO, d));
// Files with a pre-existing bare amber class: "pre-existing, sprint 2026-10-07".
// None found when the scan was widened to lib/; add entries here with that note.
const ALLOWLIST: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("bare-amber regex self-test", () => {
  it.each([
    ["text-amber-400", true],
    ['className="text-amber-500"', true],
    ["hover:text-amber-400", true],
    ["md:text-amber-300", true],
    ["group-hover:text-amber-400", true],
    ["dark:hover:text-amber-400", false],
    ["dark:text-amber-400", false],
    ["text-warn", false],
    ["text-amber-600", false],
    ["bg-text-amber-400", false],
  ])("%s -> flagged=%s", (line, flagged) => {
    expect(hasBareAmber(line)).toBe(flagged);
  });
});

describe("no bare text-amber-300/400/500", () => {
  it("uses text-warn instead of a bare text-amber-300/400/500 in app/**/*.tsx and lib/**/*.tsx", () => {
    const offenders: string[] = [];
    for (const file of SCAN_ROOTS.flatMap((r) => walk(r))) {
      if (ALLOWLIST.includes(path.relative(REPO, file))) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (hasBareAmber(line)) {
            offenders.push(`${path.relative(REPO, file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(
      offenders,
      `Bare text-amber-300/400/500 is unreadable on the light theme. Use text-warn (theme-aware --warn token) instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Guard: a bare `text-amber-400` is near-invisible on the light cream theme
 * (fails the 4.5:1 rule). Use the theme-aware `text-warn` token instead.
 * Variant-prefixed forms (`dark:text-amber-400`) are allowed.
 */
const ROOT = path.resolve(__dirname, "../../app");

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

describe("no bare text-amber-400", () => {
  it("uses text-warn instead of a bare text-amber-400 in app/**/*.tsx", () => {
    const offenders: string[] = [];
    const re = /(^|[^:\w-])text-amber-400/;
    for (const file of walk(ROOT)) {
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (re.test(line)) {
            offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(
      offenders,
      `Bare text-amber-400 is unreadable on the light theme. Use text-warn (theme-aware --warn token) instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

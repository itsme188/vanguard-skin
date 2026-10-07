/**
 * The pre-release actual helper (lib/calendar/pre-release-actual.ts) is a
 * DISPLAY-ONLY gate: it decides whether a screen shows a stored actual as
 * muted "pre-release". It must never become a send, recap, enrichment or write
 * gate (those stay on checkPrePrintFloor).
 *
 * This test keeps it that way: only files under app/** may import it. A gate,
 * sweep, email composer, script or workers/ file that starts importing it
 * fails here.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..", "..");
const MODULE = "pre-release-actual";

const ROOTS: Array<[string, RegExp]> = [
  ["lib", /\.(ts|tsx)$/],
  ["app", /\.(ts|tsx)$/],
  ["scripts", /\.(ts|js|mjs)$/],
  ["electron", /\.(ts|js)$/],
  ["workers", /\.(ts|tsx|js)$/],
];

function walk(dir: string, re: RegExp, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, re, out);
    else if (re.test(e.name)) out.push(p);
  }
}

function importers(): string[] {
  const files: string[] = [];
  for (const [root, re] of ROOTS) walk(path.join(REPO, root), re, files);
  const importRe = new RegExp(`(?:from|import|require)\\s*\\(?\\s*["'][^"']*${MODULE}["']`);
  return files
    .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
    .filter((rel) => rel !== `lib/calendar/${MODULE}.ts`)
    .filter((rel) => importRe.test(fs.readFileSync(path.join(REPO, rel), "utf-8")))
    .sort();
}

describe("pre-release-actual is imported by display surfaces only", () => {
  const found = importers();

  it("has importers at all (the scan is not silently empty)", () => {
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((f) => f.startsWith("app/"))).toBe(true);
  });

  it("every importer is under app/**", () => {
    const offenders = found.filter((f) => !f.startsWith("app/"));
    expect(offenders).toEqual([]);
  });
});

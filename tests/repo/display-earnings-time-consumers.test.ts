/**
 * User ruling 2026-10-06, "Option A, display only": the usual-time / "time
 * unknown" label for a slot-less vendor earnings row is for SCREENS. The
 * stored release_time keeps driving every gate (pre-print floor, enrichment
 * window, recap floor, email sweep, print-watch, the Worker).
 *
 * This test keeps it that way: the display helper may be imported only by
 * files under app/** and by the one query allowlisted below. A gate, cron,
 * email composer or Worker file that starts importing it fails here — an
 * estimate must never become evidence that a print has happened.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..", "..");
const MODULE = "display-earnings-time";

/** Non-app importers, each with the reason it is display-only. */
const ALLOWLIST = new Set<string>([
  // getTodayReleases attaches `display_time` AFTER selecting and ordering on
  // the stored release_time; its only caller is the Today page.
  "lib/queries/calendar.ts",
]);

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

describe("display-earnings-time is imported by display surfaces only", () => {
  const found = importers();

  it("has importers at all (the scan is not silently empty)", () => {
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain("lib/queries/calendar.ts");
  });

  it("every importer is under app/** or allowlisted", () => {
    const offenders = found.filter((f) => !f.startsWith("app/") && !ALLOWLIST.has(f));
    expect(offenders).toEqual([]);
  });

  it("the allowlist carries no stale entry", () => {
    for (const f of ALLOWLIST) expect(found).toContain(f);
  });

  it("the display labels are not re-exported for a gate to pick up elsewhere", () => {
    const files: string[] = [];
    for (const [root, re] of ROOTS) {
      if (root !== "app") walk(path.join(REPO, root), re, files);
    }
    const leaks = files
      .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
      .filter((rel) => rel !== `lib/calendar/${MODULE}.ts` && !ALLOWLIST.has(rel))
      .filter((rel) =>
        /\b(displayEarningsTime|withDisplayTimes|isDefaultedEarningsTime)\b/.test(
          fs.readFileSync(path.join(REPO, rel), "utf-8"),
        ),
      );
    expect(leaks).toEqual([]);
  });
});

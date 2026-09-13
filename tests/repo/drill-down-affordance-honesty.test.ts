/**
 * QA finding
 * analysis-classification--account-and-credit-rating-rows-advertise-drill-down-but-no-op:
 * the Analysis > Diagnostics > Classification breakdown table rendered every
 * row with `cursor-pointer`, a hover highlight and `title="Click to drill
 * down"` even for dimensions (`account`, `credit_rating`) that
 * lib/queries/drill-down.ts's `getHoldingsInBucket` cannot actually filter
 * on — clicking those rows was a silent no-op.
 *
 * The fix single-sources the drillable-dimension allowlist in the pure
 * module lib/analysis/drillable-dimensions.ts (no DB import, so the client
 * component AnalysisView.tsx can import it directly) and makes both
 * lib/queries/drill-down.ts and AnalysisView.tsx read from it, instead of
 * each hand-rolling its own copy of the list.
 *
 * This is a static source-pin, not a DOM test (no jsdom/RTL in this repo —
 * see docs/reference: "No DOM test harness"). It fails on the pre-fix
 * source: drill-down.ts had its own private `ALLOWED_CLASSIFICATION_DIMENSIONS`
 * array, and AnalysisView.tsx rendered `title="Click to drill down"` as a
 * static (unconditional) JSX attribute on every breakdown row.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..", "..");

const PURE_MODULE_IMPORT_PATH = "@/lib/analysis/drillable-dimensions";

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO, relPath), "utf-8");
}

describe("drill-down affordance honesty (single-sourced drillable-dimension list)", () => {
  it("lib/analysis/drillable-dimensions.ts exists and is a pure module (no DB import)", () => {
    const src = read("lib/analysis/drillable-dimensions.ts");
    expect(src).toMatch(/export const DRILLABLE_CLASSIFICATION_DIMENSIONS/);
    expect(src).toMatch(/export function isDrillableDimension/);
    // Pure: never imports better-sqlite3, the db singleton, or any
    // lib/queries/* module (that would defeat the whole point of factoring
    // this out for the client component to import safely).
    expect(src).not.toMatch(/from ["']better-sqlite3["']/);
    expect(src).not.toMatch(/from ["']@\/lib\/db["']/);
    expect(src).not.toMatch(/from ["']@\/lib\/queries\//);
  });

  it("lib/queries/drill-down.ts imports the shared allowlist instead of hand-rolling its own", () => {
    const src = read("lib/queries/drill-down.ts");
    expect(src).toContain(PURE_MODULE_IMPORT_PATH);
    // The old private copy must be gone, not just supplemented.
    expect(src).not.toMatch(/const ALLOWED_CLASSIFICATION_DIMENSIONS/);
  });

  it("AnalysisView.tsx imports the shared allowlist instead of hand-rolling its own", () => {
    const src = read("app/dashboard/components/AnalysisView.tsx");
    expect(src).toContain(PURE_MODULE_IMPORT_PATH);
    // The old private copy (DRILL_SUPPORTED_DIMENSIONS) must be gone.
    expect(src).not.toMatch(/DRILL_SUPPORTED_DIMENSIONS/);
    // And it must import the predicate/list as a runtime value (not just a
    // type), never a runtime binding from a lib/queries/* module — that
    // would pull server-only (DB) code into the client bundle.
    const importBlockMatch = src.match(
      /import\s*\{[^}]*\}\s*from\s*["']@\/lib\/analysis\/drillable-dimensions["']/
    );
    expect(importBlockMatch).not.toBeNull();
    expect(importBlockMatch![0]).toMatch(/isDrillableDimension/);
  });

  it("AnalysisView.tsx never imports a runtime (non-type) binding from lib/queries/*", () => {
    const src = read("app/dashboard/components/AnalysisView.tsx");
    // Every import whose specifier is a lib/queries/* module must be a
    // `import type {...}` form (erased at compile time, so it never reaches
    // the client bundle). A plain `import {...}` would pull server-only
    // (DB-touching) code into a "use client" component.
    const importRe = /import\s+(type\s+)?\{[^}]*\}\s*from\s*["']@\/lib\/queries\/[^"']+["']/g;
    const matches = [...src.matchAll(importRe)];
    expect(matches.length).toBeGreaterThan(0); // sanity: the file does reference lib/queries/* types
    for (const m of matches) {
      expect(m[1], `non-type import of lib/queries/* found: ${m[0]}`).toBe("type ");
    }
  });

  it('does not hard-code "Click to drill down" as an unconditional JSX attribute', () => {
    const src = read("app/dashboard/components/AnalysisView.tsx");
    expect(src).toContain("Click to drill down");
    // Pre-fix source had the literal static attribute form
    // `title="Click to drill down"` — every row got the affordance
    // regardless of whether the current dimension is drillable. Post-fix,
    // the string must only appear inside a conditional expression
    // (`title={condition ? "Click to drill down" : undefined}` or
    // equivalent), never as a bare double-quoted JSX attribute value.
    expect(src).not.toMatch(/title="Click to drill down"/);
  });

  it("the breakdown row's cursor-pointer/hover affordance is gated on drillability, not applied unconditionally", () => {
    const src = read("app/dashboard/components/AnalysisView.tsx");
    // Pre-fix: a single static className string baked cursor-pointer and
    // the hover highlight into every row regardless of dimension.
    expect(src).not.toMatch(
      /className="border-b border-edge\/50 hover:bg-raised\/50 cursor-pointer"/
    );
  });
});

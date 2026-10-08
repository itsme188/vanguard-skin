/**
 * The bond-duration-coverage copy in TrustStripDrawer must never assert a
 * cause the code doesn't implement, and must never name an internal script
 * path or filename in user-facing text.
 *
 * Landing-review finding on PR #64 (merged f023761b): the previous copy
 * ("Importing a statement that carries the maturity date fills them in")
 * was factually wrong — `securities.duration_years` has exactly one writer,
 * `scripts/backfill-bond-durations.ts`. Imports auto-derive `maturity_date`
 * from the bond name (lib/mutations/securities.ts) but never write
 * `duration_years`. Importing a statement cannot move the n/N counter.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const SRC_PATH = "app/dashboard/components/analysis/TrustStripDrawer.tsx";

function extractBondDurationContent(src: string): string {
  const start = anchorIndex(src, "function BondDurationContent");
  expect(start).toBeGreaterThan(-1);
  // Next top-level function declaration marks the end of this component's
  // body — there are no nested `function` declarations inside it.
  const nextPlain = src.indexOf("\nfunction ", start + 1);
  const nextExported = src.indexOf("\nexport function ", start + 1);
  const candidates = [nextPlain, nextExported].filter((i) => i !== -1);
  expect(candidates.length).toBeGreaterThan(0);
  const end = Math.min(...candidates);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("TrustStripDrawer bond-duration-coverage copy (2026-09-06 correction)", () => {
  const src = readFileSync(SRC_PATH, "utf8");
  // Scoped to the component's own body — the surrounding file legitimately
  // references other source files (e.g. analysis-trust-state.ts) in doc
  // comments elsewhere, which isn't what this test is guarding against.
  const block = extractBondDurationContent(src);

  it("never names a script path in user-facing copy", () => {
    expect(block).not.toMatch(/scripts\//);
  });

  it("never names a .ts filename in user-facing copy", () => {
    expect(block).not.toMatch(/\.ts\b/);
  });

  it("drops the false 'importing a statement fills them in' claim", () => {
    expect(block).not.toContain("Importing a statement");
  });

  it("states the true mechanism: a maintenance step, not import", () => {
    expect(block).toContain("maintenance step");
  });
});

// ─── 2026-10-07: owner-language copy, ET stamps, named bonds ────────────────
// qa:analysis-trust-drawers--developer-instructions-script-paths-component-names
// qa:analysis-trust-strip--last-classify-stale-after-run
// qa:analysis-trust-strip--bond-duration-drawer-names-no-bonds
// qa:analysis-trust-strip--last-classify-drawer-utc-contradicts-chip-regression-1

const STRIP_PATH = "app/dashboard/components/analysis/TrustStrip.tsx";

/** Body of one top-level function in the drawer file. */
function extractFunction(src: string, name: string): string {
  const start = anchorIndex(src, `function ${name}`);
  const nextPlain = src.indexOf("\nfunction ", start + 1);
  const nextExported = src.indexOf("\nexport function ", start + 1);
  const nextConst = src.indexOf("\nconst ", start + 1);
  const candidates = [nextPlain, nextExported, nextConst].filter((i) => i !== -1);
  expect(candidates.length).toBeGreaterThan(0);
  return src.slice(start, Math.min(...candidates));
}

describe("Trust strip: the factor-ratings date cell says what it measures", () => {
  const drawer = readFileSync(SRC_PATH, "utf8");
  const strip = readFileSync(STRIP_PATH, "utf8");
  const block = extractFunction(drawer, "LastClassifyContent");

  it("names no React component or source file", () => {
    expect(block).not.toContain("AnalysisView");
    expect(block).not.toMatch(/\.tsx?\b/);
    expect(block).not.toMatch(/scripts\//);
  });

  it("names the two buttons that do move the date, as the owner sees them", () => {
    // The drawer button on this strip and the Diagnostics card button.
    anchorIndex(block, "Classify N missing");
    anchorIndex(block, "Auto-Classify Factors");
    anchorIndex(block, "Factor Exposure");
  });

  it("says the sector Auto-Classify button does not move the date", () => {
    // The date is MAX(security_factors.updated_at); the sector run on
    // Diagnostics > Classification never writes that table.
    anchorIndex(block, "does not move this date");
    anchorIndex(block, "Classification");
  });

  it("does not call the date a classification run, in the cell or the drawer", () => {
    expect(block).not.toContain("classification run");
    expect(strip).not.toContain('label="Last classify"');
    expect(drawer).not.toContain('lastClassify: "Last Classification"');
    anchorIndex(strip, 'label="Factors updated"');
  });

  it("prints the stored UTC stamp as Eastern time with a zone label, in the drawer and the cell tooltip", () => {
    anchorIndex(block, "formatEnrichedAtET(ts)");
    expect(block).not.toMatch(/\$\{ts\}/);
    anchorIndex(strip, "formatEnrichedAtET(lastClassification)");
    expect(strip).not.toContain("hint={lastClassification ??");
  });
});

describe("Trust strip: bond-duration copy names the bonds and no database column", () => {
  const drawer = readFileSync(SRC_PATH, "utf8");
  const strip = readFileSync(STRIP_PATH, "utf8");
  const block = extractBondDurationContent(drawer);

  it("lists the bonds that have no duration, each linked to its page", () => {
    anchorIndex(block, "bondDuration.missing.map");
    anchorIndex(block, "<SymbolLink");
  });

  it("no longer says 'These bonds' with nothing to point at", () => {
    expect(block).not.toContain("These\n");
    expect(block).not.toMatch(/These\s+bonds/);
  });

  it("the cell tooltip names no database column", () => {
    expect(strip).not.toContain("duration_years");
  });
});

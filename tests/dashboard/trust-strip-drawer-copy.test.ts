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

const SRC_PATH = "app/dashboard/components/analysis/TrustStripDrawer.tsx";

function extractBondDurationContent(src: string): string {
  const start = src.indexOf("function BondDurationContent");
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

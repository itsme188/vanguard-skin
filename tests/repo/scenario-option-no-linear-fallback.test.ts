import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex } from "../helpers/source-anchor";

/**
 * The scenario path never estimates an option from a fixed figure (spec
 * 2026-10-06, D4): no linear elasticity, no 2.5 fallback, no 30% volatility
 * default. An option that cannot be priced is unmodelled.
 */
const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("scenario engines reprice options and never fall back to a fixed figure", () => {
  for (const file of ["lib/compute/scenarios.ts", "lib/compute/scenario-recipes.ts"]) {
    it(`${file} calls the shared repricing function and no linear helper`, () => {
      const src = read(file);
      anchorIndex(src, "repriceOptionUnderShock(");
      expect(src).not.toContain("optionElasticity(");
      expect(src).not.toContain("leverUnderlyingMoveByElasticity(");
    });
  }
  it("the repricing module has no volatility or elasticity default", () => {
    const src = read("lib/compute/option-reprice.ts");
    anchorIndex(src, 'reason: "no-volatility"');
    expect(src).not.toContain("DEFAULT_OPTION_ELASTICITY");
    expect(src).not.toMatch(/\?\?\s*0\.30?\b/);
  });
  it("no scenario-facing copy still describes the linear treatment", () => {
    // Task 5 adds "app/dashboard/components/ScenarioModeling.tsx" to this list when it rewrites that file.
    for (const file of ["lib/compute/scenario-recipes.ts"]) {
      const src = read(file);
      expect(src, file).not.toMatch(/delta elasticity/i);
      expect(src, file).not.toMatch(/fallback 2\.5/i);
      expect(src, file).not.toContain("Δ·S/V");
    }
  });

  it("the linear helpers are gone from the shared module", () => {
    const src = read("lib/compute/option-elasticity.ts");
    expect(src).not.toContain("export function optionElasticity");
    expect(src).not.toContain("export function leverUnderlyingMoveByElasticity");
  });
});

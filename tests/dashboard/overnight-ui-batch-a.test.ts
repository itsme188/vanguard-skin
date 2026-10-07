/**
 * Source-pin tests for the 2026-10-05 overnight small-UI batch (items 1-4).
 * No DOM harness in this repo: read the sources as text.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("ChatDrawer collapse moves focus out of the inert rail", () => {
  const src = read("app/dashboard/components/ChatDrawer.tsx");
  it("collapse button uses collapseRail, not a bare setCollapsed(true)", () => {
    expect(src).toContain("onClick={collapseRail}");
    expect(src).not.toContain("onClick={() => setCollapsed(true)}");
  });
  it("collapseRail focuses the re-open toggle (fallback main)", () => {
    const fn = src.slice(src.indexOf("const collapseRail"), src.indexOf("const toggle = useCallback"));
    expect(fn).toContain("setCollapsed(true)");
    expect(fn).toContain('button[aria-label="Toggle chat assistant"]');
    expect(fn).toContain('"main"');
    expect(fn).toContain(".focus()");
  });
  it("focus moves BEFORE the collapse state change hides the rail", () => {
    const fn = src.slice(src.indexOf("const collapseRail"), src.indexOf("const toggle = useCallback"));
    const firstFocus = fn.indexOf(".focus()");
    const collapse = fn.indexOf("setCollapsed(true)");
    expect(firstFocus).toBeGreaterThan(-1);
    expect(firstFocus).toBeLessThan(collapse);
  });
});

describe("DrillDownPanel risk sort scope", () => {
  const src = read("app/dashboard/components/analysis/DrillDownPanel.tsx");
  it("risk drawer uses its own sort scope so a persisted ?drillSort cannot defeat the default", () => {
    expect(src).toMatch(/useSortParam<SortField>\(\s*isRisk \? "drillRisk" : "drill",\s*isRisk \? "risk" : "marketValue"/);
  });
});

describe("FactorAnalysis beta tile", () => {
  const src = read("app/dashboard/components/FactorAnalysis.tsx");
  it("goes neutral below the confidence gate, reusing betaConfidenceVerdict", () => {
    expect(src).toContain('from "@/lib/compute/beta-confidence"');
    expect(src).toMatch(/!betaConfidenceVerdict\(\{ rSquared: reg\.rSquared, pairs: reg\.dataPoints \}\)\.ok\s*\?\s*"neutral"/);
  });
});

describe("Custom scenario option disclosure", () => {
  const src = read("app/dashboard/components/ScenarioModeling.tsx");
  // Options have been repriced since 2026-10-06, so the old linear
  // (delta only) disclosure under the Compute button is false and is gone.
  it("no longer says options are approximated linearly, and says they are repriced", () => {
    expect(src).not.toMatch(/approximated\s+linearly/i);
    expect(src).not.toMatch(/delta only/i);
    expect(src).toContain("Options are repriced at the shocked price of their underlying");
  });
});

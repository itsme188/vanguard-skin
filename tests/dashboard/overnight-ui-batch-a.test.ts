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

describe("Custom scenario linear-option disclosure", () => {
  const src = read("app/dashboard/components/ScenarioModeling.tsx");
  it("states options are approximated linearly (delta only)", () => {
    expect(src).toContain("Option positions are approximated linearly (delta only)");
  });
});

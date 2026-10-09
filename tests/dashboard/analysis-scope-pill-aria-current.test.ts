import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The selected scope pill used to be marked by styling alone. These pills are
// links, so the selected one carries aria-current.
describe("Analysis scope pills mark the selected pill", () => {
  const page = readFileSync("app/dashboard/analysis/page.tsx", "utf8");
  const perf = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");
  const diag = readFileSync("app/dashboard/components/AnalysisView.tsx", "utf8");

  it("Workspace and Defense pills (page.tsx) carry aria-current", () => {
    expect(page).toContain('aria-current={scope === s.key ? "true" : undefined}');
    expect(page).toContain('aria-current={active === s.key ? "true" : undefined}');
  });

  it("Performance pills carry aria-current", () => {
    expect(perf).toContain('aria-current={activeScope === s.key ? "true" : undefined}');
  });

  it("Diagnostics pills keep their aria-pressed (they are buttons)", () => {
    expect(diag).toContain("aria-pressed={opt.value === currentScope}");
  });
});

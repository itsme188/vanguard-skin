import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import {
  DEFAULT_ANALYSIS_SCOPE,
  resolveAnalysisScope,
} from "@/lib/analysis/view-param";

// Owner ruling 2026-11-15 ("vanguard everywhere"): every Analysis sub-view
// that takes a scope opens on Vanguard when the URL carries no ?scope=. The
// default is ONE constant, resolved in page.tsx and passed down explicitly,
// so no component's own fallback (PerformanceView / DefenseView default to
// "all") is ever reached from the page.

describe("resolveAnalysisScope", () => {
  it("defaults to Vanguard", () => {
    expect(DEFAULT_ANALYSIS_SCOPE).toBe("vanguard");
    expect(resolveAnalysisScope(undefined)).toBe("vanguard");
    expect(resolveAnalysisScope("")).toBe("vanguard");
  });

  it("an unknown scope falls back to the default", () => {
    expect(resolveAnalysisScope("nope")).toBe("vanguard");
    expect(resolveAnalysisScope("ALL")).toBe("vanguard");
  });

  it("an explicit scope is kept, all included", () => {
    expect(resolveAnalysisScope("all")).toBe("all");
    expect(resolveAnalysisScope("ibkr")).toBe("ibkr");
    expect(resolveAnalysisScope("roth")).toBe("roth");
    expect(resolveAnalysisScope("vanguard")).toBe("vanguard");
  });
});

const src = readFileSync(join(process.cwd(), "app/dashboard/analysis/page.tsx"), "utf8");

function branch(view: string): string {
  const start = anchorIndex(src, `resolved.view === "${view}"`);
  const end = src.indexOf("resolved.view ===", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("Analysis page resolves the scope once", () => {
  it("every scoped branch reads the one resolver, never its own default", () => {
    expect(src).toContain("resolveAnalysisScope(params.scope)");
    expect(src).not.toMatch(/:\s*"vanguard";/);
    expect(src).not.toMatch(/:\s*"all";/);
  });

  it("Performance gets the resolved scope, not the raw param", () => {
    const b = branch("performance");
    expect(b).toContain("<PerformanceView scope={scope}");
    expect(b).not.toContain("<PerformanceView scope={params.scope}");
  });

  it("Defense gets the resolved scope and its pills highlight it", () => {
    const b = branch("defense");
    expect(b).toContain("<DefenseView scope={scope}");
    expect(b).toContain("<DefenseScopePills active={scope}");
  });

  it("the scope is resolved before the first scoped branch", () => {
    expect(anchorIndex(src, "resolveAnalysisScope(params.scope)")).toBeLessThan(
      anchorIndex(src, 'resolved.view === "performance"'),
    );
  });

  it("Trade Reviews keeps its IBKR preselect for no scope (not changed by the ruling)", () => {
    const b = branch("trade-reviews");
    expect(b).toContain("resolveAccountIds(params.scope as AccountScope)");
    expect(b).toContain("ibkr?.id");
  });
});

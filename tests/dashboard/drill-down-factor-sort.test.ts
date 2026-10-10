/**
 * QA finding: [qa:dashboard-analysis-view-diagnostics-scope-all-view-top-10-by-risk-drawer-and-the-sector-drill-down-drawer-same]
 * The drill-down AI and Reg columns sorted the raw factor text, so a
 * descending sort gave "Very High > Moderate > Low > High". They now sort by
 * FACTOR_SORT_RANK (the heatmap's table); a missing value is null (last).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FACTOR_SORT_RANK } from "@/lib/factors";
import { compareValues } from "@/lib/hooks/useSortParam";
import { anchorIndex } from "@/tests/helpers/source-anchor";

describe("drill-down factor ordinal sort", () => {
  const rank = (v: string | null) => FACTOR_SORT_RANK[v ?? ""] ?? null;

  it("sorts descending Very High > High > Moderate > Low > No, missing last", () => {
    const vals = ["Low", "Very High", null, "No", "High", "Moderate"];
    const desc = [...vals].sort((a, b) => compareValues(rank(a), rank(b), "desc"));
    expect(desc).toEqual(["Very High", "High", "Moderate", "Low", "No", null]);
    const asc = [...vals].sort((a, b) => compareValues(rank(a), rank(b), "asc"));
    expect(asc).toEqual(["No", "Low", "Moderate", "High", "Very High", null]);
  });
});

describe("DrillDownPanel sortValue uses the shared rank table", () => {
  const source = readFileSync(
    path.join(process.cwd(), "app/dashboard/components/analysis/DrillDownPanel.tsx"),
    "utf8",
  );
  it("imports FACTOR_SORT_RANK from lib/factors", () => {
    expect(source).toMatch(/import\s*\{\s*FACTOR_SORT_RANK\s*\}\s*from\s*["']@\/lib\/factors["']/);
  });
  it("ai and reg cases read FACTOR_SORT_RANK", () => {
    const start = anchorIndex(source, "function sortValue");
    const ai = anchorIndex(source, 'case "ai":', start);
    const reg = anchorIndex(source, 'case "reg":', ai);
    const beta = anchorIndex(source, 'case "beta":', reg);
    expect(source.slice(ai, reg)).toContain("FACTOR_SORT_RANK[row.factors.ai_exposure");
    expect(source.slice(reg, beta)).toContain("FACTOR_SORT_RANK[row.factors.regulatory_risk");
  });
});

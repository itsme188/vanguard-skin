/**
 * QA finding: [qa:dashboard-analysis-view-diagnostics-scope-all-view-top-10-by-risk-drawer-and-the-sector-drill-down-drawer-same]
 * The drill-down AI and Reg columns sorted the raw factor text, so a
 * descending sort gave "Very High > Moderate > Low > High". They now sort
 * by ordinal rank; an unknown or missing value is null (sorts last).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { factorOrdinalRank } from "@/lib/factor-ordinal";
import { compareValues } from "@/lib/hooks/useSortParam";
import { anchorIndex } from "@/tests/helpers/source-anchor";

describe("factorOrdinalRank", () => {
  it("orders Very High > High > Moderate > Low > No", () => {
    const r = ["Very High", "High", "Moderate", "Low", "No"].map(factorOrdinalRank);
    expect(r).toEqual([4, 3, 2, 1, 0]);
  });
  it("is case-insensitive and accepts aliases", () => {
    expect(factorOrdinalRank("VERY HIGH")).toBe(4);
    expect(factorOrdinalRank(" medium ")).toBe(2);
    expect(factorOrdinalRank("None")).toBe(0);
  });
  it("returns null for unknown or missing values", () => {
    expect(factorOrdinalRank("Banana")).toBeNull();
    expect(factorOrdinalRank("")).toBeNull();
    expect(factorOrdinalRank(null)).toBeNull();
    expect(factorOrdinalRank(undefined)).toBeNull();
  });
  it("sorts descending in ordinal order with unknown last", () => {
    const vals = ["Low", "Very High", null, "High", "Moderate"];
    const sorted = [...vals].sort((a, b) =>
      compareValues(factorOrdinalRank(a), factorOrdinalRank(b), "desc"),
    );
    expect(sorted).toEqual(["Very High", "High", "Moderate", "Low", null]);
  });
});

describe("DrillDownPanel sortValue uses the rank helper", () => {
  const source = readFileSync(
    path.join(process.cwd(), "app/dashboard/components/analysis/DrillDownPanel.tsx"),
    "utf8",
  );
  it("ai and reg cases call factorOrdinalRank", () => {
    const start = anchorIndex(source, "function sortValue");
    const ai = anchorIndex(source, 'case "ai":', start);
    const reg = anchorIndex(source, 'case "reg":', ai);
    expect(source.slice(ai, reg)).toContain("factorOrdinalRank(row.factors.ai_exposure)");
    const beta = anchorIndex(source, 'case "beta":', reg);
    expect(source.slice(reg, beta)).toContain("factorOrdinalRank(row.factors.regulatory_risk)");
  });
});

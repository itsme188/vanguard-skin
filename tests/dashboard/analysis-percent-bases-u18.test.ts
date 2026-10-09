import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PERCENT_BASIS,
  geographyBucketDefinition,
} from "@/lib/analysis/percent-bases";

const read = (p: string) =>
  fs.readFileSync(path.join(process.cwd(), "app/dashboard/components", p), "utf8");

describe("geographyBucketDefinition", () => {
  it("defines the three catch-alls for geography only", () => {
    expect(geographyBucketDefinition("geography", "International")).toMatch(/outside the US/);
    expect(geographyBucketDefinition("geography", "International Developed")).toMatch(/developed/);
    expect(geographyBucketDefinition("geography", "Global")).toMatch(/US and non-US/);
    expect(geographyBucketDefinition("geography", "US")).toBeNull();
    expect(geographyBucketDefinition("geography", "toString")).toBeNull();
  });
  it("never applies to another dimension", () => {
    expect(geographyBucketDefinition("international_exposure", "International")).toBeNull();
    expect(geographyBucketDefinition("sector", "Global")).toBeNull();
  });
});

describe("percent basis labels are wired into each card", () => {
  it("AnalysisView: breakdown headers, caption, geography map gated on dimension", () => {
    const s = read("AnalysisView.tsx");
    expect(s).toContain("PERCENT_BASIS.breakdownCaption");
    expect(s).toContain("PERCENT_BASIS.breakdown");
    expect(s).toMatch(/geographyBucketDefinition\(\s*currentDimension,\s*row\.group_name,?\s*\)/);
    // group_name stays raw for drill-down
    expect(s).toContain("handleClassificationDrill(row.group_name)");
  });
  it("ClassificationCard: concentration caption", () => {
    const s = read("analysis/ClassificationCard.tsx");
    expect(s).toContain("PERCENT_BASIS.concentrationCaption");
  });
  it("RiskMetrics: top-5 caption", () => {
    expect(read("RiskMetrics.tsx")).toContain("PERCENT_BASIS.riskTop5Caption");
  });
  it("FactorHeatmap: weight header title and caption", () => {
    const s = read("FactorHeatmap.tsx");
    expect(s).toContain("PERCENT_BASIS.factorWeightCaption");
    expect(s).toContain("PERCENT_BASIS.factorWeight");
  });
  it("PositionRisk: weight header title and caption", () => {
    const s = read("PositionRisk.tsx");
    expect(s).toContain("PERCENT_BASIS.positionRiskWeightCaption");
    expect(s).toContain("PERCENT_BASIS.positionRiskWeight");
  });
  it("strings are non-empty and distinct per basis", () => {
    expect(PERCENT_BASIS.breakdown).not.toBe(PERCENT_BASIS.concentration);
    expect(PERCENT_BASIS.positionRiskWeight).toMatch(/long/);
  });
});

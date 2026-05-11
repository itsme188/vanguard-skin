import { describe, it, expect } from "vitest";
import { applyThemeAwareBoost } from "@/lib/compute/cash-deploy";
import type { SectorGap } from "@/lib/compute/cash-deploy";

describe("applyThemeAwareBoost", () => {
  const baseGaps: SectorGap[] = [
    { sector: "Technology", currentWeight: 0.20, targetWeight: 0.30, gapPp: -10, dollarGap: -10000, gapClosureScore: 0 },
    { sector: "Healthcare", currentWeight: 0.05, targetWeight: 0.15, gapPp: -10, dollarGap: -10000, gapClosureScore: 0 },
    { sector: "Energy", currentWeight: 0.08, targetWeight: 0.05, gapPp: 3, dollarGap: 3000, gapClosureScore: 0 },
  ];

  it("no boost when activeThemes is empty", () => {
    const r = applyThemeAwareBoost(baseGaps, []);
    expect(r[0].gapClosureScore).toBeCloseTo(10, 5);
    expect(r[1].gapClosureScore).toBeCloseTo(10, 5);
  });

  it("risk-off theme boosts defensive sector gap", () => {
    const r = applyThemeAwareBoost(baseGaps, [
      { name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
        summary: "x", exposure_bucket: "moderate", top_contributors: [] },
    ]);
    const hc = r.find((g) => g.sector === "Healthcare")!;
    const tech = r.find((g) => g.sector === "Technology")!;
    expect(hc.gapClosureScore).toBeGreaterThan(tech.gapClosureScore);
  });

  it("risk-on theme boosts aggressive sector gap", () => {
    const r = applyThemeAwareBoost(baseGaps, [
      { name: "Rate cut hopes", factor_label: "interest_rate_sensitive", direction: "risk-on",
        summary: "x", exposure_bucket: "moderate", top_contributors: [] },
    ]);
    const tech = r.find((g) => g.sector === "Technology")!;
    const hc = r.find((g) => g.sector === "Healthcare")!;
    expect(tech.gapClosureScore).toBeGreaterThan(hc.gapClosureScore);
  });

  it("neutral theme is a no-op", () => {
    const r = applyThemeAwareBoost(baseGaps, [
      { name: "Mixed signals", factor_label: "ai_exposure", direction: "neutral",
        summary: "x", exposure_bucket: "moderate", top_contributors: [] },
    ]);
    expect(r[0].gapClosureScore).toBeCloseTo(10, 5);
  });
});

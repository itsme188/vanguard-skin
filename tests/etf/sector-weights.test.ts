import { describe, it, expect } from "vitest";
import { validateSectorWeights } from "@/lib/etf/sector-weights";

describe("validateSectorWeights", () => {
  it("accepts GICS-mapped weights summing to ~100", () => {
    const r = validateSectorWeights([
      { sector: "Technology", weight_pct: 30 },
      { sector: "Communications", weight_pct: 15 },
      { sector: "Financials", weight_pct: 55 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.weights.find((w) => w.sector === "Communication Services")?.weight_pct).toBeCloseTo(15, 1);
  });
  it("rejects when weights don't sum near 100", () => {
    expect(validateSectorWeights([{ sector: "Technology", weight_pct: 30 }]).ok).toBe(false);
  });
  it("drops unmappable sectors and rejects if the remainder is too small", () => {
    const r = validateSectorWeights([
      { sector: "Technology", weight_pct: 40 },
      { sector: "Klingon", weight_pct: 60 },
    ]);
    expect(r.ok).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { explodeHoldingBySector } from "@/lib/compute/explode-sector";

describe("explodeHoldingBySector", () => {
  const weights = new Map([["VTI", [
    { sector: "Technology", weight_pct: 30 },
    { sector: "Financials", weight_pct: 70 },
  ]]]);
  it("distributes an ETF's MV across sectors by weight", () => {
    expect(explodeHoldingBySector("VTI", "ETF", 1000, weights)).toEqual([
      { sector: "Technology", value: 300 },
      { sector: "Financials", value: 700 },
    ]);
  });
  it("single-buckets a non-ETF, or an ETF without weights", () => {
    expect(explodeHoldingBySector("AAPL", "Stock", 1000, weights, "Technology")).toEqual([{ sector: "Technology", value: 1000 }]);
    expect(explodeHoldingBySector("SCHD", "ETF", 500, weights, "Diversified")).toEqual([{ sector: "Diversified", value: 500 }]);
  });
});

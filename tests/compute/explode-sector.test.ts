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
  it("buckets a bond with no sector as Fixed Income, not Unknown", () => {
    expect(explodeHoldingBySector("912797NS1", "Bond", 48000, weights)).toEqual([{ sector: "Fixed Income", value: 48000 }]);
    // case-insensitive type match, null sector explicitly passed
    expect(explodeHoldingBySector("912797NS1", "bond", 1000, weights, null)).toEqual([{ sector: "Fixed Income", value: 1000 }]);
  });
  it("keeps a bond's explicit sector when one is set", () => {
    expect(explodeHoldingBySector("LQD-ISH", "Bond", 1000, weights, "Fixed Income")).toEqual([{ sector: "Fixed Income", value: 1000 }]);
  });
  it("still buckets a sectorless stock as Unknown", () => {
    expect(explodeHoldingBySector("XYZ", "Stock", 1000, weights)).toEqual([{ sector: "Unknown", value: 1000 }]);
  });
});

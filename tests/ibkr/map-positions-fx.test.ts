import { describe, it, expect } from "vitest";
import { mapPosition, deriveUsdPerUnit } from "@/lib/ibkr/map-positions";

describe("IBKR position currency", () => {
  it("carries currency through mapPosition (default USD)", () => {
    expect(mapPosition({ assetClass: "STK", contractDesc: "AAPL", position: 10, mktPrice: 150 }).currency).toBe("USD");
    expect(mapPosition({ assetClass: "STK", contractDesc: "402340", currency: "KRW", position: 10, mktPrice: 1_731_000, mktValue: 12705 }).currency).toBe("KRW");
  });

  it("derives USD-per-unit from mktValue / (mktPrice*qty)", () => {
    expect(deriveUsdPerUnit(12705, 1_731_000, 10, 1)).toBeCloseTo(0.000734, 6);
    expect(deriveUsdPerUnit(null as unknown as number, 1_731_000, 10)).toBeNull();
    expect(deriveUsdPerUnit(12705, 0, 10)).toBeNull();
  });
});

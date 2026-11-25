/** The one market-data-type setter (Gains at risk step 3, D2). A fake API only. */
import { describe, it, expect, vi } from "vitest";
import { MarketDataType } from "@stoqey/ib";
import { marketDataTypeGeneration, setMarketDataTypeCounted } from "@/lib/tws/market-data-type";

describe("setMarketDataTypeCounted", () => {
  it("sets the type and bumps the generation by one per call", () => {
    const api = { setMarketDataType: vi.fn() };
    const before = marketDataTypeGeneration();
    expect(setMarketDataTypeCounted(api, MarketDataType.DELAYED_FROZEN)).toBe(before + 1);
    expect(setMarketDataTypeCounted(api, MarketDataType.REALTIME)).toBe(before + 2);
    expect(marketDataTypeGeneration()).toBe(before + 2);
    expect(api.setMarketDataType.mock.calls).toEqual([[MarketDataType.DELAYED_FROZEN], [MarketDataType.REALTIME]]);
  });

  it("a throw from the broker call propagates and does not bump the generation", () => {
    const api = {
      setMarketDataType: vi.fn(() => {
        throw new Error("socket closed");
      }),
    };
    const before = marketDataTypeGeneration();
    expect(() => setMarketDataTypeCounted(api, MarketDataType.DELAYED_FROZEN)).toThrow("socket closed");
    expect(marketDataTypeGeneration()).toBe(before);
  });
});

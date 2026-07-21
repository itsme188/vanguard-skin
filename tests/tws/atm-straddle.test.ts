import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MarketDataType, OptionType, SecType } from "@stoqey/ib";

// Mock the TWS client module — same pattern as tests/tws/snapshot.test.ts.
vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(),
}));

import { getIbApi } from "@/lib/tws/client";
import { fetchTwsAtmStraddle } from "@/lib/tws/atm-straddle";

const mockedGetIbApi = vi.mocked(getIbApi);

const SNAPSHOT_TIMEOUT_MS = 15_000;

/** Build a mock MutableMarketData Map with given tick entries (snapshot.test.ts pattern). */
function mockMarketData(
  ticks: Array<{ type: number; value: number }>,
): Map<number, { value: number }> {
  const map = new Map<number, { value: number }>();
  for (const t of ticks) {
    map.set(t.type, { value: t.value });
  }
  return map;
}

const BASE_ARGS = {
  symbol: "AAPL",
  conid: 265598,
  eventDate: "2026-08-15",
  eventTime: "AMC" as const,
  spot: 200,
};

describe("fetchTwsAtmStraddle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null with no api calls when TWS is not connected", async () => {
    mockedGetIbApi.mockReturnValue(null);

    const result = await fetchTwsAtmStraddle(BASE_ARGS);

    expect(result).toBeNull();
  });

  it("happy path: picks post-print expiry + ATM strike and returns both legs' quotes", async () => {
    const getSecDefOptParams = vi.fn().mockResolvedValue([
      {
        exchange: "CBOE",
        underlyingConId: 265598,
        tradingClass: "AAPL",
        multiplier: 100,
        expirations: ["20260815", "20260821"],
        strikes: [195, 200, 205],
      },
      {
        exchange: "SMART",
        underlyingConId: 265598,
        tradingClass: "AAPL",
        multiplier: 100,
        expirations: ["20260821", "20260828"],
        strikes: [200, 210],
      },
    ]);

    const getMarketDataSnapshot = vi.fn().mockImplementation((contract: { right: string }) => {
      if (contract.right === OptionType.Call) {
        return Promise.resolve(
          mockMarketData([
            { type: 1 /* BID */, value: 10.2 },
            { type: 2 /* ASK */, value: 10.6 },
            { type: 4 /* LAST */, value: 10.4 },
          ]),
        );
      }
      return Promise.resolve(
        mockMarketData([
          { type: 1 /* BID */, value: 9.8 },
          { type: 2 /* ASK */, value: 10.1 },
          { type: 4 /* LAST */, value: 9.95 },
        ]),
      );
    });

    const setMarketDataType = vi.fn();

    const mockApi = { getSecDefOptParams, getMarketDataSnapshot, setMarketDataType };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const result = await fetchTwsAtmStraddle(BASE_ARGS);

    expect(result).not.toBeNull();
    expect(result!.expiry).toBe("2026-08-21");
    expect(result!.strike).toBe(200);
    expect(result!.call).toEqual({ bid: 10.2, ask: 10.6, last: 10.4 });
    expect(result!.put).toEqual({ bid: 9.8, ask: 10.1, last: 9.95 });

    expect(getSecDefOptParams).toHaveBeenCalledWith("AAPL", "", SecType.STK, 265598);

    expect(getMarketDataSnapshot).toHaveBeenCalledTimes(2);
    const [callContractArgs, putContractArgs] = getMarketDataSnapshot.mock.calls.map((c) => c[0]);

    expect(callContractArgs).toEqual({
      symbol: "AAPL",
      secType: SecType.OPT,
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: "20260821",
      strike: 200,
      right: OptionType.Call,
    });
    expect(putContractArgs).toEqual({
      symbol: "AAPL",
      secType: SecType.OPT,
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: "20260821",
      strike: 200,
      right: OptionType.Put,
    });
  });

  it("falls back to DELAYED_BID/DELAYED_ASK/DELAYED_LAST when primary ticks are absent", async () => {
    const getSecDefOptParams = vi.fn().mockResolvedValue([
      {
        exchange: "SMART",
        underlyingConId: 265598,
        tradingClass: "AAPL",
        multiplier: 100,
        expirations: ["20260821"],
        strikes: [200],
      },
    ]);

    const getMarketDataSnapshot = vi.fn().mockResolvedValue(
      mockMarketData([
        { type: 66 /* DELAYED_BID */, value: 11.1 },
        { type: 67 /* DELAYED_ASK */, value: 11.5 },
        { type: 68 /* DELAYED_LAST */, value: 11.3 },
      ]),
    );

    const mockApi = {
      getSecDefOptParams,
      getMarketDataSnapshot,
      setMarketDataType: vi.fn(),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const result = await fetchTwsAtmStraddle(BASE_ARGS);

    expect(result).not.toBeNull();
    expect(result!.call).toEqual({ bid: 11.1, ask: 11.5, last: 11.3 });
    expect(result!.put).toEqual({ bid: 11.1, ask: 11.5, last: 11.3 });
  });

  it("returns null with no snapshot calls when there is no eligible expiry", async () => {
    // Only expiration is BEFORE the event date — pickPostPrintExpiry rejects it.
    const getSecDefOptParams = vi.fn().mockResolvedValue([
      {
        exchange: "SMART",
        underlyingConId: 265598,
        tradingClass: "AAPL",
        multiplier: 100,
        expirations: ["20260801"],
        strikes: [200],
      },
    ]);
    const getMarketDataSnapshot = vi.fn();

    const mockApi = {
      getSecDefOptParams,
      getMarketDataSnapshot,
      setMarketDataType: vi.fn(),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const result = await fetchTwsAtmStraddle(BASE_ARGS);

    expect(result).toBeNull();
    expect(getMarketDataSnapshot).not.toHaveBeenCalled();
  });

  it("returns null when both legs time out, and still resets to REALTIME", async () => {
    vi.useFakeTimers();

    const getSecDefOptParams = vi.fn().mockResolvedValue([
      {
        exchange: "SMART",
        underlyingConId: 265598,
        tradingClass: "AAPL",
        multiplier: 100,
        expirations: ["20260821"],
        strikes: [200],
      },
    ]);
    // Never resolves — forces the per-leg Promise.race timeout.
    const getMarketDataSnapshot = vi.fn().mockReturnValue(new Promise(() => {}));
    const setMarketDataType = vi.fn();

    const mockApi = { getSecDefOptParams, getMarketDataSnapshot, setMarketDataType };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const resultPromise = fetchTwsAtmStraddle(BASE_ARGS);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(setMarketDataType).toHaveBeenNthCalledWith(1, MarketDataType.DELAYED_FROZEN);
    expect(setMarketDataType).toHaveBeenNthCalledWith(2, MarketDataType.REALTIME);
  });

  it("resets to REALTIME even when both leg snapshots reject", async () => {
    const getSecDefOptParams = vi.fn().mockResolvedValue([
      {
        exchange: "SMART",
        underlyingConId: 265598,
        tradingClass: "AAPL",
        multiplier: 100,
        expirations: ["20260821"],
        strikes: [200],
      },
    ]);
    const getMarketDataSnapshot = vi.fn().mockRejectedValue(new Error("No market data"));
    const setMarketDataType = vi.fn();

    const mockApi = { getSecDefOptParams, getMarketDataSnapshot, setMarketDataType };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const result = await fetchTwsAtmStraddle(BASE_ARGS);

    expect(result).toBeNull();
    expect(setMarketDataType).toHaveBeenCalledTimes(2);
    expect(setMarketDataType).toHaveBeenNthCalledWith(1, MarketDataType.DELAYED_FROZEN);
    expect(setMarketDataType).toHaveBeenNthCalledWith(2, MarketDataType.REALTIME);
  });

  it("treats the IB -1 'no quote' sentinel as null, not a real value", async () => {
    const getSecDefOptParams = vi.fn().mockResolvedValue([
      {
        exchange: "SMART",
        underlyingConId: 265598,
        tradingClass: "AAPL",
        multiplier: 100,
        expirations: ["20260821"],
        strikes: [200],
      },
    ]);
    const getMarketDataSnapshot = vi.fn().mockResolvedValue(
      mockMarketData([
        { type: 1 /* BID */, value: -1 },
        { type: 2 /* ASK */, value: 10.5 },
        { type: 4 /* LAST */, value: 10.3 },
      ]),
    );

    const mockApi = {
      getSecDefOptParams,
      getMarketDataSnapshot,
      setMarketDataType: vi.fn(),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const result = await fetchTwsAtmStraddle(BASE_ARGS);

    expect(result).not.toBeNull();
    expect(result!.call.bid).toBeNull();
    expect(result!.call.ask).toBe(10.5);
    expect(result!.call.last).toBe(10.3);
  });
});

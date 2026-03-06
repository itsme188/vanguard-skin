import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

// Mock the TWS client module
vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(),
}));

// Mock the rate limiter to be instant
vi.mock("@/lib/tws/rate-limiter", () => ({
  RateLimiter: class {
    async waitForSlot() {}
    get activeCount() { return 0; }
    reset() {}
  },
}));

import { getIbApi } from "@/lib/tws/client";
import { fetchHistoricalPrices } from "@/lib/tws/historical";
import type { Bar } from "@stoqey/ib";

const mockedGetIbApi = vi.mocked(getIbApi);

function seedSecurity(
  db: Database.Database,
  symbol: string,
  securityType?: string,
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)",
    )
    .run(symbol, symbol + " Corp", securityType ?? "stock");
  return result.lastInsertRowid as number;
}

describe("fetchHistoricalPrices", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.clearAllMocks();
  });

  it("throws when TWS not connected", async () => {
    mockedGetIbApi.mockReturnValue(null);
    await expect(fetchHistoricalPrices(db)).rejects.toThrow(
      "TWS not connected",
    );
  });

  it("fetches and inserts daily bars for a security", async () => {
    const secId = seedSecurity(db, "AAPL", "stock");

    const mockBars: Bar[] = [
      { time: "20250201", open: 190, high: 195, low: 189, close: 193.5, volume: 1000 },
      { time: "20250202", open: 193, high: 198, low: 192, close: 197.0, volume: 1200 },
      { time: "20250203", open: 197, high: 200, low: 196, close: 199.0, volume: 900 },
    ];

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue(mockBars),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchHistoricalPrices(db, {
      securityIds: [secId],
    });

    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe("AAPL");
    expect(results[0].barsInserted).toBe(3);
    expect(results[0].dateRange).toEqual({
      from: "2025-02-01",
      to: "2025-02-03",
    });

    // Verify prices were written to DB
    const prices = db
      .prepare("SELECT * FROM prices WHERE security_id = ? ORDER BY date")
      .all(secId) as Array<{
      security_id: number;
      date: string;
      close_price: number;
      source: string;
    }>;
    expect(prices).toHaveLength(3);
    expect(prices[0].date).toBe("2025-02-01");
    expect(prices[0].close_price).toBe(193.5);
    expect(prices[0].source).toBe("tws");
    expect(prices[2].close_price).toBe(199.0);
  });

  it("overwrites existing prices with TWS data (INSERT OR REPLACE)", async () => {
    const secId = seedSecurity(db, "MSFT", "stock");

    // Pre-insert a price from a different source
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, ?)",
    ).run(secId, "2025-03-01", 400.0, "vanguard-pdf");

    const mockBars: Bar[] = [
      { time: "20250301", open: 405, high: 410, low: 400, close: 408.5, volume: 500 },
    ];

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue(mockBars),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    await fetchHistoricalPrices(db, { securityIds: [secId] });

    // Price should be overwritten
    const price = db
      .prepare(
        "SELECT close_price, source FROM prices WHERE security_id = ? AND date = ?",
      )
      .get(secId, "2025-03-01") as { close_price: number; source: string };
    expect(price.close_price).toBe(408.5);
    expect(price.source).toBe("tws");
  });

  it("handles errors per-security without aborting batch", async () => {
    const secId1 = seedSecurity(db, "GOOD", "stock");
    const secId2 = seedSecurity(db, "BAD", "stock");

    const mockApi = {
      getHistoricalData: vi.fn().mockImplementation((contract: { symbol?: string }) => {
        if (contract.symbol === "BAD") {
          return Promise.reject(new Error("No data for BAD"));
        }
        return Promise.resolve([
          { time: "20250101", open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
        ]);
      }),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchHistoricalPrices(db, {
      securityIds: [secId1, secId2],
    });

    expect(results).toHaveLength(2);

    const goodResult = results.find((r) => r.symbol === "GOOD");
    expect(goodResult?.barsInserted).toBe(1);
    expect(goodResult?.error).toBeUndefined();

    const badResult = results.find((r) => r.symbol === "BAD");
    expect(badResult?.barsInserted).toBe(0);
    expect(badResult?.error).toBe("No data for BAD");
  });

  it("skips bars with missing time or close price", async () => {
    const secId = seedSecurity(db, "TEST", "stock");

    const mockBars: Bar[] = [
      { time: "20250101", close: 100 },
      { time: undefined, close: 200 }, // missing time
      { time: "20250103", close: undefined }, // missing close
      { time: "20250104", close: 400 },
    ];

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue(mockBars),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchHistoricalPrices(db, {
      securityIds: [secId],
    });

    expect(results[0].barsInserted).toBe(2);
    expect(results[0].barsSkipped).toBe(2);
  });

  it("uses ib_con_id when available for contract lookup", async () => {
    const result = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, ib_con_id) VALUES (?, ?, ?, ?)",
      )
      .run("AAPL", "Apple Inc", "stock", 265598);
    const secId = result.lastInsertRowid as number;

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue([]),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    await fetchHistoricalPrices(db, { securityIds: [secId] });

    // Should use conId instead of symbol lookup
    expect(mockApi.getHistoricalData).toHaveBeenCalledWith(
      { conId: 265598 },
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { IBApiTickType } from "@stoqey/ib";

// Mock the TWS client module
vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(),
}));

import { getIbApi } from "@/lib/tws/client";
import { fetchSnapshotPrices } from "@/lib/tws/snapshot";

const mockedGetIbApi = vi.mocked(getIbApi);

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts?: { securityType?: string; conId?: number },
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, ib_con_id) VALUES (?, ?, ?, ?)",
    )
    .run(symbol, symbol + " Corp", opts?.securityType ?? "stock", opts?.conId ?? 12345);
  return result.lastInsertRowid as number;
}

/** Build a mock MutableMarketData Map with given tick entries. */
function mockMarketData(ticks: Array<{ type: number; value: number }>): Map<number, { value: number }> {
  const map = new Map<number, { value: number }>();
  for (const t of ticks) {
    map.set(t.type, { value: t.value });
  }
  return map;
}

describe("fetchSnapshotPrices", () => {
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
    await expect(fetchSnapshotPrices(db)).rejects.toThrow("TWS not connected");
  });

  it("fetches and inserts current price via LAST tick", async () => {
    const secId = seedSecurity(db, "AAPL", { conId: 265598 });
    const today = new Date().toISOString().slice(0, 10);

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([{ type: IBApiTickType.LAST, value: 195.50 }]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchSnapshotPrices(db, { securityIds: [secId] });

    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe("AAPL");
    expect(results[0].price).toBe(195.50);
    expect(results[0].tickType).toBe("LAST");

    // Verify DB insertion
    const price = db
      .prepare("SELECT close_price, source, date FROM prices WHERE security_id = ?")
      .get(secId) as { close_price: number; source: string; date: string };
    expect(price.close_price).toBe(195.50);
    expect(price.source).toBe("tws");
    expect(price.date).toBe(today);
  });

  it("uses CLOSE tick when LAST is not available", async () => {
    const secId = seedSecurity(db, "MSFT", { conId: 100 });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([{ type: IBApiTickType.CLOSE, value: 420.00 }]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchSnapshotPrices(db, { securityIds: [secId] });
    expect(results[0].price).toBe(420.00);
    expect(results[0].tickType).toBe("CLOSE");
  });

  it("uses DELAYED_LAST as fallback", async () => {
    const secId = seedSecurity(db, "VTI", { conId: 200 });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([{ type: IBApiTickType.DELAYED_LAST, value: 250.75 }]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchSnapshotPrices(db, { securityIds: [secId] });
    expect(results[0].price).toBe(250.75);
    expect(results[0].tickType).toBe("DELAYED_LAST");
  });

  it("uses DELAYED_CLOSE as last resort", async () => {
    const secId = seedSecurity(db, "BND", { conId: 300 });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([{ type: IBApiTickType.DELAYED_CLOSE, value: 72.30 }]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchSnapshotPrices(db, { securityIds: [secId] });
    expect(results[0].price).toBe(72.30);
    expect(results[0].tickType).toBe("DELAYED_CLOSE");
  });

  it("prefers LAST over CLOSE when both present", async () => {
    const secId = seedSecurity(db, "GOOG", { conId: 400 });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([
          { type: IBApiTickType.CLOSE, value: 170.00 },
          { type: IBApiTickType.LAST, value: 175.50 },
        ]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchSnapshotPrices(db, { securityIds: [secId] });
    expect(results[0].price).toBe(175.50);
    expect(results[0].tickType).toBe("LAST");
  });

  it("reports no_price when snapshot returns empty map", async () => {
    const secId = seedSecurity(db, "WEIRD", { conId: 500 });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(new Map()),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const progressEvents: Array<{ status: string }> = [];
    const results = await fetchSnapshotPrices(db, {
      securityIds: [secId],
      onProgress: (p) => progressEvents.push({ status: p.status }),
    });

    expect(results[0].price).toBeNull();
    expect(results[0].tickType).toBe("NONE");

    // No price written to DB
    const count = db
      .prepare("SELECT COUNT(*) as c FROM prices WHERE security_id = ?")
      .get(secId) as { c: number };
    expect(count.c).toBe(0);

    // Progress reported no_price
    expect(progressEvents.some((e) => e.status === "no_price")).toBe(true);
  });

  it("handles per-security errors without aborting batch", async () => {
    const secId1 = seedSecurity(db, "GOOD", { conId: 600 });
    const secId2 = seedSecurity(db, "BAD", { conId: 700 });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockImplementation((contract: { conId?: number }) => {
        if (contract.conId === 700) {
          return Promise.reject(new Error("No market data for BAD"));
        }
        return Promise.resolve(
          mockMarketData([{ type: IBApiTickType.LAST, value: 100.0 }]),
        );
      }),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchSnapshotPrices(db, {
      securityIds: [secId1, secId2],
    });

    expect(results).toHaveLength(2);

    const good = results.find((r) => r.symbol === "GOOD");
    expect(good?.price).toBe(100.0);
    expect(good?.error).toBeUndefined();

    const bad = results.find((r) => r.symbol === "BAD");
    expect(bad?.price).toBeNull();
    expect(bad?.error).toBe("No market data for BAD");
  });

  it("overwrites existing price for same date (INSERT OR REPLACE)", async () => {
    const secId = seedSecurity(db, "TSLA", { conId: 800 });
    const today = new Date().toISOString().slice(0, 10);

    // Pre-insert a price from a different source
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, ?)",
    ).run(secId, today, 200.0, "manual");

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([{ type: IBApiTickType.LAST, value: 215.0 }]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    await fetchSnapshotPrices(db, { securityIds: [secId] });

    const price = db
      .prepare("SELECT close_price, source FROM prices WHERE security_id = ? AND date = ?")
      .get(secId, today) as { close_price: number; source: string };
    expect(price.close_price).toBe(215.0);
    expect(price.source).toBe("tws");
  });

  it("sets DELAYED_FROZEN market data type and resets to REALTIME", async () => {
    seedSecurity(db, "TEST", { conId: 900 });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([{ type: IBApiTickType.LAST, value: 50.0 }]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    await fetchSnapshotPrices(db);

    // First call should set DELAYED_FROZEN (4), last call should reset to REALTIME (1)
    const calls = mockApi.setMarketDataType.mock.calls;
    expect(calls[0][0]).toBe(4); // MarketDataType.DELAYED_FROZEN
    expect(calls[calls.length - 1][0]).toBe(1); // MarketDataType.REALTIME
  });

  it("ignores zero and negative price values", async () => {
    const secId = seedSecurity(db, "ZERO", { conId: 1000 });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([
          { type: IBApiTickType.LAST, value: 0 },
          { type: IBApiTickType.CLOSE, value: -1 },
        ]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchSnapshotPrices(db, { securityIds: [secId] });
    expect(results[0].price).toBeNull();
    expect(results[0].tickType).toBe("NONE");
  });

  it("excludes mutual funds from default fetch", async () => {
    seedSecurity(db, "VTI", { conId: 1100 }); // stock — included
    seedSecurity(db, "VTSAX", { securityType: "mutual_fund", conId: 1200 }); // excluded

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([{ type: IBApiTickType.LAST, value: 100.0 }]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchSnapshotPrices(db);

    // Only VTI should be fetched (VTSAX is mutual_fund)
    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe("VTI");
  });

  it("reports progress with onProgress callback", async () => {
    seedSecurity(db, "A", { conId: 1 });
    seedSecurity(db, "B", { conId: 2 });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([{ type: IBApiTickType.LAST, value: 50.0 }]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const events: Array<{ symbol: string; status: string }> = [];
    await fetchSnapshotPrices(db, {
      onProgress: (p) => events.push({ symbol: p.symbol, status: p.status }),
    });

    // Each security should have fetching + done events
    const fetchingEvents = events.filter((e) => e.status === "fetching");
    const doneEvents = events.filter((e) => e.status === "done");
    expect(fetchingEvents.length).toBe(2);
    expect(doneEvents.length).toBe(2);
  });
});

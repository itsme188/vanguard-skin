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
    get activeCount() {
      return 0;
    }
    get estimatedWaitSeconds() {
      return 0;
    }
    reset() {}
  },
}));

import { getIbApi } from "@/lib/tws/client";
import { fetchOhlcvBars } from "@/lib/tws/ohlcv";
import { getOhlcvBars, getLatestOhlcvDate } from "@/lib/queries/ohlcv";
import { upsertOhlcvBars } from "@/lib/mutations/ohlcv";
import type { Bar } from "@stoqey/ib";

const mockedGetIbApi = vi.mocked(getIbApi);

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts?: { conId?: number; secType?: string },
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, ib_con_id) VALUES (?, ?, ?, ?)",
    )
    .run(
      symbol,
      symbol + " Corp",
      opts?.secType ?? "stock",
      opts?.conId ?? null,
    );
  return result.lastInsertRowid as number;
}

describe("OHLCV mutations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("inserts OHLCV bars and reads them back", () => {
    const secId = seedSecurity(db, "AAPL", { conId: 265598 });

    const bars = [
      { date: "2025-02-01", open: 190, high: 195, low: 189, close: 193.5, volume: 1000 },
      { date: "2025-02-02", open: 193, high: 198, low: 192, close: 197.0, volume: 1200 },
      { date: "2025-02-03", open: 197, high: 200, low: 196, close: 199.0, volume: 900 },
    ];

    const count = upsertOhlcvBars(db, secId, "1 day", bars);
    expect(count).toBe(3);

    const stored = getOhlcvBars(db, secId, "1 day");
    expect(stored).toHaveLength(3);
    expect(stored[0]).toEqual({
      date: "2025-02-01",
      open: 190,
      high: 195,
      low: 189,
      close: 193.5,
      volume: 1000,
    });
    expect(stored[2].close).toBe(199.0);
  });

  it("upserts overwrite existing bars (INSERT OR REPLACE)", () => {
    const secId = seedSecurity(db, "AAPL", { conId: 265598 });

    upsertOhlcvBars(db, secId, "1 day", [
      { date: "2025-02-01", open: 190, high: 195, low: 189, close: 193.5, volume: 1000 },
    ]);

    // Re-insert same date with updated close
    upsertOhlcvBars(db, secId, "1 day", [
      { date: "2025-02-01", open: 190, high: 196, low: 188, close: 195.0, volume: 1100 },
    ]);

    const stored = getOhlcvBars(db, secId, "1 day");
    expect(stored).toHaveLength(1);
    expect(stored[0].close).toBe(195.0);
    expect(stored[0].high).toBe(196);
    expect(stored[0].volume).toBe(1100);
  });

  it("handles null volume gracefully", () => {
    const secId = seedSecurity(db, "BOND1", { conId: 100, secType: "bond" });

    upsertOhlcvBars(db, secId, "1 day", [
      { date: "2025-02-01", open: 99, high: 100, low: 98, close: 99.5, volume: null },
    ]);

    const stored = getOhlcvBars(db, secId, "1 day");
    expect(stored).toHaveLength(1);
    expect(stored[0].volume).toBeNull();
  });

  it("filters by date range", () => {
    const secId = seedSecurity(db, "AAPL", { conId: 265598 });

    upsertOhlcvBars(db, secId, "1 day", [
      { date: "2025-01-15", open: 180, high: 185, low: 179, close: 183, volume: 800 },
      { date: "2025-02-01", open: 190, high: 195, low: 189, close: 193, volume: 1000 },
      { date: "2025-03-01", open: 200, high: 205, low: 199, close: 203, volume: 1200 },
    ]);

    const filtered = getOhlcvBars(db, secId, "1 day", {
      startDate: "2025-02-01",
      endDate: "2025-02-28",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].date).toBe("2025-02-01");
  });

  it("separates different bar sizes", () => {
    const secId = seedSecurity(db, "AAPL", { conId: 265598 });

    upsertOhlcvBars(db, secId, "1 day", [
      { date: "2025-02-01", open: 190, high: 195, low: 189, close: 193, volume: 1000 },
    ]);
    upsertOhlcvBars(db, secId, "5 mins", [
      { date: "2025-02-01 09:30:00", open: 190, high: 191, low: 189.5, close: 190.5, volume: 100 },
    ]);

    expect(getOhlcvBars(db, secId, "1 day")).toHaveLength(1);
    expect(getOhlcvBars(db, secId, "5 mins")).toHaveLength(1);
  });
});

describe("getLatestOhlcvDate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns null when no bars exist", () => {
    const secId = seedSecurity(db, "AAPL", { conId: 265598 });
    expect(getLatestOhlcvDate(db, secId, "1 day")).toBeNull();
  });

  it("returns the latest date", () => {
    const secId = seedSecurity(db, "AAPL", { conId: 265598 });
    upsertOhlcvBars(db, secId, "1 day", [
      { date: "2025-02-01", open: 190, high: 195, low: 189, close: 193, volume: 1000 },
      { date: "2025-02-03", open: 197, high: 200, low: 196, close: 199, volume: 900 },
    ]);
    expect(getLatestOhlcvDate(db, secId, "1 day")).toBe("2025-02-03");
  });
});

describe("fetchOhlcvBars (TWS integration)", () => {
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
    const secId = seedSecurity(db, "AAPL", { conId: 265598 });

    await expect(
      fetchOhlcvBars(db, { securityId: secId }),
    ).rejects.toThrow("TWS not connected");
  });

  it("throws for security without ib_con_id", async () => {
    const mockApi = { getHistoricalData: vi.fn() };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const secId = seedSecurity(db, "NOCON"); // no conId

    await expect(
      fetchOhlcvBars(db, { securityId: secId }),
    ).rejects.toThrow("no IB contract ID");
  });

  it("fetches OHLCV bars and stores them", async () => {
    const secId = seedSecurity(db, "AAPL", { conId: 265598 });

    const mockBars: Bar[] = [
      { time: "20250201", open: 190, high: 195, low: 189, close: 193.5, volume: 1000, WAP: 192, count: 500 },
      { time: "20250202", open: 193, high: 198, low: 192, close: 197.0, volume: 1200, WAP: 195, count: 600 },
    ];

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue(mockBars),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const result = await fetchOhlcvBars(db, { securityId: secId });

    expect(result.symbol).toBe("AAPL");
    expect(result.barsInserted).toBe(2);
    expect(result.fromCache).toBe(false);
    expect(result.bars).toHaveLength(2);
    expect(result.bars[0]).toEqual({
      date: "2025-02-01",
      open: 190,
      high: 195,
      low: 189,
      close: 193.5,
      volume: 1000,
    });

    // Verify stored in DB
    const stored = getOhlcvBars(db, secId, "1 day");
    expect(stored).toHaveLength(2);
  });

  it("skips bars with missing time or close", async () => {
    const secId = seedSecurity(db, "AAPL", { conId: 265598 });

    const mockBars: Bar[] = [
      { time: "20250201", open: 190, high: 195, low: 189, close: 193.5, volume: 1000 },
      { time: "", open: 193, high: 198, low: 192, close: 197.0, volume: 1200 }, // empty time
      { time: "20250203", open: 197, high: 200, low: 196, close: undefined as unknown as number, volume: 900 }, // no close
    ];

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue(mockBars),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const result = await fetchOhlcvBars(db, { securityId: secId });
    expect(result.barsInserted).toBe(1);
    expect(result.bars).toHaveLength(1);
  });

  it("uses the security's own stored currency for the contract (non-USD)", async () => {
    const result = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, ib_con_id, currency) VALUES (?, ?, ?, ?, ?)",
      )
      .run("402340", "Korea Corp", "stock", 555, "KRW");
    const secId = result.lastInsertRowid as number;

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue([]),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    await fetchOhlcvBars(db, { securityId: secId });

    const [contractArg] = mockApi.getHistoricalData.mock.calls[0];
    expect(contractArg).toEqual({ conId: 555, secType: "STK", exchange: "SMART", currency: "KRW" });
  });

  it("defaults to USD when a security has no currency stored (NULL)", async () => {
    // seedSecurity omits currency; migration 061's column DEFAULT 'USD' applies.
    const secId = seedSecurity(db, "AAPL", { conId: 265598 });

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue([]),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    await fetchOhlcvBars(db, { securityId: secId });

    const [contractArg] = mockApi.getHistoricalData.mock.calls[0];
    expect(contractArg.currency).toBe("USD");
  });

  it("throws for non-existent security", async () => {
    const mockApi = { getHistoricalData: vi.fn() };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    await expect(
      fetchOhlcvBars(db, { securityId: 9999 }),
    ).rejects.toThrow("Security not found");
  });
});

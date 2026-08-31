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
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";

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

    // Should use conId with required IB fields (secType, exchange, currency)
    expect(mockApi.getHistoricalData).toHaveBeenCalledWith(
      { conId: 265598, secType: "STK", exchange: "SMART", currency: "USD" },
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
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

    await fetchHistoricalPrices(db, { securityIds: [secId] });

    expect(mockApi.getHistoricalData).toHaveBeenCalledWith(
      { conId: 555, secType: "STK", exchange: "SMART", currency: "KRW" },
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("defaults to USD when a security has no currency stored (NULL)", async () => {
    // seedSecurity omits currency; migration 061's column DEFAULT 'USD' applies.
    const secId = seedSecurity(db, "AAPL", "stock");

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue([]),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    await fetchHistoricalPrices(db, { securityIds: [secId] });

    const [contractArg] = mockApi.getHistoricalData.mock.calls[0];
    expect(contractArg.currency).toBe("USD");
  });

  it("forces USD for an OPTION contract even when the security's stored currency is non-USD (KRW)", async () => {
    const result = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, ib_con_id, currency) VALUES (?, ?, ?, ?, ?)",
      )
      .run("402340  260320C00045000", "Korea Corp Option", "option", 556, "KRW");
    const secId = result.lastInsertRowid as number;

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue([]),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    // securityIds bypasses the default query's option exclusion, so this path
    // IS reachable (e.g. Security Detail chart / manual chart fetch for a held option).
    await fetchHistoricalPrices(db, { securityIds: [secId] });

    expect(mockApi.getHistoricalData).toHaveBeenCalledWith(
      { conId: 556, secType: "OPT", exchange: "SMART", currency: "USD" },
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  describe("incremental mode", () => {
    it("uses shorter duration when recent prices exist", async () => {
      const secId = seedSecurity(db, "AAPL", "stock");

      // Seed a price from 5 days ago
      const fiveDaysAgo = new Date();
      fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
      const dateStr = fiveDaysAgo.toISOString().slice(0, 10);
      db.prepare(
        "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')",
      ).run(secId, dateStr, 180.0);

      const mockApi = {
        getHistoricalData: vi.fn().mockResolvedValue([]),
      };
      mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

      await fetchHistoricalPrices(db, {
        securityIds: [secId],
        incremental: true,
      });

      // Should request ~5 days, not 1 year
      const durationArg = mockApi.getHistoricalData.mock.calls[0][2];
      expect(durationArg).toMatch(/^\d+ D$/);
      const days = parseInt(durationArg.split(" ")[0]);
      expect(days).toBeGreaterThanOrEqual(4);
      expect(days).toBeLessThanOrEqual(6);
    });

    it("skips security when price exists for today", async () => {
      const secId = seedSecurity(db, "MSFT", "stock");

      // Seed today's price
      const today = new Date().toISOString().slice(0, 10);
      db.prepare(
        "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')",
      ).run(secId, today, 400.0);

      const mockApi = {
        getHistoricalData: vi.fn().mockResolvedValue([]),
      };
      mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

      const progressEvents: Array<{ status: string }> = [];
      const results = await fetchHistoricalPrices(db, {
        securityIds: [secId],
        incremental: true,
        onProgress: (p) => progressEvents.push({ status: p.status }),
      });

      // Should not call getHistoricalData at all
      expect(mockApi.getHistoricalData).not.toHaveBeenCalled();
      expect(results[0].barsInserted).toBe(0);
      expect(progressEvents.some((e) => e.status === "skipped")).toBe(true);
    });

    it("uses full duration when no existing prices", async () => {
      const secId = seedSecurity(db, "NEW", "stock");

      const mockApi = {
        getHistoricalData: vi.fn().mockResolvedValue([]),
      };
      mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

      await fetchHistoricalPrices(db, {
        securityIds: [secId],
        incremental: true,
      });

      // Should use default "1 Y" since no existing prices
      const durationArg = mockApi.getHistoricalData.mock.calls[0][2];
      expect(durationArg).toBe("1 Y");
    });

    it("caps gap at 1 year for very old prices", async () => {
      const secId = seedSecurity(db, "OLD", "stock");

      // Seed a price from 2 years ago
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      const dateStr = twoYearsAgo.toISOString().slice(0, 10);
      db.prepare(
        "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')",
      ).run(secId, dateStr, 50.0);

      const mockApi = {
        getHistoricalData: vi.fn().mockResolvedValue([]),
      };
      mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

      await fetchHistoricalPrices(db, {
        securityIds: [secId],
        incremental: true,
      });

      // Should cap at "1 Y"
      const durationArg = mockApi.getHistoricalData.mock.calls[0][2];
      expect(durationArg).toBe("1 Y");
    });

    it("ignores incremental when explicit durationStr is provided", async () => {
      const secId = seedSecurity(db, "FORCED", "stock");

      // Seed recent price
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      db.prepare(
        "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')",
      ).run(secId, yesterday.toISOString().slice(0, 10), 100.0);

      const mockApi = {
        getHistoricalData: vi.fn().mockResolvedValue([]),
      };
      mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

      await fetchHistoricalPrices(db, {
        securityIds: [secId],
        incremental: true,
        durationStr: "6 M", // Explicit override
      });

      // Should use the explicit duration, not compute from gap
      const durationArg = mockApi.getHistoricalData.mock.calls[0][2];
      expect(durationArg).toBe("6 M");
    });
  });
});

describe("fetchHistoricalPrices — synthetic-close price bump (reconciler-hardening, spec §4)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.clearAllMocks();
  });

  function seedAccount(name: string): number {
    return (
      db.prepare(`INSERT INTO accounts (name) VALUES (?) RETURNING id`).get(name) as { id: number }
    ).id;
  }

  it("does not bump for a held-only fetch (routine sync, no tombstone anywhere)", async () => {
    const secId = seedSecurity(db, "AAPL", "stock");
    const before = getTaxInputGeneration(db);

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue([
        { time: "20260201", open: 190, high: 195, low: 189, close: 193.5, volume: 1000 },
      ]),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    await fetchHistoricalPrices(db, { securityIds: [secId] });

    expect(getTaxInputGeneration(db)).toBe(before);
  });

  it("bumps when a fetched bar lands at/before a tombstoned security's zero date — isolated PRICE path (Codex plan-review F8): fetchHistoricalPrices never writes to `holdings`", async () => {
    const secId = seedSecurity(db, "GONE", "stock");
    const acctId = seedAccount("T");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 0, '2026-02-01', 'recon:closed-equity:g:live')`,
    ).run(acctId, secId);
    const before = getTaxInputGeneration(db);

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue([
        { time: "20260201", open: 10, high: 11, low: 9, close: 10.5, volume: 500 },
      ]),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchHistoricalPrices(db, { securityIds: [secId] });

    expect(results[0].barsInserted).toBe(1);
    expect(getTaxInputGeneration(db)).toBe(before + 1);
  });

  it("a throw inside a security's write transaction rolls back that security's bars AND its bump together", async () => {
    const secId = seedSecurity(db, "BOOM", "stock");

    const mockApi = {
      getHistoricalData: vi.fn().mockResolvedValue([
        { time: "20260201", open: 190, high: 195, low: 189, close: 193.5, volume: 1000 },
        { time: "20260202", open: 193, high: 198, low: 192, close: 999999, volume: 1200 },
      ]),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    // No outer transaction wraps this call. The sentinel close price aborts
    // the second bar's insert, after the first bar of the SAME security has
    // already been written in the same per-security transaction.
    db.exec(
      `CREATE TEMP TRIGGER boom BEFORE INSERT ON prices WHEN NEW.close_price = 999999 BEGIN SELECT RAISE(ABORT,'boom'); END`,
    );

    const before = getTaxInputGeneration(db);
    const results = await fetchHistoricalPrices(db, { securityIds: [secId] });

    // The per-security fetch error is caught by the batch's .catch() wrapper
    // (matching "handles errors per-security without aborting batch"), so the
    // call itself resolves — but NONE of BOOM's bars should have persisted.
    expect(results[0].error).toBeTruthy();
    const priceCount = db.prepare("SELECT COUNT(*) c FROM prices WHERE security_id = ?").get(secId) as {
      c: number;
    };
    expect(priceCount.c).toBe(0);
    expect(getTaxInputGeneration(db)).toBe(before);
  });
});

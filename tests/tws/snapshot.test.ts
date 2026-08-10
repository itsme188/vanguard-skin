import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { IBApiTickType } from "@stoqey/ib";

// Mock the TWS client module
vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(),
}));

import { getIbApi } from "@/lib/tws/client";
import { fetchSnapshotPrices, tickPriorityFor } from "@/lib/tws/snapshot";

const mockedGetIbApi = vi.mocked(getIbApi);

// A fixed TRADING day (Fri 2026-01-02). Passed as asOfDate so the new
// market-closed guard in fetchSnapshotPrices is deterministic regardless of
// when the suite runs (it would otherwise early-return on a weekend/holiday).
const TRADING_DAY = "2026-01-02";

// Fixed ET wall-clock times so tick-priority tests are deterministic
// regardless of when the suite actually runs (it would otherwise flip
// between RTH/outside-RTH ordering depending on real time-of-day).
const RTH_TIME = "10:00"; // inside 09:30-16:00 ET
const AFTER_CLOSE_TIME = "17:30"; // outside — after the close
const PRE_OPEN_TIME = "08:00"; // outside — before the open

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
  const secId = result.lastInsertRowid as number;

  // Default fetch query requires holdings — seed one for each security
  const accountId = ensureAccount(db);
  db.prepare(
    "INSERT OR IGNORE INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 100, '2026-01-01')",
  ).run(accountId, secId);

  return secId;
}

function ensureAccount(db: Database.Database): number {
  const row = db.prepare("SELECT id FROM accounts LIMIT 1").get() as { id: number } | undefined;
  if (row) return row.id;
  return db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run().lastInsertRowid as number;
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
    const today = TRADING_DAY;

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([{ type: IBApiTickType.LAST, value: 195.50 }]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchSnapshotPrices(db, { securityIds: [secId], asOfDate: TRADING_DAY });

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

    const results = await fetchSnapshotPrices(db, { securityIds: [secId], asOfDate: TRADING_DAY });
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

    const results = await fetchSnapshotPrices(db, { securityIds: [secId], asOfDate: TRADING_DAY });
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

    const results = await fetchSnapshotPrices(db, { securityIds: [secId], asOfDate: TRADING_DAY });
    expect(results[0].price).toBe(72.30);
    expect(results[0].tickType).toBe("DELAYED_CLOSE");
  });

  it("prefers LAST over CLOSE when both present, during RTH", async () => {
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

    const results = await fetchSnapshotPrices(db, {
      securityIds: [secId],
      asOfDate: TRADING_DAY,
      nowEt: RTH_TIME,
    });
    expect(results[0].price).toBe(175.50);
    expect(results[0].tickType).toBe("LAST");
  });

  it("prefers CLOSE over LAST when both present, after the close (AH poisoning fix)", async () => {
    const secId = seedSecurity(db, "NET", { conId: 401 });

    // Mirrors the verified live bug: an after-hours LAST print (330.00, an
    // AH earnings spike) must NOT beat the real RTH CLOSE (284.43) once the
    // 30-min background sync runs post-market.
    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([
          { type: IBApiTickType.LAST, value: 330.0 },
          { type: IBApiTickType.CLOSE, value: 284.43 },
        ]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchSnapshotPrices(db, {
      securityIds: [secId],
      asOfDate: TRADING_DAY,
      nowEt: AFTER_CLOSE_TIME,
    });
    expect(results[0].price).toBe(284.43);
    expect(results[0].tickType).toBe("CLOSE");
  });

  it("prefers CLOSE over LAST when both present, before the open", async () => {
    const secId = seedSecurity(db, "NET", { conId: 402 });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([
          { type: IBApiTickType.LAST, value: 330.0 },
          { type: IBApiTickType.CLOSE, value: 284.43 },
        ]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchSnapshotPrices(db, {
      securityIds: [secId],
      asOfDate: TRADING_DAY,
      nowEt: PRE_OPEN_TIME,
    });
    expect(results[0].price).toBe(284.43);
    expect(results[0].tickType).toBe("CLOSE");
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
      asOfDate: TRADING_DAY,
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
      asOfDate: TRADING_DAY,
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
    const today = TRADING_DAY;

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

    await fetchSnapshotPrices(db, { securityIds: [secId], asOfDate: TRADING_DAY });

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

    await fetchSnapshotPrices(db, { asOfDate: TRADING_DAY });

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

    const results = await fetchSnapshotPrices(db, { securityIds: [secId], asOfDate: TRADING_DAY });
    expect(results[0].price).toBeNull();
    expect(results[0].tickType).toBe("NONE");
  });

  it("includes mutual funds in default fetch (all held securities)", async () => {
    seedSecurity(db, "VTI", { conId: 1100 }); // stock — included
    seedSecurity(db, "VTSAX", { securityType: "Mutual Fund", conId: 1200 }); // also included

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([{ type: IBApiTickType.LAST, value: 100.0 }]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    const results = await fetchSnapshotPrices(db, { asOfDate: TRADING_DAY });

    // Both should be fetched — snapshot now covers all held securities
    expect(results).toHaveLength(2);
    const symbols = results.map((r) => r.symbol).sort();
    expect(symbols).toEqual(["VTI", "VTSAX"]);
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
      asOfDate: TRADING_DAY,
      onProgress: (p) => events.push({ symbol: p.symbol, status: p.status }),
    });

    // Each security should have fetching + done events
    const fetchingEvents = events.filter((e) => e.status === "fetching");
    const doneEvents = events.filter((e) => e.status === "done");
    expect(fetchingEvents.length).toBe(2);
    expect(doneEvents.length).toBe(2);
  });

  it("writes nothing on a market-closed day (weekend) — no phantom rows", async () => {
    const secId = seedSecurity(db, "AAPL", { conId: 1 });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketDataSnapshot: vi.fn().mockResolvedValue(
        mockMarketData([{ type: IBApiTickType.LAST, value: 195.5 }]),
      ),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    // 2026-01-03 is a Saturday → market closed → early return, no DB writes,
    // no TWS request. This is the guard that stops phantom weekend rows like
    // the 2026-05-31 (Sunday) prices behind the bad "Significant Moves" email.
    const results = await fetchSnapshotPrices(db, {
      securityIds: [secId],
      asOfDate: "2026-01-03",
    });

    expect(results).toEqual([]);
    const count = db.prepare("SELECT COUNT(*) as c FROM prices").get() as { c: number };
    expect(count.c).toBe(0);
    expect(mockApi.getMarketDataSnapshot).not.toHaveBeenCalled();
  });
});

describe("tickPriorityFor", () => {
  const labels = (order: Array<{ tick: number; label: string }>) => order.map((o) => o.label);

  it("puts LAST first during regular trading hours", () => {
    expect(labels(tickPriorityFor("09:30"))).toEqual([
      "LAST",
      "CLOSE",
      "DELAYED_LAST",
      "DELAYED_CLOSE",
    ]);
    expect(labels(tickPriorityFor("12:00"))).toEqual([
      "LAST",
      "CLOSE",
      "DELAYED_LAST",
      "DELAYED_CLOSE",
    ]);
    expect(labels(tickPriorityFor("15:59"))).toEqual([
      "LAST",
      "CLOSE",
      "DELAYED_LAST",
      "DELAYED_CLOSE",
    ]);
  });

  it("puts CLOSE first before the open", () => {
    expect(labels(tickPriorityFor("00:00"))).toEqual([
      "CLOSE",
      "DELAYED_CLOSE",
      "LAST",
      "DELAYED_LAST",
    ]);
    expect(labels(tickPriorityFor("09:29"))).toEqual([
      "CLOSE",
      "DELAYED_CLOSE",
      "LAST",
      "DELAYED_LAST",
    ]);
  });

  it("puts CLOSE first at and after the 16:00 close (boundary is OUTSIDE RTH)", () => {
    expect(labels(tickPriorityFor("16:00"))).toEqual([
      "CLOSE",
      "DELAYED_CLOSE",
      "LAST",
      "DELAYED_LAST",
    ]);
    expect(labels(tickPriorityFor("20:00"))).toEqual([
      "CLOSE",
      "DELAYED_CLOSE",
      "LAST",
      "DELAYED_LAST",
    ]);
    expect(labels(tickPriorityFor("23:59"))).toEqual([
      "CLOSE",
      "DELAYED_CLOSE",
      "LAST",
      "DELAYED_LAST",
    ]);
  });
});

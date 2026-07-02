import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

// Mock the TWS client module
vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(),
}));

import { getIbApi } from "@/lib/tws/client";
import { startStreaming, stopStreaming } from "@/lib/tws/streaming";

const mockedGetIbApi = vi.mocked(getIbApi);

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts?: { conId?: number; currency?: string; securityType?: string },
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, ib_con_id, currency) VALUES (?, ?, ?, ?, COALESCE(?, 'USD'))",
    )
    .run(
      symbol,
      symbol + " Corp",
      opts?.securityType ?? "stock",
      opts?.conId ?? null,
      opts?.currency ?? null,
    );
  return result.lastInsertRowid as number;
}

/** Minimal fake rxjs-shaped observable: `.subscribe(...)` returns an unsubscribable. */
function fakeMarketDataObservable() {
  return { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) };
}

describe("startStreaming — contract currency", () => {
  let db: Database.Database;

  beforeEach(() => {
    // Defensive: clear any globalThis streaming state left by a prior test/module.
    stopStreaming();
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopStreaming();
  });

  it("uses the security's own stored currency for the contract (non-USD)", () => {
    const secId = seedSecurity(db, "402340", { conId: 555, currency: "KRW" });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketData: vi.fn().mockReturnValue(fakeMarketDataObservable()),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    startStreaming(db, { securityIds: [secId] });

    expect(mockApi.getMarketData).toHaveBeenCalledWith(
      { conId: 555, secType: "STK", exchange: "SMART", currency: "KRW" },
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("defaults to USD when a security has no currency stored (NULL)", () => {
    const secId = seedSecurity(db, "AAPL", { conId: 265598 });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketData: vi.fn().mockReturnValue(fakeMarketDataObservable()),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    startStreaming(db, { securityIds: [secId] });

    const [contractArg] = mockApi.getMarketData.mock.calls[0];
    expect(contractArg.currency).toBe("USD");
  });

  it("forces USD for an OPTION contract even when the security's stored currency is non-USD (KRW)", () => {
    const secId = seedSecurity(db, "402340  260320C00045000", {
      conId: 556,
      currency: "KRW",
      securityType: "option",
    });

    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketData: vi.fn().mockReturnValue(fakeMarketDataObservable()),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);

    startStreaming(db, { securityIds: [secId] });

    expect(mockApi.getMarketData).toHaveBeenCalledWith(
      { conId: 556, secType: "OPT", exchange: "SMART", currency: "USD" },
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

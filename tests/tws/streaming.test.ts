import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

// Mock the TWS client module
vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(),
}));

import { getIbApi } from "@/lib/tws/client";
import { startStreaming, stopStreaming, getQuoteCache, snapshotToDb } from "@/lib/tws/streaming";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";

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

function seedAccount(db: Database.Database, name: string): number {
  const result = db.prepare("INSERT INTO accounts (name) VALUES (?)").run(name);
  return result.lastInsertRowid as number;
}

function insertHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, ?)",
  ).run(accountId, securityId, quantity, asOfDate);
}

/** `base` minus `days` calendar days, formatted YYYY-MM-DD (UTC, no DST skew). */
function isoDateMinusDays(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
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

describe("startStreaming — all-securities branch (no securityIds)", () => {
  let db: Database.Database;

  beforeEach(() => {
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

  function mockIbApi() {
    const mockApi = {
      setMarketDataType: vi.fn(),
      getMarketData: vi.fn().mockReturnValue(fakeMarketDataObservable()),
    };
    mockedGetIbApi.mockReturnValue(mockApi as unknown as ReturnType<typeof getIbApi>);
    return mockApi;
  }

  // NOTE: assertions below check the mocked `getMarketData` call arguments
  // (conId), not `getQuotes()` — the module's quote cache is deliberately
  // NOT cleared by `stopStreaming()` (so last-known quotes survive a
  // reconnect), which means it persists across tests in this file. Each
  // test's `mockApi` is a fresh `vi.fn()`, so its call log is clean and
  // reflects only that test's `startStreaming()` invocation.

  it("includes a statement-lag holding (older as_of_date, its only row) alongside a security with a newer row in the same account", () => {
    const acctId = seedAccount(db, "Test");
    const lagging = seedSecurity(db, "TLAG", { conId: 501 });
    const fresh = seedSecurity(db, "FRESH", { conId: 502 });

    // TLAG's only row is a month older than FRESH's — the old per-account
    // global MAX(as_of_date) subquery would have dropped it entirely
    // because it doesn't equal the account's newest date (FRESH's).
    insertHolding(db, acctId, lagging, 10, "2025-01-31");
    insertHolding(db, acctId, fresh, 20, "2025-02-28");

    const mockApi = mockIbApi();
    startStreaming(db);

    const streamedConIds = new Set(
      (mockApi.getMarketData.mock.calls as [{ conId: number }][]).map(([contract]) => contract.conId),
    );
    expect(streamedConIds.has(501)).toBe(true);
    expect(streamedConIds.has(502)).toBe(true);
  });

  it("excludes a tombstoned security (quantity=0 latest row) from streaming candidates", () => {
    const acctId = seedAccount(db, "Test");
    const tombstoned = seedSecurity(db, "GONE", { conId: 503 });

    insertHolding(db, acctId, tombstoned, 10, "2025-01-31");
    insertHolding(db, acctId, tombstoned, 0, "2025-02-28"); // tombstone: latest row, qty 0

    const mockApi = mockIbApi();
    startStreaming(db);

    const streamedConIds = new Set(
      (mockApi.getMarketData.mock.calls as [{ conId: number }][]).map(([contract]) => contract.conId),
    );
    expect(streamedConIds.has(503)).toBe(false);
  });

  it("caps at 50 candidates ranked freshest-anywhere-first; a security held in two accounts is ranked by its MAX date and appears exactly once", () => {
    const acctA = seedAccount(db, "A");
    const acctB = seedAccount(db, "B");

    const BASE = "2026-03-31";
    // 50 single-account securities S01..S50: S01 has the most recent date,
    // each subsequent one a day further back, S50 the oldest.
    const ids: Record<string, number> = {};
    for (let i = 1; i <= 50; i++) {
      const symbol = `S${String(i).padStart(2, "0")}`;
      const secId = seedSecurity(db, symbol, { conId: 1000 + i });
      ids[symbol] = secId;
      insertHolding(db, acctA, secId, 10, isoDateMinusDays(BASE, i - 1));
    }

    // Two extra low-priority securities, older than every S0x row.
    const old1 = seedSecurity(db, "OLD1", { conId: 2001 });
    const old2 = seedSecurity(db, "OLD2", { conId: 2002 });
    insertHolding(db, acctA, old1, 10, "2026-01-01");
    insertHolding(db, acctA, old2, 10, "2025-12-01");

    // Multi-account security: a mid-pack row in account A plus a row in
    // account B that is fresher than every S0x row — its rank must be
    // driven by the MAX across both accounts, and it must appear once.
    const multi = seedSecurity(db, "MULTI", { conId: 3000 });
    insertHolding(db, acctA, multi, 10, "2026-02-01");
    insertHolding(db, acctB, multi, 10, "2026-04-15");

    const mockApi = mockIbApi();
    startStreaming(db);

    const calls = mockApi.getMarketData.mock.calls as [{ conId: number }][];
    expect(calls).toHaveLength(50);

    const streamedConIds = calls.map(([contract]) => contract.conId);
    const streamedConIdSet = new Set(streamedConIds);

    // MULTI ranks #1 (2026-04-15 beats every S0x date) and appears once —
    // one call, not once per account.
    expect(streamedConIdSet.has(3000)).toBe(true);
    expect(streamedConIds.filter((id) => id === 3000)).toHaveLength(1);

    // S01..S49 (49 securities, conId 1001..1049) fill the remaining slots —
    // the freshest 49 single-account rows once MULTI takes the top slot.
    for (let i = 1; i <= 49; i++) {
      expect(streamedConIdSet.has(1000 + i)).toBe(true);
    }

    // S50 and the two OLD securities are pushed out by the LIMIT 50 cutoff.
    expect(streamedConIdSet.has(1050)).toBe(false); // S50
    expect(streamedConIdSet.has(2001)).toBe(false); // OLD1
    expect(streamedConIdSet.has(2002)).toBe(false); // OLD2
  });
});

describe("snapshotToDb — synthetic-close price bump (reconciler-hardening, spec §4)", () => {
  let db: Database.Database;

  beforeEach(() => {
    stopStreaming();
    getQuoteCache().clear();
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function cacheQuote(securityId: number, symbol: string, last: number): void {
    getQuoteCache().set(securityId, {
      securityId,
      symbol,
      last,
      bid: null,
      ask: null,
      close: null,
      change: null,
      changePercent: null,
      volume: null,
      timestamp: Date.now(),
    });
  }

  it("does not bump for a held-only cache flush (routine)", () => {
    const acctId = seedAccount(db, "T");
    const secId = seedSecurity(db, "AAPL", { conId: 1 });
    insertHolding(db, acctId, secId, 100, "2026-01-01"); // held, no tombstone
    cacheQuote(secId, "AAPL", 190);
    const before = getTaxInputGeneration(db);

    const count = snapshotToDb(db);

    expect(count).toBe(1);
    expect(getTaxInputGeneration(db)).toBe(before);
  });

  it("bumps when the cached quote prices a tombstoned security — isolated PRICE path (Codex plan-review F8): snapshotToDb never writes to `holdings`", () => {
    const acctId = seedAccount(db, "T");
    const secId = seedSecurity(db, "GONE", { conId: 2 });
    // snapshotToDb stamps `new Date().toISOString().slice(0,10)` as the write
    // date — the tombstone must be dated at-or-after that for the price
    // write to fall inside the synthetic-close window.
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 0, ?, 'recon:closed-equity:g:live')`,
    ).run(acctId, secId, today);
    cacheQuote(secId, "GONE", 12.34);
    const before = getTaxInputGeneration(db);

    const count = snapshotToDb(db);

    expect(count).toBe(1);
    const holdingsCount = db.prepare("SELECT COUNT(*) c FROM holdings").get() as { c: number };
    expect(holdingsCount.c).toBe(1); // unchanged — snapshotToDb never touches holdings
    expect(getTaxInputGeneration(db)).toBe(before + 1);
  });

  it("a throw inside the transaction rolls back writes AND bump together", () => {
    const acctId = seedAccount(db, "T");
    const goneId = seedSecurity(db, "GONE", { conId: 2 });
    const boomId = seedSecurity(db, "BOOM", { conId: 3 });
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 0, ?, 'recon:closed-equity:g:live')`,
    ).run(acctId, goneId, today);
    cacheQuote(goneId, "GONE", 12.34);
    cacheQuote(boomId, "BOOM", 999999);
    const before = getTaxInputGeneration(db);

    db.exec(
      `CREATE TEMP TRIGGER boom BEFORE INSERT ON prices WHEN NEW.close_price = 999999 BEGIN SELECT RAISE(ABORT,'boom'); END`,
    );

    expect(() => snapshotToDb(db)).toThrow();

    const priceCount = db.prepare("SELECT COUNT(*) c FROM prices").get() as { c: number };
    expect(priceCount.c).toBe(0); // GONE's write rolled back with BOOM's aborted insert
    expect(getTaxInputGeneration(db)).toBe(before);
  });
});

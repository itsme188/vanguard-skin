import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { SecType } from "@stoqey/ib";

// ── Mock @stoqey/ib Observable helpers ──────────────────────────

function mockObservable<T>(value: T) {
  return {
    subscribe(observer: {
      next: (v: T) => void;
      error?: (e: Error) => void;
    }) {
      // Deliver asynchronously (like real TWS)
      const timer = setTimeout(() => observer.next(value), 5);
      return { unsubscribe: () => clearTimeout(timer) };
    },
  };
}

function mockErrorObservable(error: Error) {
  return {
    subscribe(observer: {
      next: (v: unknown) => void;
      error?: (e: Error) => void;
    }) {
      const timer = setTimeout(() => observer.error?.(error), 5);
      return { unsubscribe: () => clearTimeout(timer) };
    },
  };
}

/**
 * Build a combined AccountUpdatesUpdate matching getAccountUpdates() response.
 * Bundles positions + account summary in one emission, simulating accountDownloadEnd
 * (no added/changed/removed fields → triggers immediate resolution).
 */
function makeAccountUpdate(
  positions: Array<{
    account?: string;
    symbol: string;
    secType?: string;
    conId?: number;
    pos: number;
    avgCost?: number;
    marketPrice?: number;
    marketValue?: number;
    currency?: string;
    localSymbol?: string;
    strike?: number;
    right?: string;
    lastTradeDateOrContractMonth?: string;
    multiplier?: string;
  }>,
  nlv: number,
  cash: number,
) {
  // Build portfolio map (positions with market prices)
  const portfolio = new Map<string, unknown[]>();
  for (const p of positions) {
    const acct = p.account ?? "U1234567";
    if (!portfolio.has(acct)) portfolio.set(acct, []);
    portfolio.get(acct)!.push({
      account: acct,
      contract: {
        symbol: p.symbol,
        secType: p.secType ?? SecType.STK,
        conId: p.conId ?? Math.floor(Math.random() * 100000),
        exchange: "SMART",
        currency: p.currency ?? "USD",
        localSymbol: p.localSymbol ?? p.symbol,
        strike: p.strike,
        right: p.right,
        lastTradeDateOrContractMonth: p.lastTradeDateOrContractMonth,
        multiplier: p.multiplier,
      },
      pos: p.pos,
      avgCost: p.avgCost ?? 0,
      marketPrice: p.marketPrice ?? 0,
      marketValue: p.marketValue ?? p.pos * (p.marketPrice ?? 0),
      unrealizedPNL: 0,
      realizedPNL: 0,
    });
  }

  // Build account summary values map
  const summaryValues = new Map([
    ["NetLiquidation", new Map([["USD", { value: String(nlv), ingressTm: Date.now() }]])],
    ["TotalCashValue", new Map([["USD", { value: String(cash), ingressTm: Date.now() }]])],
  ]);
  const value = new Map([["U1234567", summaryValues]]);

  // Return as accountDownloadEnd emission (no added/changed/removed → immediate resolve)
  return { all: { portfolio, value } };
}

// ── Mock setup ──────────────────────────────────────────────────

let mockApi: {
  getAccountUpdates: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock("@/lib/tws/client", () => ({
  getIbApi: () => mockApi,
}));

// ── Tests ────────────────────────────────────────────────────────

describe("TWS portfolio sync", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    mockApi = {
      getAccountUpdates: vi.fn(),
    };
  });

  const TEST_ACCOUNT = "U1234567";

  // Dynamic import to pick up the mock
  async function getSyncPortfolio() {
    const mod = await import("@/lib/tws/positions");
    return (db: Database.Database, opts?: any) =>
      mod.syncPortfolio(db, { ibkrAccountCode: TEST_ACCOUNT, ...opts });
  }

  it("throws when TWS not connected", async () => {
    mockApi = null; // getIbApi returns null
    const syncPortfolio = await getSyncPortfolio();
    await expect(syncPortfolio(db)).rejects.toThrow("TWS not connected");
  });

  it("throws when IBKR account not found", async () => {
    // Delete the default IBKR account
    db.prepare("DELETE FROM accounts WHERE name = 'IBKR'").run();

    const syncPortfolio = await getSyncPortfolio();
    await expect(syncPortfolio(db)).rejects.toThrow("IBKR account not found");
  });

  it("syncs positions, prices, and account summary in one call", async () => {
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(makeAccountUpdate([
        { symbol: "AAPL", pos: 100, avgCost: 150, marketPrice: 175, conId: 265598 },
        { symbol: "MSFT", pos: 50, avgCost: 300, marketPrice: 420, conId: 272093 },
      ], 100000, 30000))
    );

    const syncPortfolio = await getSyncPortfolio();
    const result = await syncPortfolio(db);

    expect(result.positionsSynced).toBe(2);
    expect(result.pricesSaved).toBe(2); // market prices saved from getAccountUpdates
    expect(result.netLiquidation).toBe(100000);
    expect(result.cashBalance).toBe(30000);

    // Check holdings
    const holdings = db.prepare(
      "SELECT h.quantity, h.cost_basis, s.symbol FROM holdings h JOIN securities s ON s.id = h.security_id WHERE h.account_id = (SELECT id FROM accounts WHERE name = 'IBKR')"
    ).all() as any[];

    expect(holdings).toHaveLength(2);
    const aapl = holdings.find((h: any) => h.symbol === "AAPL");
    expect(aapl.quantity).toBe(100);
    expect(aapl.cost_basis).toBe(15000); // 100 * 150

    // Check prices were saved
    const prices = db.prepare(
      "SELECT p.close_price, s.symbol FROM prices p JOIN securities s ON s.id = p.security_id WHERE p.source = 'tws' ORDER BY s.symbol"
    ).all() as any[];
    expect(prices).toHaveLength(2);
    expect(prices.find((p: any) => p.symbol === "AAPL").close_price).toBe(175);
    expect(prices.find((p: any) => p.symbol === "MSFT").close_price).toBe(420);
  });

  it("syncs account summary into monthly_snapshots", async () => {
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(makeAccountUpdate([
        { symbol: "SPY", pos: 10, avgCost: 500, marketPrice: 550 },
      ], 234567, 50000))
    );

    const syncPortfolio = await getSyncPortfolio();
    const result = await syncPortfolio(db);

    expect(result.netLiquidation).toBe(234567);
    expect(result.cashBalance).toBe(50000);
    expect(result.snapshotInserted).toBe(true);

    const snapshot = db.prepare(
      "SELECT total_value, source FROM monthly_snapshots WHERE account_id = (SELECT id FROM accounts WHERE name = 'IBKR') ORDER BY month_end_date DESC LIMIT 1"
    ).get() as any;

    expect(snapshot.total_value).toBe(234567);
    expect(snapshot.source).toBe("tws");
  });

  it("updates ib_con_id on securities", async () => {
    // Pre-create a security without conId
    db.prepare(
      "INSERT INTO securities (symbol, name, security_type) VALUES ('GOOG', 'Alphabet', 'stock')"
    ).run();
    const secBefore = db.prepare("SELECT ib_con_id FROM securities WHERE symbol = 'GOOG'").get() as any;
    expect(secBefore.ib_con_id).toBeNull();

    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(makeAccountUpdate([
        { symbol: "GOOG", pos: 25, avgCost: 170, marketPrice: 190, conId: 208813720 },
      ], 50000, 10000))
    );

    const syncPortfolio = await getSyncPortfolio();
    await syncPortfolio(db);

    const secAfter = db.prepare("SELECT ib_con_id FROM securities WHERE symbol = 'GOOG'").get() as any;
    expect(secAfter.ib_con_id).toBe(208813720);
  });

  it("handles option positions with OCC symbols", async () => {
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(makeAccountUpdate([
        {
          symbol: "INTC",
          secType: SecType.OPT,
          pos: -5,
          avgCost: 250,
          marketPrice: 3.5,
          conId: 999999,
          strike: 45,
          right: "P",
          lastTradeDateOrContractMonth: "20260320",
          multiplier: "100",
          localSymbol: "INTC  260320P00045000",
        },
      ], 100000, 80000))
    );

    const syncPortfolio = await getSyncPortfolio();
    const result = await syncPortfolio(db);

    expect(result.positionsSynced).toBe(1);

    const sec = db.prepare(
      "SELECT symbol, security_type, option_type, strike_price FROM securities WHERE symbol LIKE 'INTC%'"
    ).get() as any;

    expect(sec.symbol).toBe("INTC  260320P00045000");
    expect(sec.security_type).toBe("Option");
    expect(sec.option_type).toBe("PUT");
    expect(sec.strike_price).toBe(45);
  });

  it("skips zero-quantity positions", async () => {
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(makeAccountUpdate([
        { symbol: "AAPL", pos: 100, avgCost: 150, marketPrice: 175 },
        { symbol: "GOOG", pos: 0, avgCost: 170, marketPrice: 190 }, // closed
      ], 50000, 10000))
    );

    const syncPortfolio = await getSyncPortfolio();
    const result = await syncPortfolio(db);

    expect(result.positionsSynced).toBe(1);

    const holdings = db.prepare(
      "SELECT COUNT(*) as count FROM holdings WHERE account_id = (SELECT id FROM accounts WHERE name = 'IBKR')"
    ).get() as any;
    expect(holdings.count).toBe(1);
  });

  it("re-sync replaces same-day holdings (idempotent)", async () => {
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(makeAccountUpdate([
        { symbol: "AAPL", pos: 100, avgCost: 150, marketPrice: 175, conId: 265598 },
      ], 50000, 10000))
    );

    const syncPortfolio = await getSyncPortfolio();

    // First sync
    await syncPortfolio(db);

    // Second sync with different quantity
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(makeAccountUpdate([
        { symbol: "AAPL", pos: 200, avgCost: 155, marketPrice: 180, conId: 265598 },
      ], 50000, 10000))
    );

    await syncPortfolio(db);

    // Should have exactly 1 holding, not 2
    const holdings = db.prepare(
      "SELECT quantity, cost_basis FROM holdings WHERE account_id = (SELECT id FROM accounts WHERE name = 'IBKR')"
    ).all() as any[];

    expect(holdings).toHaveLength(1);
    expect(holdings[0].quantity).toBe(200);
    expect(holdings[0].cost_basis).toBe(31000); // 200 * 155
  });

  it("persists a non-USD contract currency onto the security", async () => {
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(makeAccountUpdate([
        { symbol: "402340", pos: 10, avgCost: 1_632_979.2, marketPrice: 1_731_000, currency: "KRW", conId: 555 },
      ], 484374.59, 64983.18))
    );

    const syncPortfolio = await getSyncPortfolio();
    await syncPortfolio(db);

    const sec = db.prepare("SELECT currency FROM securities WHERE symbol = '402340'").get() as any;
    expect(sec.currency).toBe("KRW");
  });

  it("derives + persists an FX rate from marketValue/marketPrice for a non-USD position", async () => {
    // marketValue here is the USD-base figure the broker reports (per the
    // documented assumption — see the code comment in syncPortfolio).
    const usdMarketValue = 12705; // 10 sh × 1,731,000 KRW × ~0.000734
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(makeAccountUpdate([
        {
          symbol: "402340", pos: 10, avgCost: 1_632_979.2, marketPrice: 1_731_000,
          marketValue: usdMarketValue, currency: "KRW", conId: 555,
        },
      ], 484374.59, 64983.18))
    );

    const syncPortfolio = await getSyncPortfolio();
    await syncPortfolio(db);

    const fx = db.prepare("SELECT currency, usd_per_unit, source FROM fx_rates WHERE currency = 'KRW'").get() as any;
    expect(fx).toBeDefined();
    expect(fx.usd_per_unit).toBeCloseTo(0.000734, 6);
    expect(fx.source).toBe("tws_derived");
  });

  it("does not write an fx_rates row for a USD position", async () => {
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(makeAccountUpdate([
        { symbol: "AAPL", pos: 100, avgCost: 150, marketPrice: 175, conId: 265598 },
      ], 100000, 30000))
    );

    const syncPortfolio = await getSyncPortfolio();
    await syncPortfolio(db);

    const count = db.prepare("SELECT COUNT(*) c FROM fx_rates").get() as any;
    expect(count.c).toBe(0);
  });

  it("enriches new securities with ib_con_id during sync", async () => {
    mockApi!.getAccountUpdates.mockReturnValue(
      mockObservable(makeAccountUpdate([
        { symbol: "TSLA", pos: 50, avgCost: 200, conId: 76792991 },
      ], 50000, 10000))
    );

    const syncPortfolio = await getSyncPortfolio();
    await syncPortfolio(db);

    const sec = db.prepare(
      "SELECT ib_con_id, security_type FROM securities WHERE symbol = 'TSLA'"
    ).get() as any;

    expect(sec.ib_con_id).toBe(76792991);
    expect(sec.security_type).toBe("Stock");
  });
});

// ── buildSymbol unit tests ──────────────────────────────────────

describe("buildSymbol", () => {
  it("returns plain symbol for stocks", async () => {
    const { buildSymbol } = await import("@/lib/tws/positions");
    const symbol = buildSymbol({
      symbol: "AAPL",
      secType: SecType.STK,
      conId: 265598,
    } as any);
    expect(symbol).toBe("AAPL");
  });

  it("builds OCC format for options", async () => {
    const { buildSymbol } = await import("@/lib/tws/positions");
    const symbol = buildSymbol({
      symbol: "INTC",
      secType: SecType.OPT,
      strike: 45,
      right: "P",
      lastTradeDateOrContractMonth: "20260320",
    } as any);
    expect(symbol).toBe("INTC  260320P00045000");
  });

  it("builds OCC format for calls", async () => {
    const { buildSymbol } = await import("@/lib/tws/positions");
    const symbol = buildSymbol({
      symbol: "AAPL",
      secType: SecType.OPT,
      strike: 250,
      right: "C",
      lastTradeDateOrContractMonth: "20261218",
    } as any);
    expect(symbol).toBe("AAPL  261218C00250000");
  });

  it("handles fractional strike prices", async () => {
    const { buildSymbol } = await import("@/lib/tws/positions");
    const symbol = buildSymbol({
      symbol: "SPY",
      secType: SecType.OPT,
      strike: 565.5,
      right: "C",
      lastTradeDateOrContractMonth: "20260515",
    } as any);
    expect(symbol).toBe("SPY   260515C00565500");
  });
});

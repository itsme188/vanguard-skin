/**
 * DECISIONS 2026-10-26 item 1: the TWS sync writes no price, holdings or
 * live-snapshot row dated on a day the market is closed (weekend or full NYSE
 * holiday), the same rule the IBKR Web API quote path and the snapshot-price
 * step already follow. Security metadata may still update.
 *
 * Covers both TWS-path writers of a dated close that had no guard:
 *   - syncPortfolio (lib/tws/positions.ts): holdings, prices, monthly_snapshots
 *   - snapshotToDb  (lib/tws/streaming.ts): prices
 * plus the downstream promise: a closed-day sync cannot make the closed-equity
 * reconciler mint a tombstone or bump tax_input_generation.
 *
 * All figures are synthetic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SecType } from "@stoqey/ib";
import { runMigrations } from "@/lib/db/migrate";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import { reconcileClosedEquityHoldings } from "@/lib/mutations/closed-equity";

const SATURDAY = "2026-03-14";
const SUNDAY = "2026-03-15";
const HOLIDAY = "2026-07-03"; // Independence Day observed (Friday)
const TRADING_DAY = "2026-03-13"; // Friday

function mockObservable<T>(value: T) {
  return {
    subscribe(observer: { next: (v: T) => void; error?: (e: Error) => void }) {
      const timer = setTimeout(() => observer.next(value), 5);
      return { unsubscribe: () => clearTimeout(timer) };
    },
  };
}

function makeAccountUpdate(
  positions: Array<{ symbol: string; conId: number; pos: number; avgCost: number; marketPrice: number }>,
  nlv: number,
  cash: number,
) {
  const portfolio = new Map<string, unknown[]>();
  portfolio.set(
    "U1234567",
    positions.map((p) => ({
      account: "U1234567",
      contract: {
        symbol: p.symbol,
        secType: SecType.STK,
        conId: p.conId,
        exchange: "SMART",
        currency: "USD",
        localSymbol: p.symbol,
      },
      pos: p.pos,
      avgCost: p.avgCost,
      marketPrice: p.marketPrice,
      marketValue: p.pos * p.marketPrice,
      unrealizedPNL: 0,
      realizedPNL: 0,
    })),
  );
  const summaryValues = new Map([
    ["NetLiquidation", new Map([["USD", { value: String(nlv), ingressTm: Date.now() }]])],
    ["TotalCashValue", new Map([["USD", { value: String(cash), ingressTm: Date.now() }]])],
  ]);
  return { all: { portfolio, value: new Map([["U1234567", summaryValues]]) } };
}

let mockApi: { getAccountUpdates: ReturnType<typeof vi.fn> } | null = null;
vi.mock("@/lib/tws/client", () => ({ getIbApi: () => mockApi }));

const TWO_POSITIONS = [
  { symbol: "ZZA", conId: 111, pos: 10, avgCost: 20, marketPrice: 25 },
  { symbol: "ZZB", conId: 222, pos: 5, avgCost: 40, marketPrice: 45 },
];

describe("syncPortfolio on a closed market day", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    mockApi = { getAccountUpdates: vi.fn() };
  });

  async function sync(asOfDate: string, positions = TWO_POSITIONS) {
    mockApi!.getAccountUpdates.mockReturnValue(mockObservable(makeAccountUpdate(positions, 1000, 100)));
    const mod = await import("@/lib/tws/positions");
    return mod.syncPortfolio(db, { ibkrAccountCode: "U1234567", asOfDate });
  }

  function ibkrId(): number {
    return (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
  }
  function count(sql: string, ...params: unknown[]): number {
    return (db.prepare(sql).get(...params) as { c: number }).c;
  }

  it.each([
    ["Saturday", SATURDAY],
    ["Sunday", SUNDAY],
    ["a full-closure holiday", HOLIDAY],
  ])("writes no holdings, price or account snapshot row on %s", async (_label, day) => {
    const result = await sync(day);

    expect(result.skippedReason).toBe("market_closed");
    expect(result.positionsSynced).toBe(0);
    expect(result.pricesSaved).toBe(0);
    expect(result.snapshotInserted).toBe(false);
    expect(count("SELECT COUNT(*) AS c FROM holdings")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM prices")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM monthly_snapshots WHERE account_id = ?", ibkrId())).toBe(0);

    // Metadata still updates: the securities exist and carry their contract ids.
    const secs = db
      .prepare("SELECT symbol, ib_con_id FROM securities WHERE symbol IN ('ZZA','ZZB') ORDER BY symbol")
      .all();
    expect(secs).toEqual([
      { symbol: "ZZA", ib_con_id: 111 },
      { symbol: "ZZB", ib_con_id: 222 },
    ]);
  });

  it("writes holdings, prices and the account snapshot on a trading day", async () => {
    const result = await sync(TRADING_DAY);

    expect(result.skippedReason).toBeNull();
    expect(result.positionsSynced).toBe(2);
    expect(result.pricesSaved).toBe(2);
    expect(result.snapshotInserted).toBe(true);
    expect(count("SELECT COUNT(*) AS c FROM holdings WHERE as_of_date = ?", TRADING_DAY)).toBe(2);
    expect(count("SELECT COUNT(*) AS c FROM prices WHERE date = ?", TRADING_DAY)).toBe(2);
    expect(
      count(
        "SELECT COUNT(*) AS c FROM monthly_snapshots WHERE account_id = ? AND month_end_date = ? AND source = 'tws'",
        ibkrId(),
        TRADING_DAY,
      ),
    ).toBe(1);
  });

  it("a weekend sync after a trading-day sync leaves the reconciler and the tax generation untouched", async () => {
    await sync(TRADING_DAY);
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    const genBefore = getTaxInputGeneration(db);
    const holdingsBefore = db.prepare("SELECT * FROM holdings ORDER BY id").all();

    // Saturday: TWS reports only one of the two names (e.g. a partial
    // download). Nothing is dated Saturday, so nothing reads it as a close.
    const result = await sync(SATURDAY, [TWO_POSITIONS[0]]);
    expect(result.skippedReason).toBe("market_closed");
    expect(result.staleRowsRemoved).toBe(0);

    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    expect(db.prepare("SELECT * FROM holdings ORDER BY id").all()).toEqual(holdingsBefore);
    expect(count("SELECT COUNT(*) AS c FROM holdings WHERE quantity = 0")).toBe(0);
    expect(getTaxInputGeneration(db)).toBe(genBefore);
  });
});

describe("snapshotToDb on a closed market day", () => {
  let db: Database.Database;

  beforeEach(async () => {
    const { stopStreaming, getQuoteCache } = await import("@/lib/tws/streaming");
    stopStreaming();
    getQuoteCache().clear();
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const secId = db
      .prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZA', 'Stock')")
      .run().lastInsertRowid as number;
    getQuoteCache().set(secId, {
      securityId: secId,
      symbol: "ZZA",
      last: 25,
      bid: null,
      ask: null,
      close: null,
      change: null,
      changePercent: null,
      volume: null,
      timestamp: Date.now(),
    });
  });

  it.each([SATURDAY, SUNDAY, HOLIDAY])("writes no price row on %s", async (day) => {
    const { snapshotToDb } = await import("@/lib/tws/streaming");
    expect(snapshotToDb(db, { asOfDate: day })).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM prices").get() as { c: number }).c).toBe(0);
  });

  it("saveStreamingSnapshot names the skip so the Save button can say why nothing was stored", async () => {
    const { saveStreamingSnapshot } = await import("@/lib/tws/streaming");
    expect(saveStreamingSnapshot(db, { asOfDate: SUNDAY })).toEqual({ pricesSaved: 0, skippedReason: "market_closed" });
    expect(saveStreamingSnapshot(db, { asOfDate: TRADING_DAY })).toEqual({ pricesSaved: 1, skippedReason: null });
  });

  it("the stream route returns the skip reason and the Save button words it", () => {
    const route = readFileSync(path.join(process.cwd(), "app/api/tws/stream/route.ts"), "utf8");
    expect(route).toContain("pricesSaved, skippedReason");
    const hook = readFileSync(path.join(process.cwd(), "lib/hooks/useStreamingQuotes.ts"), "utf8");
    expect(hook).toContain("readMutationResult");
    const ui = readFileSync(path.join(process.cwd(), "app/dashboard/components/TwsStatus.tsx"), "utf8");
    expect(ui).toContain('saved.skippedReason === "market_closed"');
    expect(ui).toContain("Market closed today: nothing dated today stored");
  });

  it("writes the price row on a trading day", async () => {
    const { snapshotToDb } = await import("@/lib/tws/streaming");
    expect(snapshotToDb(db, { asOfDate: TRADING_DAY })).toBe(1);
    expect(db.prepare("SELECT date, source FROM prices").all()).toEqual([
      { date: TRADING_DAY, source: "tws" },
    ]);
  });
});

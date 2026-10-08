import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { fetchBenchmarkPrices } from "@/lib/tws/benchmark";

vi.mock("@/lib/tws/client", () => ({
  getIbApi: () => ({
    getContractDetails: vi.fn(async () => []),
    getHistoricalData: vi.fn(async () => {
      throw new Error("synthetic TWS timeout");
    }),
  }),
}));

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedBenchmarkSecurity(symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, security_type, ib_con_id) VALUES (?, 'ETF', 12345)")
    .run(symbol).lastInsertRowid as number;
}

function bar(securityId: number, date: string, close: number) {
  db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 100)
     ON CONFLICT(security_id, bar_date, bar_size) DO UPDATE SET close = excluded.close`,
  ).run(securityId, date, close, close + 1, close - 1, close);
}

function price(securityId: number, date: string, close: number) {
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(securityId, date, close);
}

function benchmarkRows() {
  return db
    .prepare("SELECT date, close_price AS close FROM benchmark_prices WHERE symbol = 'ZZBM' ORDER BY date")
    .all() as { date: string; close: number }[];
}

describe("benchmark fallback cache source selection", () => {
  it("uses bar-cache source by symbol, updates existing bar dates, and never falls through to prices", async () => {
    const sec = seedBenchmarkSecurity("ZZBM");
    bar(sec, "2026-01-02", 10);
    bar(sec, "2026-01-05", 12);
    price(sec, "2026-01-03", 99);

    const first = await fetchBenchmarkPrices(db, { symbols: ["ZZBM"], incremental: false });
    expect(first[0].barsInserted).toBe(2);
    expect(benchmarkRows()).toEqual([
      { date: "2026-01-02", close: 10 },
      { date: "2026-01-05", close: 12 },
    ]);

    bar(sec, "2026-01-02", 11);
    const second = await fetchBenchmarkPrices(db, { symbols: ["ZZBM"], incremental: false });
    expect(second[0].barsInserted).toBe(2);
    expect(benchmarkRows()).toEqual([
      { date: "2026-01-02", close: 11 },
      { date: "2026-01-05", close: 12 },
    ]);

    const third = await fetchBenchmarkPrices(db, { symbols: ["ZZBM"], incremental: false });
    expect(third[0].barsInserted).toBe(2);
    expect(benchmarkRows().map((row) => row.date)).toEqual(["2026-01-02", "2026-01-05"]);
  });
});

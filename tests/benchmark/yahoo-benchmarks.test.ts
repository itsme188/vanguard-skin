import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { fetchBenchmarkClosesFromYahoo } from "@/lib/benchmark/yahoo-benchmarks";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE benchmark_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'tws',
      UNIQUE(symbol, date)
    );
  `);
  return db;
}

describe("fetchBenchmarkClosesFromYahoo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  it("upserts date-stamped closes from the injected series fetcher", async () => {
    const stub = async () => ({
      SPY: [
        { date: "2026-06-04", close: 757.09 },
        { date: "2026-06-05", close: 737.55 },
      ],
      MTUM: [{ date: "2026-06-05", close: 306.47 }],
    });

    const results = await fetchBenchmarkClosesFromYahoo(db, {
      symbols: ["SPY", "MTUM"],
      fetchSeries: stub,
    });

    const spy = db
      .prepare(
        "SELECT date, close_price, source FROM benchmark_prices WHERE symbol='SPY' ORDER BY date",
      )
      .all();
    expect(spy).toEqual([
      { date: "2026-06-04", close_price: 757.09, source: "yahoo" },
      { date: "2026-06-05", close_price: 737.55, source: "yahoo" },
    ]);
    expect(results.find((r) => r.symbol === "MTUM")?.inserted).toBe(1);
  });

  it("overwrites an existing (symbol, date) close — Yahoo top-off wins", async () => {
    db.prepare(
      "INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', '2026-06-05', 700, 'tws')",
    ).run();
    const stub = async () => ({ SPY: [{ date: "2026-06-05", close: 737.55 }] });

    await fetchBenchmarkClosesFromYahoo(db, { symbols: ["SPY"], fetchSeries: stub });

    const row = db
      .prepare(
        "SELECT close_price, source FROM benchmark_prices WHERE symbol='SPY' AND date='2026-06-05'",
      )
      .get();
    expect(row).toEqual({ close_price: 737.55, source: "yahoo" });
  });

  it("skips non-positive closes", async () => {
    const stub = async () => ({
      SPY: [
        { date: "2026-06-04", close: 0 },
        { date: "2026-06-05", close: 737.55 },
      ],
    });

    const results = await fetchBenchmarkClosesFromYahoo(db, {
      symbols: ["SPY"],
      fetchSeries: stub,
    });

    expect(
      db.prepare("SELECT date FROM benchmark_prices WHERE symbol='SPY'").all(),
    ).toEqual([{ date: "2026-06-05" }]);
    expect(results[0].inserted).toBe(1);
  });

  it("returns empty and writes nothing when the fetcher yields null", async () => {
    const stub = async () => null;

    const results = await fetchBenchmarkClosesFromYahoo(db, {
      symbols: ["SPY"],
      fetchSeries: stub,
    });

    expect(results).toEqual([]);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM benchmark_prices").get() as { c: number }).c,
    ).toBe(0);
  });
});

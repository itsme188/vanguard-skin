import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeBenchmarkComparison, getBenchmarkChartData } from "@/lib/compute/benchmark";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE daily_valuations (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      valuation_date TEXT NOT NULL,
      cash_balance REAL NOT NULL DEFAULT 0,
      holdings_value REAL NOT NULL DEFAULT 0,
      total_value REAL NOT NULL DEFAULT 0,
      UNIQUE(account_id, valuation_date)
    );

    CREATE TABLE benchmark_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'test',
      UNIQUE(symbol, date)
    );
  `);

  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
  return db;
}

/** Generate YYYY-MM-DD from offset. */
function makeDate(offset: number): string {
  const y = 2025;
  let d = 2 + offset;
  let m = 0;
  const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  while (d > monthDays[m]) {
    d -= monthDays[m];
    m++;
  }
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function seedData(
  db: Database.Database,
  portfolioValues: number[],
  benchmarkPrices: number[],
  benchSymbol = "SPY"
) {
  const dvStmt = db.prepare(
    "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (1, ?, 0, ?, ?)"
  );
  const bpStmt = db.prepare(
    "INSERT INTO benchmark_prices (symbol, date, close_price) VALUES (?, ?, ?)"
  );

  const count = Math.min(portfolioValues.length, benchmarkPrices.length);
  for (let i = 0; i < count; i++) {
    const date = makeDate(i);
    dvStmt.run(date, portfolioValues[i], portfolioValues[i]);
    bpStmt.run(benchSymbol, date, benchmarkPrices[i]);
  }
}

describe("computeBenchmarkComparison", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns null with insufficient data", () => {
    const result = computeBenchmarkComparison(db, { benchmarkSymbol: "SPY" });
    expect(result).toBeNull();
  });

  it("computes alpha correctly", () => {
    // Portfolio: 100 → 120 (20% return)
    // Benchmark: 100 → 110 (10% return)
    const portfolio = Array.from({ length: 50 }, (_, i) => 100 + i * (20 / 49));
    const benchmark = Array.from({ length: 50 }, (_, i) => 100 + i * (10 / 49));
    seedData(db, portfolio, benchmark);

    const result = computeBenchmarkComparison(db, { benchmarkSymbol: "SPY" });
    expect(result).not.toBeNull();
    expect(result!.portfolioReturn).toBeCloseTo(0.2, 1);
    expect(result!.benchmarkReturn).toBeCloseTo(0.1, 1);
    expect(result!.alpha).toBeCloseTo(0.1, 1); // 20% - 10%
    expect(result!.dataPoints).toBe(50);
  });

  it("computes tracking error and information ratio", () => {
    // Portfolio with some noise vs smooth benchmark
    const portfolio = Array.from({ length: 100 }, (_, i) => {
      return 100 + i * 0.2 + Math.sin(i * 0.5) * 2;
    });
    const benchmark = Array.from({ length: 100 }, (_, i) => 100 + i * 0.15);
    seedData(db, portfolio, benchmark);

    const result = computeBenchmarkComparison(db, { benchmarkSymbol: "SPY" });
    expect(result).not.toBeNull();
    expect(result!.trackingError).not.toBeNull();
    expect(result!.trackingError!).toBeGreaterThan(0);
    expect(result!.informationRatio).not.toBeNull();
    expect(result!.correlation).not.toBeNull();
  });

  it("reports high correlation for correlated series", () => {
    // Portfolio tracks benchmark closely with slight outperformance
    const benchmark = Array.from({ length: 100 }, (_, i) => 100 + i * 0.2);
    const portfolio = benchmark.map((v) => v * 1.05); // 5% above
    seedData(db, portfolio, benchmark);

    const result = computeBenchmarkComparison(db, { benchmarkSymbol: "SPY" });
    expect(result).not.toBeNull();
    expect(result!.correlation).not.toBeNull();
    expect(result!.correlation!).toBeGreaterThan(0.99); // nearly perfect
  });

  it("respects date range filtering", () => {
    const portfolio = Array.from({ length: 100 }, (_, i) => 100 + i);
    const benchmark = Array.from({ length: 100 }, (_, i) => 100 + i * 0.8);
    seedData(db, portfolio, benchmark);

    const result = computeBenchmarkComparison(db, {
      benchmarkSymbol: "SPY",
      startDate: "2025-02-01",
      endDate: "2025-03-01",
    });
    expect(result).not.toBeNull();
    expect(result!.dataPoints).toBeLessThan(100);
    expect(result!.dataPoints).toBeGreaterThan(0);
  });
});

describe("getBenchmarkChartData", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns percent change data normalized to 0%", () => {
    // Portfolio: 100 → 130 (30%)
    // Benchmark: 100 → 115 (15%)
    const portfolio = Array.from({ length: 30 }, (_, i) => 100 + i);
    const benchmark = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
    seedData(db, portfolio, benchmark);

    const data = getBenchmarkChartData(db, { benchmarkSymbol: "SPY" });
    expect(data.length).toBe(30);

    // First point should be 0%
    expect(data[0].portfolioReturn).toBe(0);
    expect(data[0].benchmarkReturn).toBe(0);

    // Last point should reflect total returns
    const lastP = data[data.length - 1].portfolioReturn;
    const lastB = data[data.length - 1].benchmarkReturn;
    expect(lastP).toBeGreaterThan(lastB); // portfolio outperformed
    expect(lastP).toBeCloseTo(29, 0); // ~29%
  });

  it("returns empty array with no data", () => {
    const data = getBenchmarkChartData(db, { benchmarkSymbol: "SPY" });
    expect(data).toHaveLength(0);
  });
});

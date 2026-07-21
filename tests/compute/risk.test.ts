import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computeRiskMetrics, computePositionRisk } from "@/lib/compute/risk";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Minimal schema for risk computation
  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      security_type TEXT DEFAULT 'stock',
      multiplier REAL DEFAULT 1,
      currency TEXT NOT NULL DEFAULT 'USD'
    );

    CREATE TABLE fx_rates (
      currency TEXT PRIMARY KEY,
      usd_per_unit REAL NOT NULL,
      as_of TEXT NOT NULL,
      source TEXT
    );

    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      as_of_date TEXT NOT NULL,
      quantity REAL NOT NULL,
      cost_basis REAL,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (security_id) REFERENCES securities(id)
    );

    CREATE TABLE prices (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT DEFAULT 'test',
      UNIQUE(security_id, date),
      FOREIGN KEY (security_id) REFERENCES securities(id)
    );

    CREATE TABLE daily_valuations (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      valuation_date TEXT NOT NULL,
      cash_balance REAL NOT NULL DEFAULT 0,
      holdings_value REAL NOT NULL DEFAULT 0,
      total_value REAL NOT NULL DEFAULT 0,
      UNIQUE(account_id, valuation_date),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      trade_date TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL,
      is_external_flow INTEGER DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
  `);

  return db;
}

/** Generate a YYYY-MM-DD date string offset by `days` from 2025-01-02. */
function makeDate(days: number): string {
  const y = 2025;
  // Convert to day-of-year starting Jan 2 (day 2)
  let d = 2 + days;
  let m = 0;
  const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  while (d > monthDays[m]) {
    d -= monthDays[m];
    m++;
  }
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function seedDailyValuations(db: Database.Database, values: number[]) {
  db.exec("INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test Account')");

  const stmt = db.prepare(
    "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, 0, ?, ?)"
  );

  for (let i = 0; i < values.length; i++) {
    stmt.run(1, makeDate(i), values[i], values[i]);
  }
}

function seedHoldings(
  db: Database.Database,
  positions: { symbol: string; quantity: number; price: number; type?: string }[]
) {
  if (!db.prepare("SELECT id FROM accounts WHERE id = 1").get()) {
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test Account')");
  }

  const today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    db.prepare("INSERT INTO securities (id, symbol, name, security_type) VALUES (?, ?, ?, ?)").run(
      i + 1,
      p.symbol,
      p.symbol,
      p.type ?? "stock"
    );
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, ?, ?, ?)"
    ).run(i + 1, today, p.quantity);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(
      i + 1,
      today,
      p.price
    );
  }
}

describe("computeRiskMetrics", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns nulls with insufficient data", () => {
    seedDailyValuations(db, [100, 101]);
    const result = computeRiskMetrics(db);
    expect(result.dataPoints).toBe(2);
    expect(result.volatility).toBeNull();
    expect(result.sharpeRatio).toBeNull();
  });

  it("computes max drawdown correctly", () => {
    // Portfolio goes 100 → 120 → 90 → 110 (drawdown = 25% from 120 to 90)
    const values = Array.from({ length: 50 }, (_, i) => {
      if (i <= 10) return 100 + i * 2; // rise to 120
      if (i <= 25) return 120 - (i - 10) * 2; // drop to 90
      return 90 + (i - 25) * 0.8; // recover
    });
    seedDailyValuations(db, values);

    const result = computeRiskMetrics(db);
    expect(result.maxDrawdown).not.toBeNull();
    expect(result.maxDrawdown!.percent).toBeCloseTo(0.25, 2); // 25%
    expect(result.maxDrawdown!.peakValue).toBe(120);
    expect(result.maxDrawdown!.troughValue).toBe(90);
  });

  it("reports no drawdown when values only go up", () => {
    const values = Array.from({ length: 50 }, (_, i) => 100 + i);
    seedDailyValuations(db, values);

    const result = computeRiskMetrics(db);
    expect(result.maxDrawdown).toBeNull();
    expect(result.currentDrawdown).toBeNull();
  });

  it("computes current drawdown when below peak", () => {
    // Rise to 150, then drop to 120
    const values = Array.from({ length: 50 }, (_, i) => {
      if (i <= 30) return 100 + i * (50 / 30);
      return 150 - (i - 30) * 1.5;
    });
    seedDailyValuations(db, values);

    const result = computeRiskMetrics(db);
    expect(result.currentDrawdown).not.toBeNull();
    expect(result.currentDrawdown!.peakValue).toBe(150);
    expect(result.currentDrawdown!.percent).toBeGreaterThan(0);
  });

  it("computes volatility and Sharpe ratio", () => {
    // Generate somewhat volatile series
    const values = Array.from({ length: 100 }, (_, i) => {
      const trend = 100 + i * 0.1;
      const noise = Math.sin(i * 0.5) * 3;
      return trend + noise;
    });
    seedDailyValuations(db, values);

    const result = computeRiskMetrics(db);
    expect(result.volatility).not.toBeNull();
    expect(result.volatility!).toBeGreaterThan(0);
    expect(result.sharpeRatio).not.toBeNull();
  });

  it("computes Herfindahl and top-5 concentration", () => {
    // Create holdings: 50%, 25%, 15%, 5%, 3%, 2%
    seedHoldings(db, [
      { symbol: "AAPL", quantity: 50, price: 100 },  // 50%
      { symbol: "MSFT", quantity: 25, price: 100 },  // 25%
      { symbol: "GOOG", quantity: 15, price: 100 },  // 15%
      { symbol: "AMZN", quantity: 5, price: 100 },   // 5%
      { symbol: "META", quantity: 3, price: 100 },    // 3%
      { symbol: "NVDA", quantity: 2, price: 100 },    // 2%
    ]);
    // Need some daily valuations too for the metrics to compute
    seedDailyValuations(db, Array.from({ length: 50 }, () => 10000));

    const result = computeRiskMetrics(db);
    expect(result.herfindahl).not.toBeNull();
    // Herfindahl = 0.50^2 + 0.25^2 + 0.15^2 + 0.05^2 + 0.03^2 + 0.02^2
    expect(result.herfindahl!).toBeCloseTo(0.3388, 2);
    expect(result.top5Positions).toHaveLength(5);
    expect(result.top5Concentration).toBeCloseTo(0.98, 2);
    expect(result.top5Positions[0].symbol).toBe("AAPL");
    expect(result.positionCount).toBe(6);
  });

  it("handles empty portfolio gracefully", () => {
    const result = computeRiskMetrics(db);
    expect(result.dataPoints).toBe(0);
    expect(result.maxDrawdown).toBeNull();
    expect(result.volatility).toBeNull();
    expect(result.herfindahl).toBeNull();
    expect(result.top5Positions).toHaveLength(0);
  });

  it("respects date range filtering", () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 + i * 0.5);
    seedDailyValuations(db, values);

    const result = computeRiskMetrics(db, { startDate: "2025-02-01", endDate: "2025-03-01" });
    expect(result.dataPoints).toBeLessThan(100);
    expect(result.dataPoints).toBeGreaterThan(0);
  });

  it("respects accountId filtering", () => {
    seedDailyValuations(db, Array.from({ length: 50 }, (_, i) => 100 + i));

    // Add second account
    db.exec("INSERT INTO accounts (id, name) VALUES (2, 'Account 2')");
    const stmt = db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (2, ?, 0, ?, ?)"
    );
    for (let i = 0; i < 50; i++) {
      const date = new Date("2025-01-02");
      date.setDate(date.getDate() + i);
      const val = 50 + i * 2;
      stmt.run(date.toISOString().slice(0, 10), val, val);
    }

    const all = computeRiskMetrics(db);
    const acct1 = computeRiskMetrics(db, { accountId: 1 });
    const acct2 = computeRiskMetrics(db, { accountId: 2 });

    expect(all.dataPoints).toBe(50);
    expect(acct1.dataPoints).toBe(50);
    expect(acct2.dataPoints).toBe(50);
    // Combined values are higher
    expect(all.volatility).not.toEqual(acct1.volatility);
  });
});

describe("series window exposure (seriesStart/seriesEnd)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("exposes the actual valuation window used for the metrics", () => {
    seedDailyValuations(db, [100, 101, 102, 103, 104]);
    const bounds = db
      .prepare("SELECT MIN(valuation_date) AS lo, MAX(valuation_date) AS hi FROM daily_valuations")
      .get() as { lo: string; hi: string };

    const result = computeRiskMetrics(db);
    expect(result.seriesStart).toBe(bounds.lo);
    expect(result.seriesEnd).toBe(bounds.hi);
  });

  it("returns null window when there are no valuations", () => {
    const result = computeRiskMetrics(db);
    expect(result.seriesStart).toBeNull();
    expect(result.seriesEnd).toBeNull();
  });
});

describe("external cash-flow adjustment", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  /** Insert an external flow (negative = withdrawal, positive = deposit). */
  function seedFlow(date: string, amount: number, accountId = 1) {
    db.prepare(
      "INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow) VALUES (?, ?, ?, ?, 1)"
    ).run(accountId, date, amount < 0 ? "WITHDRAWAL" : "DEPOSIT", amount);
  }

  it("does not count a withdrawal as a drawdown", () => {
    // Flat $100k market; $40k leaves on day 30. Raw series shows a 40% "crash";
    // flow-adjusted there is no market movement at all.
    const values = Array.from({ length: 60 }, (_, i) => (i < 30 ? 100_000 : 60_000));
    seedDailyValuations(db, values);
    seedFlow(makeDate(30), -40_000);

    const result = computeRiskMetrics(db);
    expect(result.maxDrawdown).toBeNull();
    expect(result.currentDrawdown).toBeNull();
    expect(result.volatility).toBeCloseTo(0, 6);
  });

  it("does not count a deposit as a gain", () => {
    const values = Array.from({ length: 60 }, (_, i) => (i < 30 ? 100_000 : 150_000));
    seedDailyValuations(db, values);
    seedFlow(makeDate(30), 50_000);

    const result = computeRiskMetrics(db);
    expect(result.maxDrawdown).toBeNull();
    expect(result.volatility).toBeCloseTo(0, 6);
  });

  it("preserves the real market drawdown across a withdrawal", () => {
    // Market: +2%/day days 1-10, -1%/day days 11-20, +0.1%/day after.
    // A $20k withdrawal lands on day 15, mid-decline. True peak-to-trough
    // market drawdown is 1 - 0.99^10 ≈ 9.56%; the raw value series would
    // show ~25% because of the withdrawal.
    const values: number[] = [100_000];
    for (let i = 1; i < 60; i++) {
      const r = i <= 10 ? 0.02 : i <= 20 ? -0.01 : 0.001;
      values.push(values[i - 1] * (1 + r) + (i === 15 ? -20_000 : 0));
    }
    seedDailyValuations(db, values);
    seedFlow(makeDate(15), -20_000);

    const result = computeRiskMetrics(db);
    expect(result.maxDrawdown).not.toBeNull();
    expect(result.maxDrawdown!.percent).toBeCloseTo(1 - 0.99 ** 10, 3);
    expect(result.maxDrawdown!.peakDate).toBe(makeDate(10));
    expect(result.maxDrawdown!.troughDate).toBe(makeDate(20));
    // Dollar fields keep reporting the actual account value on those dates.
    expect(result.maxDrawdown!.peakValue).toBeCloseTo(values[10], 0);
    expect(result.maxDrawdown!.troughValue).toBeCloseTo(values[20], 0);
  });

  it("keeps Sharpe positive when a large withdrawal lands mid-series", () => {
    // Gentle upward drift with noise; a 30% withdrawal on day 50. Raw returns
    // would include a -30% "day" that flips the mean (and Sharpe) negative.
    const values: number[] = [100_000];
    for (let i = 1; i < 100; i++) {
      const r = 0.001 + Math.sin(i) * 0.005;
      values.push(values[i - 1] * (1 + r) + (i === 50 ? -30_000 : 0));
    }
    seedDailyValuations(db, values);
    seedFlow(makeDate(50), -30_000);

    const result = computeRiskMetrics(db, { riskFreeRate: 0.045 });
    expect(result.sharpeRatio).not.toBeNull();
    expect(result.sharpeRatio!).toBeGreaterThan(0);
  });

  it("attributes a flow dated on a missing valuation day to the next valuation date", () => {
    // Valuations exist for days 0..40 EXCEPT day 15 (e.g. a weekend). The
    // withdrawal is dated day 15; its effect first appears in day 16's value.
    db.exec("INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test Account')");
    const stmt = db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (1, ?, 0, ?, ?)"
    );
    for (let i = 0; i < 41; i++) {
      if (i === 15) continue;
      const v = i < 15 ? 100_000 : 70_000;
      stmt.run(makeDate(i), v, v);
    }
    seedFlow(makeDate(15), -30_000);

    const result = computeRiskMetrics(db);
    expect(result.maxDrawdown).toBeNull();
    expect(result.volatility).toBeCloseTo(0, 6);
  });

  it("only adjusts for flows in the scoped accounts", () => {
    // Account 1 is flat; account 2 receives the withdrawal. Scoped to account
    // 1, the flow must NOT be applied (it would fabricate a phantom rally).
    seedDailyValuations(db, Array.from({ length: 60 }, () => 100_000));
    db.exec("INSERT INTO accounts (id, name) VALUES (2, 'Other')");
    seedFlow(makeDate(30), -40_000, 2);

    const result = computeRiskMetrics(db, { accountId: 1 });
    expect(result.maxDrawdown).toBeNull();
    expect(result.volatility).toBeCloseTo(0, 6);
  });

  it("is a no-op when the transactions table does not exist (minimal test DBs)", () => {
    db.exec("DROP TABLE transactions");
    seedDailyValuations(db, Array.from({ length: 50 }, (_, i) => 100 + i));

    expect(() => computeRiskMetrics(db)).not.toThrow();
    const result = computeRiskMetrics(db);
    expect(result.dataPoints).toBe(50);
  });
});

describe("computePositionRisk", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns empty result with no holdings", () => {
    const result = computePositionRisk(db);
    expect(result.positions).toHaveLength(0);
    expect(result.correlations).toHaveLength(0);
    expect(result.portfolioVol).toBeNull();
  });

  it("computes per-position volatility from price data", () => {
    // Set up 2 securities with 60 days of recent price data
    const today = new Date();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
    db.exec("INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple')");
    db.exec("INSERT INTO securities (id, symbol, name) VALUES (2, 'MSFT', 'Microsoft')");
    const asOf = today.toISOString().slice(0, 10);
    db.exec(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, '${asOf}', 100)`);
    db.exec(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, '${asOf}', 50)`);

    // Generate 60 daily prices ending today (volatile AAPL, stable MSFT)
    for (let i = 0; i < 60; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - 59 + i);
      const date = d.toISOString().slice(0, 10);
      const aaplPrice = 150 + Math.sin(i * 0.3) * 10 + i * 0.1;
      const msftPrice = 400 + Math.sin(i * 0.1) * 2 + i * 0.05;
      db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(1, date, aaplPrice);
      db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(2, date, msftPrice);
    }

    const result = computePositionRisk(db);
    expect(result.positions).toHaveLength(2);

    const aapl = result.positions.find(p => p.symbol === "AAPL");
    const msft = result.positions.find(p => p.symbol === "MSFT");
    expect(aapl).toBeDefined();
    expect(msft).toBeDefined();
    expect(aapl!.annualizedVol).not.toBeNull();
    expect(msft!.annualizedVol).not.toBeNull();
    // AAPL should be more volatile than MSFT
    expect(aapl!.annualizedVol!).toBeGreaterThan(msft!.annualizedVol!);
  });

  it("ignores a return pair spanning a multi-month price gap", () => {
    // Same root cause as the beta bug: an old statement anchor (2025-06-30)
    // followed by a ~9-month hole then a dense daily block. The anchor→block
    // step is not a real daily return; without a gap guard it dominates the
    // volatility and inflates annualizedVol ~20×.
    const today = new Date();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
    db.exec("INSERT INTO securities (id, symbol, name) VALUES (1, 'GAPco', 'Gap Co')");
    const asOf = today.toISOString().slice(0, 10);
    db.exec(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, '${asOf}', 100)`);

    const ins = db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)");
    // Old anchor far above the dense block → a giant negative "gap return".
    ins.run(1, "2025-06-30", 800);
    // Dense daily block: 40 days ending today, gentle moves → modest real vol.
    for (let i = 0; i < 40; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - 39 + i);
      const date = d.toISOString().slice(0, 10);
      ins.run(1, date, 100 + Math.sin(i) * 2 + i * 0.05);
    }

    const result = computePositionRisk(db);
    const gapco = result.positions.find((p) => p.symbol === "GAPco");
    expect(gapco).toBeDefined();
    expect(gapco!.annualizedVol).not.toBeNull();
    // Guard active → vol reflects only the dense block (~0.2–0.4). Without it the
    // single −2.08 log gap return drives annualized vol above 3 (300%+).
    expect(gapco!.annualizedVol!).toBeGreaterThan(0);
    expect(gapco!.annualizedVol!).toBeLessThan(1.5);
  });

  it("computes pairwise correlations", () => {
    const today = new Date();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");
    db.exec("INSERT INTO securities (id, symbol, name) VALUES (1, 'AAA', 'A')");
    db.exec("INSERT INTO securities (id, symbol, name) VALUES (2, 'BBB', 'B')");
    db.exec("INSERT INTO securities (id, symbol, name) VALUES (3, 'CCC', 'C')");
    const asOf = today.toISOString().slice(0, 10);
    db.exec(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, '${asOf}', 100)`);
    db.exec(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, '${asOf}', 100)`);
    db.exec(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 3, '${asOf}', 100)`);

    // AAA and BBB move together (high correlation), CCC moves opposite (negative)
    for (let i = 0; i < 60; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - 59 + i);
      const date = d.toISOString().slice(0, 10);
      const move = Math.sin(i * 0.4);
      db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(1, date, 100 + move * 5 + i * 0.1);
      db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(2, date, 100 + move * 4 + i * 0.1); // similar
      db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(3, date, 100 - move * 3 + i * 0.1); // opposite
    }

    const result = computePositionRisk(db);
    expect(result.correlations.length).toBeGreaterThanOrEqual(3); // 3 pairs

    const abCorr = result.correlations.find(
      c => (c.symbolA === "AAA" && c.symbolB === "BBB") || (c.symbolA === "BBB" && c.symbolB === "AAA")
    );
    const acCorr = result.correlations.find(
      c => (c.symbolA === "AAA" && c.symbolB === "CCC") || (c.symbolA === "CCC" && c.symbolB === "AAA")
    );

    expect(abCorr).toBeDefined();
    expect(acCorr).toBeDefined();
    // AAA and BBB should be highly positively correlated
    expect(abCorr!.correlation).toBeGreaterThan(0.7);
    // AAA and CCC should be negatively correlated
    expect(acCorr!.correlation).toBeLessThan(-0.5);
  });

  it("handles insufficient price data gracefully", () => {
    seedHoldings(db, [
      { symbol: "AAPL", quantity: 100, price: 150 },
    ]);
    // Only 1 price point — not enough for returns

    const result = computePositionRisk(db);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].annualizedVol).toBeNull();
    expect(result.positions[0].dataPoints).toBeLessThan(20);
  });

  it("weight reflects USD-converted market value, not KRW notional", () => {
    const today = new Date().toISOString().slice(0, 10);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // USD control: 10 sh @ $208 = $2,080.
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, currency) VALUES (1, 'AAPL', 'Apple', 'stock', 'USD')"
    ).run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 10)").run(today);

    // KRW holding: 10 sh @ ₩1,731,000 = ₩17,310,000 notional. fx 0.000734 → ≈$12,705.54.
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, currency) VALUES (2, '402340', 'KRW Co', 'stock', 'KRW')"
    ).run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, 10)").run(today);
    db.prepare(
      "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('KRW', 0.000734, ?, 'test')"
    ).run(today);

    // 60 days of prices for both so the top-N query and weight computation work.
    const base = new Date();
    for (let i = 0; i < 60; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() - 59 + i);
      const date = d.toISOString().slice(0, 10);
      db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price) VALUES (1, ?, 208)").run(date);
      db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price) VALUES (2, ?, 1731000)").run(date);
    }

    const result = computePositionRisk(db);
    const expectedKrwUsd = 10 * 1_731_000 * 0.000734; // ≈ $12,705.54
    const expectedTotal = expectedKrwUsd + 2_080;

    const krw = result.positions.find((p) => p.symbol === "402340")!;
    const aapl = result.positions.find((p) => p.symbol === "AAPL")!;
    expect(krw).toBeDefined();
    expect(aapl).toBeDefined();

    // The KRW position's weight should reflect its true ~$12.7K USD value,
    // NOT dominate at ~99.99% (won notional ÷ total).
    expect(krw!.weight).toBeCloseTo(expectedKrwUsd / expectedTotal, 3);
    expect(krw!.weight).toBeLessThan(0.9);
    expect(krw!.weight).toBeGreaterThan(0.8);

    // USD control byte-unchanged.
    expect(aapl!.weight).toBeCloseTo(2_080 / expectedTotal, 3);
  });
});

describe("FX conversion (Task 9b — risk concentration weights)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("Herfindahl/top5 concentration weight reflects USD conversion, not KRW notional", () => {
    const today = new Date().toISOString().slice(0, 10);
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test')");

    // USD control: 10 sh @ $208 = $2,080.
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, currency) VALUES (1, 'AAPL', 'Apple', 'stock', 'USD')"
    ).run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 10)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 208)").run(today);

    // KRW holding: 10 sh @ ₩1,731,000 = ₩17,310,000 notional. fx 0.000734 → ≈$12,705.54.
    db.prepare(
      "INSERT INTO securities (id, symbol, name, security_type, currency) VALUES (2, '402340', 'KRW Co', 'stock', 'KRW')"
    ).run();
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 2, ?, 10)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 1731000)").run(today);
    db.prepare(
      "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('KRW', 0.000734, ?, 'test')"
    ).run(today);

    // Daily valuations feed drawdown/vol/Sharpe — computed from a wholly
    // separate flow-adjusted series, structurally untouched by holdings
    // currency (it never reads securities/holdings/prices at all).
    seedDailyValuations(db, Array.from({ length: 40 }, (_, i) => 100 + i * 0.5));

    const result = computeRiskMetrics(db);

    const expectedKrwUsd = 10 * 1_731_000 * 0.000734; // ≈ $12,705.54
    const expectedTotal = expectedKrwUsd + 2_080;

    const krw = result.top5Positions.find((p) => p.symbol === "402340")!;
    const aapl = result.top5Positions.find((p) => p.symbol === "AAPL")!;
    expect(krw).toBeDefined();
    expect(aapl).toBeDefined();

    expect(krw!.marketValue).toBeCloseTo(expectedKrwUsd, 2);
    expect(krw!.marketValue).toBeLessThan(20_000); // NOT the ₩17.31M phantom
    expect(krw!.weight).toBeCloseTo(expectedKrwUsd / expectedTotal, 3);
    expect(krw!.weight).toBeLessThan(0.9); // not dominating at ~99.99% notional weight

    // USD control byte-unchanged.
    expect(aapl!.marketValue).toBeCloseTo(2_080, 2);
    expect(aapl!.weight).toBeCloseTo(2_080 / expectedTotal, 3);

    // Herfindahl computed from the same corrected weights.
    const expectedHerf = (expectedKrwUsd / expectedTotal) ** 2 + (2_080 / expectedTotal) ** 2;
    expect(result.herfindahl).toBeCloseTo(expectedHerf, 3);

    // Drawdown/volatility/Sharpe are unaffected by the KRW conversion — they
    // come from the daily_valuations series, not per-holding market value.
    expect(result.volatility).not.toBeNull();
    expect(result.maxDrawdown).toBeNull(); // monotonically rising series seeded above
  });
});

describe("multi-account scope (accountIds[])", () => {
  let db: Database.Database;
  const today = new Date().toISOString().slice(0, 10);

  beforeEach(() => {
    db = createTestDb();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'IBKR'), (2, 'Roth')");
    // acct 1: AAPL $10k. acct 2: MSFT $10k + NVDA $5k.
    db.exec("INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple'), (2, 'MSFT', 'Microsoft'), (3, 'NVDA', 'Nvidia')");
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (1, 1, ?, 100)").run(today);
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (2, 2, ?, 50)").run(today);
    db.prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (2, 3, ?, 10)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (1, ?, 100)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (2, ?, 200)").run(today);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (3, ?, 500)").run(today);
  });

  it("computeRiskMetrics concentration spans the full account set", () => {
    const acct1 = computeRiskMetrics(db, { accountId: 1 });
    const both = computeRiskMetrics(db, { accountIds: [1, 2] });

    expect(acct1.positionCount).toBe(1); // only AAPL
    expect(acct1.top5Positions.map((p) => p.symbol)).toEqual(["AAPL"]);

    expect(both.positionCount).toBe(3); // AAPL + MSFT + NVDA
    expect(both.top5Positions.map((p) => p.symbol).sort()).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("computeRiskMetrics sums the valuation series across the account set", () => {
    const stmt = db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, 0, ?, ?)"
    );
    for (let i = 0; i < 40; i++) {
      const d = new Date("2025-01-02");
      d.setDate(d.getDate() + i);
      const date = d.toISOString().slice(0, 10);
      stmt.run(1, date, 100 + i, 100 + i); // smooth ramp
      stmt.run(2, date, 50 + Math.sin(i) * 20, 50 + Math.sin(i) * 20); // wavy
    }

    const acct1 = computeRiskMetrics(db, { accountId: 1 });
    const both = computeRiskMetrics(db, { accountIds: [1, 2] });

    // One summed row per date, not two.
    expect(both.dataPoints).toBe(40);
    expect(acct1.dataPoints).toBe(40);
    // The combined (account-1 ramp + account-2 wave) series has different
    // volatility than account 1 alone — proves it isn't dropping account 2.
    expect(both.volatility).not.toEqual(acct1.volatility);
  });

  it("computePositionRisk ranks across the full account set", () => {
    // 60 days of prices so vols compute.
    const base = new Date();
    for (let i = 0; i < 60; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() - 59 + i);
      const date = d.toISOString().slice(0, 10);
      for (const [sid, p0] of [[1, 100], [2, 200], [3, 500]] as const) {
        db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(
          sid,
          date,
          p0 + Math.sin(i * 0.3) * (p0 * 0.05) + i * 0.1
        );
      }
    }

    const acct1 = computePositionRisk(db, { accountId: 1 });
    const both = computePositionRisk(db, { accountIds: [1, 2] });

    expect(acct1.positions.map((p) => p.symbol)).toEqual(["AAPL"]);
    expect(both.positions.map((p) => p.symbol).sort()).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("back-compat: accountIds:[1] deep-equals accountId:1", () => {
    const stmt = db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, 0, ?, ?)"
    );
    for (let i = 0; i < 40; i++) {
      const d = new Date("2025-01-02");
      d.setDate(d.getDate() + i);
      stmt.run(1, d.toISOString().slice(0, 10), 100 + i, 100 + i);
    }

    expect(computeRiskMetrics(db, { accountIds: [1] })).toEqual(
      computeRiskMetrics(db, { accountId: 1 })
    );
    expect(computePositionRisk(db, { accountIds: [1] })).toEqual(
      computePositionRisk(db, { accountId: 1 })
    );
  });
});

describe("computeRiskMetrics coverage-jump guard", () => {
  it("multi-account metrics ignore dates before all scoped accounts have coverage", () => {
    const db = createTestDb();
    db.exec("INSERT INTO accounts (id, name) VALUES (1, 'A'), (2, 'B')");

    // Account 1: 70 flat days at $100k. Account 2: flat $100k but only
    // covered for the last 40 days. The summed series pre-guard reads
    // 100k → 200k on account 2's first covered date — a fake +100% "day"
    // that is a coverage artifact, not a market move (and not an external
    // flow either, so flow-adjustment can't neutralize it).
    const ins = db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, 0, ?, ?)"
    );
    for (let i = 69; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      ins.run(1, date, 100_000, 100_000);
      if (i <= 39) ins.run(2, date, 100_000, 100_000);
    }

    const result = computeRiskMetrics(db, { accountIds: [1, 2] });
    // A perfectly flat full-coverage series has ~zero volatility; the
    // coverage jump would have produced an enormous annualized figure.
    expect(result.volatility).not.toBeNull();
    expect(result.volatility!).toBeLessThan(0.01);
  });
});

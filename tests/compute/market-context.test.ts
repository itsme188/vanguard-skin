import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

// We test the exported helpers via getMarketContext + formatMarketContext
// but also import the types for assertion clarity
import {
  getMarketContext,
  formatMarketContext,
  type TradeMarketContext,
} from "@/lib/trade-review/market-context";
import type { GroupedTrade } from "@/lib/compute/trade-roundtrips";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      security_type TEXT DEFAULT 'Stock',
      multiplier REAL DEFAULT 1
    );

    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER,
      trade_date TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity REAL,
      price_per_share REAL,
      amount REAL,
      fees REAL DEFAULT 0,
      is_external_flow INTEGER DEFAULT 0,
      source_key TEXT UNIQUE,
      notes TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE tax_lots (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      acquisition_transaction_id INTEGER,
      acquisition_date TEXT NOT NULL,
      acquisition_price REAL NOT NULL,
      quantity_acquired REAL NOT NULL,
      quantity_remaining REAL NOT NULL DEFAULT 0,
      cost_basis REAL NOT NULL,
      is_from_opening_snapshot INTEGER NOT NULL DEFAULT 0,
      is_short INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (security_id) REFERENCES securities(id)
    );

    CREATE TABLE tax_lot_sales (
      id INTEGER PRIMARY KEY,
      tax_lot_id INTEGER NOT NULL,
      sale_transaction_id INTEGER NOT NULL,
      sale_date TEXT NOT NULL,
      quantity_sold REAL NOT NULL,
      sale_price REAL NOT NULL,
      proceeds REAL NOT NULL,
      cost_basis_allocated REAL NOT NULL,
      realized_gain_loss REAL NOT NULL,
      is_long_term INTEGER NOT NULL DEFAULT 0,
      holding_period_days INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (tax_lot_id) REFERENCES tax_lots(id)
    );

    CREATE TABLE prices (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT DEFAULT 'manual',
      UNIQUE(security_id, date)
    );

    CREATE TABLE ohlcv_bars (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      bar_date TEXT NOT NULL,
      bar_size TEXT NOT NULL DEFAULT '1 day',
      open REAL, high REAL, low REAL, close REAL, volume INTEGER,
      UNIQUE(security_id, bar_date, bar_size)
    );

    CREATE TABLE benchmark_prices (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      UNIQUE(symbol, date)
    );

    CREATE TABLE daily_valuations (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      valuation_date TEXT NOT NULL,
      total_value REAL NOT NULL,
      holdings_value REAL DEFAULT 0,
      cash_value REAL DEFAULT 0,
      UNIQUE(account_id, valuation_date)
    );

    CREATE TABLE monthly_snapshots (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      month_end_date TEXT NOT NULL,
      total_value REAL NOT NULL,
      source TEXT DEFAULT 'manual',
      UNIQUE(account_id, month_end_date)
    );

    INSERT INTO accounts (id, name) VALUES (1, 'Test Account');
    INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple Inc');
    INSERT INTO securities (id, symbol, name) VALUES (2, 'SPY', 'SPDR S&P 500');
    INSERT INTO securities (id, symbol, name) VALUES (3, 'INTC', 'Intel Corp');
    INSERT INTO securities (id, symbol, name) VALUES (4, 'MSFT', 'Microsoft');
  `);

  return db;
}

/** Helper to build a minimal GroupedTrade for testing */
function makeGroupedTrade(overrides: Partial<GroupedTrade> = {}): GroupedTrade {
  return {
    saleTransactionId: 100,
    securityId: 1,
    symbol: "AAPL",
    securityName: "Apple Inc",
    lots: [],
    totalQuantity: 10,
    sellTransactionQty: 10,
    lotCoverage: 1,
    avgEntryPrice: 150,
    exitPrice: 200,
    exitDate: "2024-06-15",
    earliestEntryDate: "2024-01-15",
    latestEntryDate: "2024-01-15",
    avgHoldingDays: 152,
    maxHoldingDays: 152,
    minHoldingDays: 152,
    totalCost: 1500,
    totalProceeds: 2000,
    realizedPnl: 500,
    returnPct: 33.3,
    ...overrides,
  };
}

describe("market-context", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  // ─── Trim vs Full Exit Detection ───────────────────────────────

  describe("trim detection", () => {
    it("detects a trim when tax lots have remaining shares", () => {
      // Bought 20 shares, sold 10, 10 remain
      db.exec(`
        INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
        VALUES (1, 1, '2024-01-15', 150, 20, 10, 3000);
      `);

      const trade = makeGroupedTrade({ totalQuantity: 10 });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.remainingPosition).not.toBeNull();
      expect(ctx.remainingPosition!.isTrim).toBe(true);
      expect(ctx.remainingPosition!.remainingShares).toBe(10);
      expect(ctx.remainingPosition!.soldShares).toBe(10);
      expect(ctx.remainingPosition!.retainedPct).toBeCloseTo(0.5);
    });

    it("detects a full exit when no remaining shares", () => {
      // All lots fully consumed
      db.exec(`
        INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
        VALUES (1, 1, '2024-01-15', 150, 10, 0, 1500);
      `);

      const trade = makeGroupedTrade({ totalQuantity: 10 });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.remainingPosition).not.toBeNull();
      expect(ctx.remainingPosition!.isTrim).toBe(false);
      expect(ctx.remainingPosition!.remainingShares).toBe(0);
    });

    it("sums remaining across multiple tax lots", () => {
      // Two lots, both with some remaining
      db.exec(`
        INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
        VALUES (1, 1, '2024-01-15', 150, 10, 3, 1500);
        INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
        VALUES (1, 1, '2024-02-15', 155, 10, 5, 1550);
      `);

      const trade = makeGroupedTrade({ totalQuantity: 12 });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.remainingPosition!.isTrim).toBe(true);
      expect(ctx.remainingPosition!.remainingShares).toBe(8);
      expect(ctx.remainingPosition!.soldShares).toBe(12);
      // 8 / (8 + 12) = 0.4
      expect(ctx.remainingPosition!.retainedPct).toBeCloseTo(0.4);
    });
  });

  // ─── Concurrent Buys ──────────────────────────────────────────

  describe("concurrent buys", () => {
    it("finds BUY transactions within 7-day window of sale", () => {
      db.exec(`
        INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, amount)
        VALUES (200, 1, 3, '2024-06-15', 'BUY', 100, -5000);
      `);

      const trade = makeGroupedTrade({ exitDate: "2024-06-15" });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.concurrentActivity).not.toBeNull();
      expect(ctx.concurrentActivity!.buys).toHaveLength(1);
      expect(ctx.concurrentActivity!.buys[0].symbol).toBe("INTC");
      expect(ctx.concurrentActivity!.buys[0].quantity).toBe(100);
      expect(ctx.concurrentActivity!.buys[0].totalCost).toBe(5000);
      expect(ctx.concurrentActivity!.totalBuyAmount).toBe(5000);
    });

    it("excludes buys outside the 7-day window", () => {
      db.exec(`
        INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, amount)
        VALUES (200, 1, 3, '2024-06-30', 'BUY', 100, -5000);
      `);

      const trade = makeGroupedTrade({ exitDate: "2024-06-15" });
      const [ctx] = getMarketContext(db, [trade], 1);

      // 15 days away — outside 7-day window
      expect(ctx.concurrentActivity).toBeNull();
    });

    it("returns null when no concurrent buys exist", () => {
      const trade = makeGroupedTrade({ exitDate: "2024-06-15" });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.concurrentActivity).toBeNull();
    });

    it("finds multiple concurrent buys and sums total", () => {
      db.exec(`
        INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, amount)
        VALUES (200, 1, 3, '2024-06-14', 'BUY', 50, -2500);
        INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, amount)
        VALUES (201, 1, 4, '2024-06-16', 'BUY', 20, -3000);
      `);

      const trade = makeGroupedTrade({ exitDate: "2024-06-15" });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.concurrentActivity!.buys).toHaveLength(2);
      expect(ctx.concurrentActivity!.totalBuyAmount).toBe(5500);
    });
  });

  // ─── Benchmark Quality Gate ───────────────────────────────────

  describe("benchmark quality gate", () => {
    it("returns null when only one benchmark price exists (same date for start and end)", () => {
      // Single price point at 2024-03-15 — both start and end queries resolve to this
      db.exec(`
        INSERT INTO prices (security_id, date, close_price)
        VALUES (2, '2024-03-15', 500);
      `);

      const trade = makeGroupedTrade({
        earliestEntryDate: "2024-01-15",
        exitDate: "2024-06-15",
      });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.benchmarkReturn).toBeNull();
    });

    it("returns correct return when two distinct benchmark prices exist", () => {
      db.exec(`
        INSERT INTO prices (security_id, date, close_price)
        VALUES (2, '2024-01-15', 450);
        INSERT INTO prices (security_id, date, close_price)
        VALUES (2, '2024-06-15', 500);
      `);

      const trade = makeGroupedTrade({
        earliestEntryDate: "2024-01-15",
        exitDate: "2024-06-15",
      });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.benchmarkReturn).not.toBeNull();
      // (500 - 450) / 450 = 0.1111
      expect(ctx.benchmarkReturn).toBeCloseTo(0.1111, 3);
    });

    it("returns null when benchmark_prices has single point", () => {
      db.exec(`
        INSERT INTO benchmark_prices (symbol, date, close_price)
        VALUES ('SPY', '2024-04-01', 510);
      `);

      const trade = makeGroupedTrade({
        earliestEntryDate: "2024-01-15",
        exitDate: "2024-06-15",
      });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.benchmarkReturn).toBeNull();
    });
  });

  // ─── Price Range Quality Gate ─────────────────────────────────

  describe("price range quality gate", () => {
    it("returns null when fewer than 5 data points for stock", () => {
      // Only 3 prices across a 6-month holding period
      db.exec(`
        INSERT INTO prices (security_id, date, close_price) VALUES (1, '2024-02-01', 155);
        INSERT INTO prices (security_id, date, close_price) VALUES (1, '2024-04-01', 170);
        INSERT INTO prices (security_id, date, close_price) VALUES (1, '2024-06-01', 195);
      `);

      const trade = makeGroupedTrade({
        earliestEntryDate: "2024-01-15",
        exitDate: "2024-06-15",
      });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.stockContext).toBeNull();
    });

    it("returns price context when sufficient data points exist", () => {
      // 20 daily prices across a 30-day holding period
      for (let i = 1; i <= 20; i++) {
        const day = String(i).padStart(2, "0");
        const price = 150 + i;
        db.exec(
          `INSERT INTO prices (security_id, date, close_price) VALUES (1, '2024-05-${day}', ${price})`
        );
      }

      const trade = makeGroupedTrade({
        earliestEntryDate: "2024-05-01",
        exitDate: "2024-05-30",
        avgEntryPrice: 150,
        exitPrice: 170,
      });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.stockContext).not.toBeNull();
      expect(ctx.stockContext!.periodHigh).toBe(170); // 150 + 20
      expect(ctx.stockContext!.periodLow).toBe(151); // 150 + 1
    });

    it("uses ohlcv_bars when available with sufficient coverage", () => {
      for (let i = 1; i <= 10; i++) {
        const day = String(i).padStart(2, "0");
        db.exec(
          `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close)
           VALUES (1, '2024-05-${day}', '1 day', ${150 + i}, ${155 + i}, ${145 + i}, ${150 + i})`
        );
      }

      const trade = makeGroupedTrade({
        earliestEntryDate: "2024-05-01",
        exitDate: "2024-05-14",
        avgEntryPrice: 150,
        exitPrice: 160,
      });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.stockContext).not.toBeNull();
      expect(ctx.stockContext!.periodHigh).toBe(165); // 155 + 10
      expect(ctx.stockContext!.periodLow).toBe(146); // 145 + 1
    });
  });

  // ─── Position Sizing Fallback ─────────────────────────────────

  describe("position sizing fallback", () => {
    it("uses daily_valuations when available", () => {
      db.exec(`
        INSERT INTO daily_valuations (account_id, valuation_date, total_value)
        VALUES (1, '2024-01-10', 50000);
      `);

      const trade = makeGroupedTrade({ totalCost: 1500 });
      const [ctx] = getMarketContext(db, [trade], 1);

      // 1500 / 50000 = 0.03
      expect(ctx.positionPctOfPortfolio).toBeCloseTo(0.03);
    });

    it("falls back to monthly_snapshots when no daily_valuations", () => {
      db.exec(`
        INSERT INTO monthly_snapshots (account_id, month_end_date, total_value)
        VALUES (1, '2023-12-31', 40000);
      `);

      const trade = makeGroupedTrade({
        earliestEntryDate: "2024-01-15",
        totalCost: 2000,
      });
      const [ctx] = getMarketContext(db, [trade], 1);

      // 2000 / 40000 = 0.05
      expect(ctx.positionPctOfPortfolio).toBeCloseTo(0.05);
    });

    it("prefers daily_valuations over monthly_snapshots", () => {
      db.exec(`
        INSERT INTO daily_valuations (account_id, valuation_date, total_value)
        VALUES (1, '2024-01-12', 50000);
        INSERT INTO monthly_snapshots (account_id, month_end_date, total_value)
        VALUES (1, '2023-12-31', 40000);
      `);

      const trade = makeGroupedTrade({
        earliestEntryDate: "2024-01-15",
        totalCost: 1500,
      });
      const [ctx] = getMarketContext(db, [trade], 1);

      // Should use daily_valuations: 1500 / 50000 = 0.03
      expect(ctx.positionPctOfPortfolio).toBeCloseTo(0.03);
    });

    it("returns null when neither source has data", () => {
      const trade = makeGroupedTrade({
        earliestEntryDate: "2024-01-15",
        totalCost: 1500,
      });
      const [ctx] = getMarketContext(db, [trade], 1);

      expect(ctx.positionPctOfPortfolio).toBeNull();
    });
  });

  // ─── Format Output ────────────────────────────────────────────

  describe("formatMarketContext", () => {
    it("includes trim context in formatted output", () => {
      db.exec(`
        INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
        VALUES (1, 1, '2024-01-15', 150, 20, 10, 3000);
      `);

      const trade = makeGroupedTrade({ totalQuantity: 10 });
      const contexts = getMarketContext(db, [trade], 1);
      const formatted = formatMarketContext(contexts, [trade]);

      expect(formatted).toContain("TRIM");
      expect(formatted).toContain("retained 10 shares");
      expect(formatted).toContain("50% of position kept");
    });

    it("includes concurrent buys in formatted output", () => {
      db.exec(`
        INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, amount)
        VALUES (200, 1, 3, '2024-06-15', 'BUY', 275, -12269);
      `);

      const trade = makeGroupedTrade({ exitDate: "2024-06-15" });
      const contexts = getMarketContext(db, [trade], 1);
      const formatted = formatMarketContext(contexts, [trade]);

      expect(formatted).toContain("Concurrent buys");
      expect(formatted).toContain("INTC");
      expect(formatted).toContain("275");
    });

    it("shows explicit benchmark unavailable message when stock data exists but no SPY", () => {
      // Enough stock prices to pass quality gate but no SPY data
      for (let i = 1; i <= 10; i++) {
        const day = String(i).padStart(2, "0");
        db.exec(
          `INSERT INTO prices (security_id, date, close_price) VALUES (1, '2024-05-${day}', ${150 + i})`
        );
      }

      const trade = makeGroupedTrade({
        earliestEntryDate: "2024-05-01",
        exitDate: "2024-05-14",
      });
      const contexts = getMarketContext(db, [trade], 1);
      const formatted = formatMarketContext(contexts, [trade]);

      expect(formatted).toContain(
        "SPY benchmark: insufficient price data for this period"
      );
    });

    it("shows FULL EXIT when no remaining shares", () => {
      db.exec(`
        INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
        VALUES (1, 1, '2024-01-15', 150, 10, 0, 1500);
      `);

      const trade = makeGroupedTrade({ totalQuantity: 10 });
      const contexts = getMarketContext(db, [trade], 1);
      const formatted = formatMarketContext(contexts, [trade]);

      expect(formatted).toContain("FULL EXIT");
    });
  });
});

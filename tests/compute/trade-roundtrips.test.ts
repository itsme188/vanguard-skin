import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  getRoundTrips,
  computeRoundTripSummary,
  computeGroupedTrades,
  computeGroupedSummary,
  detectNewTradeReviewPeriods,
  getAvailableReviewPeriods,
  type RoundTrip,
} from "@/lib/compute/trade-roundtrips";

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
      security_type TEXT DEFAULT 'stock',
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

    CREATE TABLE import_batches (
      id INTEGER PRIMARY KEY,
      filename TEXT,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      record_count INTEGER DEFAULT 0,
      summary TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE trade_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      import_batch_id INTEGER,
      total_trades INTEGER NOT NULL,
      winning_trades INTEGER NOT NULL,
      losing_trades INTEGER NOT NULL,
      win_rate REAL NOT NULL,
      total_realized_pnl REAL NOT NULL,
      avg_holding_days REAL,
      best_trade_pnl REAL,
      best_trade_symbol TEXT,
      worst_trade_pnl REAL,
      worst_trade_symbol TEXT,
      avg_win REAL,
      avg_loss REAL,
      profit_factor REAL,
      review_markdown TEXT NOT NULL,
      trade_grades TEXT,
      patterns_identified TEXT,
      strengths TEXT,
      weaknesses TEXT,
      cumulative_patterns TEXT,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      generated_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(account_id) REFERENCES accounts(id),
      UNIQUE(account_id, period_start)
    );

    CREATE TABLE trade_roundtrips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      entry_price REAL NOT NULL,
      entry_quantity REAL NOT NULL,
      entry_cost REAL NOT NULL,
      exit_date TEXT NOT NULL,
      exit_price REAL NOT NULL,
      exit_quantity REAL NOT NULL,
      exit_proceeds REAL NOT NULL,
      holding_days INTEGER NOT NULL,
      realized_pnl REAL NOT NULL,
      return_pct REAL NOT NULL,
      grade TEXT,
      entry_thesis TEXT,
      exit_assessment TEXT,
      what_went_well TEXT,
      what_went_wrong TEXT,
      FOREIGN KEY(review_id) REFERENCES trade_reviews(id) ON DELETE CASCADE,
      FOREIGN KEY(account_id) REFERENCES accounts(id),
      FOREIGN KEY(security_id) REFERENCES securities(id)
    );
  `);

  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'IBKR')");
  db.exec("INSERT INTO accounts (id, name) VALUES (2, 'Vanguard Taxable')");
  db.exec(
    "INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple Inc.')"
  );
  db.exec(
    "INSERT INTO securities (id, symbol, name) VALUES (2, 'NVDA', 'NVIDIA Corp.')"
  );
  db.exec(
    "INSERT INTO securities (id, symbol, name) VALUES (3, 'TSLA', 'Tesla Inc.')"
  );

  return db;
}

/** Insert a sell transaction and matching tax_lot + tax_lot_sale */
function addRoundTrip(
  db: Database.Database,
  opts: {
    accountId: number;
    securityId: number;
    acquisitionDate: string;
    saleDate: string;
    quantity: number;
    acquisitionPrice: number;
    salePrice: number;
  }
) {
  const costBasis = opts.quantity * opts.acquisitionPrice;
  const proceeds = opts.quantity * opts.salePrice;
  const gain = proceeds - costBasis;
  const holdingDays = Math.round(
    (new Date(opts.saleDate).getTime() -
      new Date(opts.acquisitionDate).getTime()) /
      (24 * 3600 * 1000)
  );

  // Create a sell transaction
  const txResult = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount)
       VALUES (?, ?, ?, 'SELL', ?, ?, ?)`
    )
    .run(
      opts.accountId,
      opts.securityId,
      opts.saleDate,
      opts.quantity,
      opts.salePrice,
      proceeds
    );

  const lotResult = db
    .prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .run(
      opts.accountId,
      opts.securityId,
      opts.acquisitionDate,
      opts.acquisitionPrice,
      opts.quantity,
      costBasis
    );

  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lotResult.lastInsertRowid,
    txResult.lastInsertRowid,
    opts.saleDate,
    opts.quantity,
    opts.salePrice,
    proceeds,
    costBasis,
    gain,
    holdingDays > 365 ? 1 : 0,
    holdingDays
  );
}

describe("getRoundTrips", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns empty array for no trades", () => {
    const result = getRoundTrips(db, 1, "2026-01-01", "2026-01-31");
    expect(result).toEqual([]);
  });

  it("extracts round-trips from tax_lot_sales", () => {
    addRoundTrip(db, {
      accountId: 1,
      securityId: 1,
      acquisitionDate: "2026-01-05",
      saleDate: "2026-01-15",
      quantity: 100,
      acquisitionPrice: 150,
      salePrice: 160,
    });

    const result = getRoundTrips(db, 1, "2026-01-01", "2026-01-31");
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("AAPL");
    expect(result[0].entryDate).toBe("2026-01-05");
    expect(result[0].exitDate).toBe("2026-01-15");
    expect(result[0].entryPrice).toBe(150);
    expect(result[0].exitPrice).toBe(160);
    expect(result[0].entryQuantity).toBe(100);
    expect(result[0].entryCost).toBe(15000);
    expect(result[0].exitProceeds).toBe(16000);
    expect(result[0].realizedPnl).toBe(1000);
    expect(result[0].holdingDays).toBe(10);
    expect(result[0].returnPct).toBeCloseTo(6.667, 2);
  });

  it("filters by account", () => {
    addRoundTrip(db, {
      accountId: 1,
      securityId: 1,
      acquisitionDate: "2026-01-05",
      saleDate: "2026-01-15",
      quantity: 50,
      acquisitionPrice: 150,
      salePrice: 160,
    });
    addRoundTrip(db, {
      accountId: 2,
      securityId: 1,
      acquisitionDate: "2026-01-05",
      saleDate: "2026-01-15",
      quantity: 30,
      acquisitionPrice: 150,
      salePrice: 155,
    });

    const ibkrResult = getRoundTrips(db, 1, "2026-01-01", "2026-01-31");
    expect(ibkrResult).toHaveLength(1);
    expect(ibkrResult[0].entryQuantity).toBe(50);

    const vanguardResult = getRoundTrips(db, 2, "2026-01-01", "2026-01-31");
    expect(vanguardResult).toHaveLength(1);
    expect(vanguardResult[0].entryQuantity).toBe(30);
  });

  it("filters by date range (boundaries)", () => {
    addRoundTrip(db, {
      accountId: 1,
      securityId: 1,
      acquisitionDate: "2025-12-15",
      saleDate: "2026-01-01",
      quantity: 50,
      acquisitionPrice: 150,
      salePrice: 160,
    });
    addRoundTrip(db, {
      accountId: 1,
      securityId: 2,
      acquisitionDate: "2026-01-10",
      saleDate: "2026-01-31",
      quantity: 30,
      acquisitionPrice: 200,
      salePrice: 220,
    });
    addRoundTrip(db, {
      accountId: 1,
      securityId: 3,
      acquisitionDate: "2026-01-20",
      saleDate: "2026-02-05",
      quantity: 20,
      acquisitionPrice: 300,
      salePrice: 280,
    });

    // Only the first two should be in January
    const result = getRoundTrips(db, 1, "2026-01-01", "2026-01-31");
    expect(result).toHaveLength(2);
    expect(result[0].symbol).toBe("AAPL");
    expect(result[1].symbol).toBe("NVDA");
  });

  it("handles multiple round-trips for same security", () => {
    addRoundTrip(db, {
      accountId: 1,
      securityId: 1,
      acquisitionDate: "2026-01-02",
      saleDate: "2026-01-10",
      quantity: 50,
      acquisitionPrice: 150,
      salePrice: 155,
    });
    addRoundTrip(db, {
      accountId: 1,
      securityId: 1,
      acquisitionDate: "2026-01-15",
      saleDate: "2026-01-25",
      quantity: 30,
      acquisitionPrice: 160,
      salePrice: 158,
    });

    const result = getRoundTrips(db, 1, "2026-01-01", "2026-01-31");
    expect(result).toHaveLength(2);
    // First trade is a win, second is a loss
    expect(result[0].realizedPnl).toBe(250); // 50 * (155-150)
    expect(result[1].realizedPnl).toBe(-60); // 30 * (158-160)
  });

  it("computes return percentage correctly", () => {
    addRoundTrip(db, {
      accountId: 1,
      securityId: 1,
      acquisitionDate: "2026-01-05",
      saleDate: "2026-01-15",
      quantity: 100,
      acquisitionPrice: 200,
      salePrice: 210,
    });

    const result = getRoundTrips(db, 1, "2026-01-01", "2026-01-31");
    // (1000 / 20000) * 100 = 5%
    expect(result[0].returnPct).toBeCloseTo(5.0, 2);
  });
});

describe("computeRoundTripSummary", () => {
  it("returns zeros for empty array", () => {
    const summary = computeRoundTripSummary([]);
    expect(summary.totalTrades).toBe(0);
    expect(summary.winRate).toBe(0);
    expect(summary.profitFactor).toBe(0);
  });

  it("computes correct metrics for mixed wins and losses", () => {
    const roundTrips = [
      // Win: AAPL +$1000
      {
        accountId: 1,
        securityId: 1,
        symbol: "AAPL",
        securityName: "Apple",
        entryDate: "2026-01-05",
        entryPrice: 150,
        entryQuantity: 100,
        entryCost: 15000,
        exitDate: "2026-01-15",
        exitPrice: 160,
        exitQuantity: 100,
        exitProceeds: 16000,
        holdingDays: 10,
        realizedPnl: 1000,
        returnPct: 6.67,
        saleTransactionId: 1,
      },
      // Win: NVDA +$600
      {
        accountId: 1,
        securityId: 2,
        symbol: "NVDA",
        securityName: "NVIDIA",
        entryDate: "2026-01-10",
        entryPrice: 200,
        entryQuantity: 30,
        entryCost: 6000,
        exitDate: "2026-01-20",
        exitPrice: 220,
        exitQuantity: 30,
        exitProceeds: 6600,
        holdingDays: 10,
        realizedPnl: 600,
        returnPct: 10,
        saleTransactionId: 2,
      },
      // Loss: TSLA -$400
      {
        accountId: 1,
        securityId: 3,
        symbol: "TSLA",
        securityName: "Tesla",
        entryDate: "2026-01-12",
        entryPrice: 300,
        entryQuantity: 20,
        entryCost: 6000,
        exitDate: "2026-01-22",
        exitPrice: 280,
        exitQuantity: 20,
        exitProceeds: 5600,
        holdingDays: 10,
        realizedPnl: -400,
        returnPct: -6.67,
        saleTransactionId: 3,
      },
    ];

    const summary = computeRoundTripSummary(roundTrips);

    expect(summary.totalTrades).toBe(3);
    expect(summary.winningTrades).toBe(2);
    expect(summary.losingTrades).toBe(1);
    expect(summary.winRate).toBeCloseTo(0.667, 2);
    expect(summary.totalRealizedPnl).toBe(1200);
    expect(summary.avgHoldingDays).toBe(10);
    expect(summary.bestTradePnl).toBe(1000);
    expect(summary.bestTradeSymbol).toBe("AAPL");
    expect(summary.worstTradePnl).toBe(-400);
    expect(summary.worstTradeSymbol).toBe("TSLA");
    expect(summary.avgWin).toBe(800); // (1000+600)/2
    expect(summary.avgLoss).toBe(-400);
    expect(summary.profitFactor).toBe(4.0); // 1600/400
  });

  it("handles all-winner scenario", () => {
    const roundTrips = [
      {
        accountId: 1,
        securityId: 1,
        symbol: "AAPL",
        securityName: "Apple",
        entryDate: "2026-01-05",
        entryPrice: 150,
        entryQuantity: 100,
        entryCost: 15000,
        exitDate: "2026-01-15",
        exitPrice: 160,
        exitQuantity: 100,
        exitProceeds: 16000,
        holdingDays: 10,
        realizedPnl: 1000,
        returnPct: 6.67,
        saleTransactionId: 1,
      },
    ];

    const summary = computeRoundTripSummary(roundTrips);
    expect(summary.winRate).toBe(1);
    expect(summary.avgLoss).toBe(0);
    expect(summary.profitFactor).toBe(99.9); // capped (no losses)
  });

  it("handles all-loser scenario", () => {
    const roundTrips = [
      {
        accountId: 1,
        securityId: 3,
        symbol: "TSLA",
        securityName: "Tesla",
        entryDate: "2026-01-12",
        entryPrice: 300,
        entryQuantity: 20,
        entryCost: 6000,
        exitDate: "2026-01-22",
        exitPrice: 280,
        exitQuantity: 20,
        exitProceeds: 5600,
        holdingDays: 10,
        realizedPnl: -400,
        returnPct: -6.67,
        saleTransactionId: 1,
      },
    ];

    const summary = computeRoundTripSummary(roundTrips);
    expect(summary.winRate).toBe(0);
    expect(summary.avgWin).toBe(0);
    expect(summary.profitFactor).toBe(0); // 0/400 = 0
  });
});

describe("detectNewTradeReviewPeriods", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns periods with trades but no reviews", () => {
    addRoundTrip(db, {
      accountId: 1,
      securityId: 1,
      acquisitionDate: "2026-01-05",
      saleDate: "2026-01-15",
      quantity: 100,
      acquisitionPrice: 150,
      salePrice: 160,
    });

    const periods = detectNewTradeReviewPeriods(db);
    expect(periods).toHaveLength(1);
    expect(periods[0].periodStart).toBe("2026-01-01");
    expect(periods[0].periodEnd).toBe("2026-01-31");
    expect(periods[0].tradeCount).toBe(1);
  });

  it("excludes periods that already have reviews", () => {
    addRoundTrip(db, {
      accountId: 1,
      securityId: 1,
      acquisitionDate: "2026-01-05",
      saleDate: "2026-01-15",
      quantity: 100,
      acquisitionPrice: 150,
      salePrice: 160,
    });

    // Add a review for January
    db.prepare(
      `INSERT INTO trade_reviews (account_id, period_start, period_end, total_trades, winning_trades, losing_trades, win_rate, total_realized_pnl, review_markdown)
       VALUES (1, '2026-01-01', '2026-01-31', 1, 1, 0, 1.0, 1000, 'test review')`
    ).run();

    const periods = detectNewTradeReviewPeriods(db);
    expect(periods).toHaveLength(0);
  });

  it("returns empty when no trades exist", () => {
    const periods = detectNewTradeReviewPeriods(db);
    expect(periods).toHaveLength(0);
  });
});

describe("getAvailableReviewPeriods", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns all months with trades for an account", () => {
    addRoundTrip(db, {
      accountId: 1,
      securityId: 1,
      acquisitionDate: "2026-01-05",
      saleDate: "2026-01-15",
      quantity: 50,
      acquisitionPrice: 150,
      salePrice: 160,
    });
    addRoundTrip(db, {
      accountId: 1,
      securityId: 2,
      acquisitionDate: "2026-02-01",
      saleDate: "2026-02-10",
      quantity: 30,
      acquisitionPrice: 200,
      salePrice: 210,
    });

    const periods = getAvailableReviewPeriods(db, 1);
    expect(periods).toHaveLength(2);
    // Ordered DESC
    expect(periods[0].periodStart).toBe("2026-02-01");
    expect(periods[1].periodStart).toBe("2026-01-01");
  });

  it("only returns periods for the specified account", () => {
    addRoundTrip(db, {
      accountId: 1,
      securityId: 1,
      acquisitionDate: "2026-01-05",
      saleDate: "2026-01-15",
      quantity: 50,
      acquisitionPrice: 150,
      salePrice: 160,
    });
    addRoundTrip(db, {
      accountId: 2,
      securityId: 1,
      acquisitionDate: "2026-01-05",
      saleDate: "2026-01-15",
      quantity: 30,
      acquisitionPrice: 150,
      salePrice: 155,
    });

    const periods = getAvailableReviewPeriods(db, 1);
    expect(periods).toHaveLength(1);
    expect(periods[0].tradeCount).toBe(1);
  });
});

// ─── computeGroupedTrades ────────────────────────────────────────

describe("computeGroupedTrades", () => {
  function makeRoundTrip(overrides: Partial<RoundTrip>): RoundTrip {
    return {
      accountId: 1,
      securityId: 1,
      symbol: "AAPL",
      securityName: "Apple Inc",
      entryDate: "2026-01-05",
      entryPrice: 150,
      entryQuantity: 10,
      entryCost: 1500,
      exitDate: "2026-01-20",
      exitPrice: 160,
      exitQuantity: 10,
      exitProceeds: 1600,
      holdingDays: 15,
      realizedPnl: 100,
      returnPct: 6.67,
      saleTransactionId: 1,
      ...overrides,
    };
  }

  it("groups multiple lots from the same sale transaction", () => {
    const roundTrips: RoundTrip[] = [
      makeRoundTrip({
        saleTransactionId: 100,
        entryDate: "2025-06-01",
        entryCost: 500,
        exitQuantity: 5,
        exitProceeds: 800,
        realizedPnl: 300,
        holdingDays: 230,
      }),
      makeRoundTrip({
        saleTransactionId: 100,
        entryDate: "2025-09-01",
        entryCost: 600,
        exitQuantity: 6,
        exitProceeds: 960,
        realizedPnl: 360,
        holdingDays: 140,
      }),
      makeRoundTrip({
        saleTransactionId: 100,
        entryDate: "2025-11-01",
        entryCost: 400,
        exitQuantity: 4,
        exitProceeds: 640,
        realizedPnl: 240,
        holdingDays: 80,
      }),
    ];

    const grouped = computeGroupedTrades(roundTrips);
    expect(grouped).toHaveLength(1);

    const trade = grouped[0];
    expect(trade.saleTransactionId).toBe(100);
    expect(trade.lots).toHaveLength(3);
    expect(trade.totalQuantity).toBe(15); // 5+6+4
    expect(trade.totalCost).toBe(1500); // 500+600+400
    expect(trade.totalProceeds).toBe(2400); // 800+960+640
    expect(trade.realizedPnl).toBe(900); // 300+360+240
    expect(trade.avgEntryPrice).toBe(100); // 1500/15
    // avgHoldingDays = (5*230 + 6*140 + 4*80) / 15 = (1150+840+320)/15 = 154
    expect(trade.avgHoldingDays).toBe(154);
    expect(trade.maxHoldingDays).toBe(230);
    expect(trade.minHoldingDays).toBe(80);
    expect(trade.earliestEntryDate).toBe("2025-06-01");
    expect(trade.latestEntryDate).toBe("2025-11-01");
  });

  it("keeps single-lot trades as individual grouped trades", () => {
    const roundTrips: RoundTrip[] = [
      makeRoundTrip({ saleTransactionId: 1, symbol: "AAPL" }),
      makeRoundTrip({ saleTransactionId: 2, symbol: "GOOG" }),
    ];

    const grouped = computeGroupedTrades(roundTrips);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].lots).toHaveLength(1);
    expect(grouped[1].lots).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    expect(computeGroupedTrades([])).toHaveLength(0);
  });

  it("computes return percentage correctly", () => {
    const roundTrips: RoundTrip[] = [
      makeRoundTrip({
        saleTransactionId: 1,
        entryCost: 1000,
        realizedPnl: -200,
      }),
    ];
    const grouped = computeGroupedTrades(roundTrips);
    expect(grouped[0].returnPct).toBeCloseTo(-20);
  });
});

// ─── computeGroupedSummary ───────────────────────────────────────

describe("computeGroupedSummary", () => {
  it("counts grouped trades, not individual lots", () => {
    // 2 sale transactions: one with 3 lots, one with 1 lot = 2 trades
    const roundTrips: RoundTrip[] = [
      // Sale tx 100: 3 lots, total loss
      {
        accountId: 1, securityId: 1, symbol: "CPRT", securityName: null,
        entryDate: "2024-05-24", entryPrice: 49.75, entryQuantity: 25,
        entryCost: 1243.75, exitDate: "2026-03-11", exitPrice: 35.98,
        exitQuantity: 25, exitProceeds: 899.50, holdingDays: 656,
        realizedPnl: -344.25, returnPct: -27.7, saleTransactionId: 100,
      },
      {
        accountId: 1, securityId: 1, symbol: "CPRT", securityName: null,
        entryDate: "2024-09-11", entryPrice: 45.00, entryQuantity: 20,
        entryCost: 900, exitDate: "2026-03-11", exitPrice: 35.98,
        exitQuantity: 20, exitProceeds: 719.60, holdingDays: 546,
        realizedPnl: -180.40, returnPct: -20.0, saleTransactionId: 100,
      },
      {
        accountId: 1, securityId: 1, symbol: "CPRT", securityName: null,
        entryDate: "2025-07-25", entryPrice: 42.00, entryQuantity: 20,
        entryCost: 840, exitDate: "2026-03-11", exitPrice: 35.98,
        exitQuantity: 20, exitProceeds: 719.60, holdingDays: 229,
        realizedPnl: -120.40, returnPct: -14.3, saleTransactionId: 100,
      },
      // Sale tx 200: 1 lot, winner
      {
        accountId: 1, securityId: 2, symbol: "AAPL", securityName: null,
        entryDate: "2026-03-01", entryPrice: 180, entryQuantity: 10,
        entryCost: 1800, exitDate: "2026-03-15", exitPrice: 195,
        exitQuantity: 10, exitProceeds: 1950, holdingDays: 14,
        realizedPnl: 150, returnPct: 8.33, saleTransactionId: 200,
      },
    ];

    const grouped = computeGroupedTrades(roundTrips);
    expect(grouped).toHaveLength(2); // 2 sale transactions

    const summary = computeGroupedSummary(grouped);
    expect(summary.totalTrades).toBe(2); // NOT 4
    expect(summary.winningTrades).toBe(1); // AAPL
    expect(summary.losingTrades).toBe(1); // CPRT (aggregated)
    expect(summary.winRate).toBe(0.5);
    expect(summary.bestTradeSymbol).toBe("AAPL");
    expect(summary.worstTradeSymbol).toBe("CPRT");
    // CPRT total PnL: -344.25 + -180.40 + -120.40 = -645.05
    expect(summary.worstTradePnl).toBeCloseTo(-645.05);
    expect(summary.bestTradePnl).toBe(150);
  });

  it("returns empty summary for empty input", () => {
    const summary = computeGroupedSummary([]);
    expect(summary.totalTrades).toBe(0);
    expect(summary.winRate).toBe(0);
    expect(summary.totalRealizedPnl).toBe(0);
  });

  it("uses avgHoldingDays (quantity-weighted per trade) for summary avgHoldingDays", () => {
    const roundTrips: RoundTrip[] = [
      {
        accountId: 1, securityId: 1, symbol: "A", securityName: null,
        entryDate: "2026-01-01", entryPrice: 100, entryQuantity: 10,
        entryCost: 1000, exitDate: "2026-02-01", exitPrice: 110,
        exitQuantity: 10, exitProceeds: 1100, holdingDays: 31,
        realizedPnl: 100, returnPct: 10, saleTransactionId: 1,
      },
      {
        accountId: 1, securityId: 2, symbol: "B", securityName: null,
        entryDate: "2026-01-10", entryPrice: 50, entryQuantity: 20,
        entryCost: 1000, exitDate: "2026-01-20", exitPrice: 55,
        exitQuantity: 20, exitProceeds: 1100, holdingDays: 10,
        realizedPnl: 100, returnPct: 10, saleTransactionId: 2,
      },
    ];

    const grouped = computeGroupedTrades(roundTrips);
    const summary = computeGroupedSummary(grouped);
    // (31 + 10) / 2 = 20.5
    expect(summary.avgHoldingDays).toBeCloseTo(20.5);
  });
});

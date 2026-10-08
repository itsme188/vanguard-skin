/**
 * QA finding: security-detail-trade-grades--negative-holding-period-regression-1
 * (owner decision, option 2 — reversed round trips are hidden from grading).
 *
 * A "round trip" whose entry (the matched lot's acquisition) is AFTER its exit
 * (the sale) is a pairing artefact: a sale followed by a repurchase, not a
 * trade the user made in that order. It must never be sent to the model for
 * grading. A real SHORT round trip is different — sell to open, then buy to
 * close: the lot engine stores it with `is_short = 1`, the open date as the
 * lot's acquisition date and the cover as the close, so its holding period is
 * POSITIVE once the stored sign is read — and it must still be graded.
 *
 * Hand-worked book (all figures synthetic), one closing transaction each:
 *
 *   LONG      bought 03-02, sold    03-12  → +10 days  → graded
 *   SHORT     sold   03-05, covered 03-09  → stored -4 (the engine's short
 *             marker), read as +4 days     → graded
 *   REVERSED  sold   03-17, "entry" 03-20  → -3 days   → NOT graded
 *
 * So the grader receives exactly two trades, and the month picker's
 * round-trip count is two as well — the picker and the card agree.
 *
 * `getRoundTrips` is deliberately NOT mocked: the real reader is what keeps a
 * reversed pair out, and this test fails if that predicate is ever removed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/trade-review/market-context", () => ({
  getMarketContext: vi.fn(() => []),
  formatMarketContext: vi.fn(() => ""),
  countCachedPricePoints: vi.fn(() => 0),
}));
vi.mock("@/lib/trade-review/questions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trade-review/questions")>();
  return { ...actual, generateQuestions: vi.fn(async () => []) };
});
// No stored tax-convention state in this fixture — the reader is not under test.
vi.mock("@/lib/compute/tax-convention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/tax-convention")>();
  return { ...actual, isTaxConventionPending: vi.fn(() => false) };
});

import {
  countReviewRoundTrips,
  getAvailableReviewPeriods,
  getRoundTrips,
} from "@/lib/compute/trade-roundtrips";
import { prepareTradeReview } from "@/lib/trade-review/generate";
import { generateQuestions } from "@/lib/trade-review/questions";

const PERIOD = { accountId: 1, periodStart: "2026-03-01", periodEnd: "2026-03-31" };

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, security_id INTEGER,
      trade_date TEXT NOT NULL, type TEXT NOT NULL, quantity REAL,
      price_per_share REAL, amount REAL, notes TEXT
    );
    CREATE TABLE securities (
      id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, name TEXT,
      security_type TEXT DEFAULT 'Stock', currency TEXT DEFAULT 'USD'
    );
    CREATE TABLE fx_rates (currency TEXT PRIMARY KEY, usd_per_unit REAL NOT NULL);
    CREATE TABLE tax_lots (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, security_id INTEGER NOT NULL,
      acquisition_date TEXT NOT NULL, acquisition_price REAL NOT NULL,
      is_short INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tax_lot_sales (
      id INTEGER PRIMARY KEY, tax_lot_id INTEGER NOT NULL,
      sale_transaction_id INTEGER NOT NULL, sale_date TEXT NOT NULL, quantity_sold REAL NOT NULL,
      sale_price REAL NOT NULL, proceeds REAL NOT NULL, cost_basis_allocated REAL NOT NULL,
      realized_gain_loss REAL NOT NULL, holding_period_days INTEGER NOT NULL
    );
    CREATE TABLE trade_reviews (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, period_start TEXT NOT NULL
    );
  `);
  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test Brokerage')");
  db.exec(`INSERT INTO securities (id, symbol, name) VALUES
    (1, 'AAA', 'Long Co'), (2, 'BBB', 'Short Co'), (3, 'ZZZ', 'Reversed Co')`);
  return db;
}

/** One lot closed by one transaction, 10 shares, fully matched. */
function addPair(
  db: Database.Database,
  p: {
    securityId: number;
    lotDate: string;
    closeDate: string;
    closeType: string;
    isShort: 0 | 1;
    storedHoldingDays: number;
    proceeds: number;
    basis: number;
  },
): number {
  const txId = Number(
    db
      .prepare(
        "INSERT INTO transactions (account_id, security_id, trade_date, type, quantity) VALUES (1, ?, ?, ?, 10)",
      )
      .run(p.securityId, p.closeDate, p.closeType).lastInsertRowid,
  );
  const lotId = db
    .prepare(
      "INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, is_short) VALUES (1, ?, ?, 10, ?)",
    )
    .run(p.securityId, p.lotDate, p.isShort).lastInsertRowid;
  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold,
       sale_price, proceeds, cost_basis_allocated, realized_gain_loss, holding_period_days)
     VALUES (?, ?, ?, 10, 11, ?, ?, ?, ?)`,
  ).run(lotId, txId, p.closeDate, p.proceeds, p.basis, p.proceeds - p.basis, p.storedHoldingDays);
  return txId;
}

describe("a reversed round trip is never sent for grading; a real short still is", () => {
  let db: Database.Database;
  let longTx: number;
  let shortTx: number;
  let reversedTx: number;

  beforeEach(() => {
    db = createDb();
    vi.mocked(generateQuestions).mockClear();
    // LONG: bought 03-02, sold 03-12 → 10 days.
    longTx = addPair(db, {
      securityId: 1, lotDate: "2026-03-02", closeDate: "2026-03-12", closeType: "SELL",
      isShort: 0, storedHoldingDays: 10, proceeds: 110, basis: 100,
    });
    // SHORT: sold to open 03-05, bought to close 03-09. The engine stores the
    // 4-day span NEGATED (its marker for a short lifecycle), proceeds = the
    // opening sale, basis = what the cover paid.
    shortTx = addPair(db, {
      securityId: 2, lotDate: "2026-03-05", closeDate: "2026-03-09", closeType: "BUY",
      isShort: 1, storedHoldingDays: -4, proceeds: 120, basis: 100,
    });
    // REVERSED: the sale on 03-17 is paired with a lot bought on 03-20.
    reversedTx = addPair(db, {
      securityId: 3, lotDate: "2026-03-20", closeDate: "2026-03-17", closeType: "SELL",
      isShort: 0, storedHoldingDays: -3, proceeds: 105, basis: 100,
    });
  });

  it("passes the long and the short to the grader and leaves the reversed pair out", async () => {
    const prepared = await prepareTradeReview(db, PERIOD);

    expect(prepared.groupedTrades.map((g) => g.symbol).sort()).toEqual(["AAA", "BBB"]);
    expect(prepared.groupedTrades.map((g) => g.saleTransactionId).sort()).toEqual(
      [longTx, shortTx].sort(),
    );
    expect(prepared.groupedTrades.some((g) => g.saleTransactionId === reversedTx)).toBe(false);
    expect(prepared.summary.totalTrades).toBe(2);

    const fedToModel = vi.mocked(generateQuestions).mock.calls[0][0];
    expect(fedToModel.map((g) => g.symbol).sort()).toEqual(["AAA", "BBB"]);
  });

  it("gives every graded trade a non-negative holding period and entry on or before exit", async () => {
    const { groupedTrades } = await prepareTradeReview(db, PERIOD);
    const bySymbol = new Map(groupedTrades.map((g) => [g.symbol, g]));

    expect(bySymbol.get("AAA")).toMatchObject({ isShort: false, minHoldingDays: 10, maxHoldingDays: 10 });
    // The short is graded with its real 4-day span, not the stored -4.
    expect(bySymbol.get("BBB")).toMatchObject({ isShort: true, minHoldingDays: 4, maxHoldingDays: 4 });

    for (const trade of groupedTrades) {
      expect(trade.minHoldingDays).toBeGreaterThanOrEqual(0);
      for (const lot of trade.lots) {
        expect(lot.entryDate <= lot.exitDate).toBe(true);
      }
    }
  });

  it("the month picker counts the same two round trips the grader receives", async () => {
    const { groupedTrades } = await prepareTradeReview(db, PERIOD);
    const counted = countReviewRoundTrips(
      getRoundTrips(db, PERIOD.accountId, PERIOD.periodStart, PERIOD.periodEnd),
    );
    const [march] = getAvailableReviewPeriods(db, 1);

    expect(counted).toBe(2);
    expect(groupedTrades).toHaveLength(counted);
    expect(march).toMatchObject({ periodStart: "2026-03-01", tradeCount: 2, reviewableCount: 2 });
  });

  it("a month holding only a reversed pair has nothing to grade and calls no model", async () => {
    const only = createDb();
    addPair(only, {
      securityId: 3, lotDate: "2026-03-20", closeDate: "2026-03-17", closeType: "SELL",
      isShort: 0, storedHoldingDays: -3, proceeds: 105, basis: 100,
    });
    await expect(prepareTradeReview(only, PERIOD)).rejects.toThrow(/No closed trades found/);
    expect(generateQuestions).not.toHaveBeenCalled();
    expect(getAvailableReviewPeriods(only, 1)).toEqual([]);
  });
});

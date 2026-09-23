/**
 * QA 2026-09-23 finding (HIGH): the monthly Trade Reviews month picker and
 * review generator counted engine-synthesized RECONCILE_CLOSE sales as the
 * user's own exits. RECONCILE_CLOSE is engine-owned — never user activity.
 *
 * Pinned here:
 *  - getAvailableReviewPeriods / detectNewTradeReviewPeriods count only real
 *    sales; a month whose only sales are synthetic closes is not offered.
 *  - prepareTradeReview drops synthetic groups before coverage filtering,
 *    the summary, questions and the prompt, and says so in a progress note;
 *    a month with only synthetic closes raises a domain error.
 *
 * All figures are synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { RoundTrip } from "@/lib/compute/trade-roundtrips";

const mockRoundTrips: { value: RoundTrip[] } = { value: [] };

vi.mock("@/lib/compute/trade-roundtrips", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/trade-roundtrips")>();
  return { ...actual, getRoundTrips: vi.fn(() => mockRoundTrips.value) };
});
vi.mock("@/lib/trade-review/market-context", () => ({
  getMarketContext: vi.fn(() => []),
  formatMarketContext: vi.fn(() => ""),
}));
vi.mock("@/lib/trade-review/questions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trade-review/questions")>();
  return { ...actual, generateQuestions: vi.fn(async () => []) };
});

import {
  getAvailableReviewPeriods,
  detectNewTradeReviewPeriods,
} from "@/lib/compute/trade-roundtrips";
import { prepareTradeReview } from "@/lib/trade-review/generate";
import { generateQuestions } from "@/lib/trade-review/questions";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, security_id INTEGER,
      trade_date TEXT NOT NULL, type TEXT NOT NULL, quantity REAL,
      price_per_share REAL, amount REAL, notes TEXT
    );
    CREATE TABLE tax_lots (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, security_id INTEGER NOT NULL,
      acquisition_date TEXT NOT NULL
    );
    CREATE TABLE tax_lot_sales (
      id INTEGER PRIMARY KEY, tax_lot_id INTEGER NOT NULL,
      sale_transaction_id INTEGER, sale_date TEXT NOT NULL, quantity_sold REAL NOT NULL
    );
    CREATE TABLE trade_reviews (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, period_start TEXT NOT NULL
    );
  `);
  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'Test Brokerage')");
  return db;
}

function addSale(
  db: Database.Database,
  opts: { saleDate: string; type: string; qty?: number; noTransaction?: boolean },
) {
  const qty = opts.qty ?? 10;
  let txId: number | bigint | null = null;
  if (!opts.noTransaction) {
    txId = db
      .prepare(
        "INSERT INTO transactions (account_id, security_id, trade_date, type, quantity) VALUES (1, 1, ?, ?, ?)",
      )
      .run(opts.saleDate, opts.type, -qty).lastInsertRowid;
  }
  const lotId = db
    .prepare("INSERT INTO tax_lots (account_id, security_id, acquisition_date) VALUES (1, 1, '2026-01-02')")
    .run().lastInsertRowid;
  db.prepare(
    "INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold) VALUES (?, ?, ?, ?)",
  ).run(lotId, txId, opts.saleDate, qty);
}

describe("review periods exclude engine RECONCILE_CLOSE sales", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createDb();
  });

  it("counts only the real sale in a mixed month", () => {
    addSale(db, { saleDate: "2026-03-10", type: "SELL" });
    addSale(db, { saleDate: "2026-03-20", type: "RECONCILE_CLOSE" });
    const periods = getAvailableReviewPeriods(db, 1);
    expect(periods).toEqual([
      { periodStart: "2026-03-01", periodEnd: "2026-03-31", tradeCount: 1, reviewableCount: 1 },
    ]);
  });

  it("does not list a month whose only sales are engine closes", () => {
    addSale(db, { saleDate: "2026-03-10", type: "SELL" });
    addSale(db, { saleDate: "2026-04-15", type: "RECONCILE_CLOSE" });
    addSale(db, { saleDate: "2026-04-16", type: "RECONCILE_CLOSE" });
    const periods = getAvailableReviewPeriods(db, 1);
    expect(periods.map((p) => p.periodStart)).toEqual(["2026-03-01"]);
    expect(detectNewTradeReviewPeriods(db).map((p) => p.periodStart)).toEqual(["2026-03-01"]);
  });

  it("counts a legacy sale with no sale transaction as a real sale", () => {
    addSale(db, { saleDate: "2026-05-05", type: "SELL", noTransaction: true });
    const periods = getAvailableReviewPeriods(db, 1);
    expect(periods).toHaveLength(1);
    expect(periods[0].tradeCount).toBe(1);
  });
});

function rt(overrides: Partial<RoundTrip>): RoundTrip {
  return {
    accountId: 1,
    securityId: 1,
    symbol: "SYNA",
    securityName: "Synthetic A",
    entryDate: "2026-03-02",
    entryPrice: 10,
    entryQuantity: 5,
    entryCost: 50,
    exitDate: "2026-03-12",
    exitPrice: 12,
    exitQuantity: 5,
    exitProceeds: 60,
    holdingDays: 10,
    realizedPnl: 10,
    returnPct: 20,
    saleTransactionId: 1,
    sellTransactionQty: null,
    isSyntheticClose: false,
    ...overrides,
  };
}

describe("prepareTradeReview drops engine-reconciled closes", () => {
  const PARAMS = { accountId: 1, periodStart: "2026-03-01", periodEnd: "2026-03-31" };
  let db: Database.Database;
  beforeEach(() => {
    db = createDb();
    vi.mocked(generateQuestions).mockClear();
  });

  it("feeds only user trades to the summary and questions, with a note", async () => {
    mockRoundTrips.value = [
      rt({ saleTransactionId: 1 }),
      rt({ saleTransactionId: 2, symbol: "SYNB", isSyntheticClose: true }),
      rt({ saleTransactionId: 3, symbol: "SYNC", isSyntheticClose: true }),
    ];
    const notes: string[] = [];
    const prepared = await prepareTradeReview(db, PARAMS, {
      onProgress: (msg) => notes.push(msg),
    });
    expect(prepared.groupedTrades.map((g) => g.saleTransactionId)).toEqual([1]);
    expect(prepared.summary.totalTrades).toBe(1);
    const fedToQuestions = vi.mocked(generateQuestions).mock.calls[0][0];
    expect(fedToQuestions.map((g) => g.symbol)).toEqual(["SYNA"]);
    expect(notes).toContain("Note: 2 engine-reconciled close(s) excluded — not user trades");
  });

  it("emits no note when there are no engine closes", async () => {
    mockRoundTrips.value = [rt({ saleTransactionId: 1 })];
    const notes: string[] = [];
    await prepareTradeReview(db, PARAMS, { onProgress: (msg) => notes.push(msg) });
    expect(notes.some((n) => n.includes("engine-reconciled"))).toBe(false);
  });

  it("throws a domain error when every close is an engine reconciliation", async () => {
    mockRoundTrips.value = [
      rt({ saleTransactionId: 2, isSyntheticClose: true }),
      rt({ saleTransactionId: 3, isSyntheticClose: true }),
    ];
    await expect(prepareTradeReview(db, PARAMS)).rejects.toThrow(
      "No user trades in this period — the 2 closes recorded are engine reconciliations, not your exits",
    );
    expect(generateQuestions).not.toHaveBeenCalled();
  });
});

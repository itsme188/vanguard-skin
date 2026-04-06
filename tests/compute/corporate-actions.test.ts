import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  addCorporateAction,
  listCorporateActions,
  undoCorporateAction,
} from "@/lib/compute/corporate-actions";

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedSecurity(symbol: string): number {
  db.prepare(
    "INSERT OR IGNORE INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')",
  ).run(symbol, `${symbol} Inc`);
  return (db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as { id: number }).id;
}

function seedHolding(accountId: number, securityId: number, quantity: number, date: string) {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, securityId, quantity, date, `test:h:${securityId}:${date}`);
}

function seedPrice(securityId: number, date: string, price: number) {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')",
  ).run(securityId, date, price);
}

function seedOhlcv(securityId: number, date: string, o: number, h: number, l: number, c: number, v: number) {
  db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, ?)`,
  ).run(securityId, date, o, h, l, c, v);
}

function seedTransaction(accountId: number, securityId: number, date: string, type: string, qty: number, price: number) {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(accountId, securityId, date, type, qty, price, qty * price, `test:txn:${securityId}:${date}:${Math.random()}`);
}

function getPrice(securityId: number, date: string): number {
  return (db.prepare("SELECT close_price FROM prices WHERE security_id = ? AND date = ?").get(securityId, date) as { close_price: number }).close_price;
}

function getHoldingQty(securityId: number, date: string): number {
  return (db.prepare("SELECT quantity FROM holdings WHERE security_id = ? AND as_of_date = ?").get(securityId, date) as { quantity: number }).quantity;
}

function getOhlcv(securityId: number, date: string) {
  return db.prepare("SELECT open, high, low, close, volume FROM ohlcv_bars WHERE security_id = ? AND bar_date = ?").get(securityId, date) as { open: number; high: number; low: number; close: number; volume: number };
}

function getTxnQty(securityId: number, date: string): number {
  return (db.prepare("SELECT quantity FROM transactions WHERE security_id = ? AND trade_date = ?").get(securityId, date) as { quantity: number }).quantity;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("addCorporateAction — 2:1 stock split", () => {
  it("doubles pre-split holdings and halves pre-split prices", () => {
    const acct = seedAccount("Test");
    const sec = seedSecurity("AAPL");

    // Pre-split data (before 2025-06-15)
    seedHolding(acct, sec, 100, "2025-06-01");
    seedPrice(sec, "2025-06-01", 200);
    seedPrice(sec, "2025-06-10", 210);

    // Post-split data (on or after 2025-06-15) — should NOT be adjusted
    seedHolding(acct, sec, 200, "2025-06-15");
    seedPrice(sec, "2025-06-15", 105);

    addCorporateAction(db, {
      securityId: sec,
      actionType: "SPLIT",
      effectiveDate: "2025-06-15",
      ratioNumerator: 2,
      notes: "2:1 forward split",
    });

    // Pre-split holdings doubled
    expect(getHoldingQty(sec, "2025-06-01")).toBe(200);
    // Pre-split prices halved
    expect(getPrice(sec, "2025-06-01")).toBe(100);
    expect(getPrice(sec, "2025-06-10")).toBe(105);
    // Post-split data unchanged
    expect(getHoldingQty(sec, "2025-06-15")).toBe(200);
    expect(getPrice(sec, "2025-06-15")).toBe(105);
  });

  it("adjusts OHLCV bars", () => {
    const sec = seedSecurity("MSFT");
    seedOhlcv(sec, "2025-06-01", 300, 310, 290, 305, 10000);

    addCorporateAction(db, {
      securityId: sec,
      actionType: "SPLIT",
      effectiveDate: "2025-06-15",
      ratioNumerator: 2,
    });

    const bar = getOhlcv(sec, "2025-06-01");
    expect(bar.open).toBe(150);
    expect(bar.high).toBe(155);
    expect(bar.low).toBe(145);
    expect(bar.close).toBeCloseTo(152.5);
    expect(bar.volume).toBe(20000);
  });

  it("adjusts transaction quantities and per-share prices", () => {
    const acct = seedAccount("Test");
    const sec = seedSecurity("GOOG");
    seedTransaction(acct, sec, "2025-06-01", "BUY", 50, 180);

    addCorporateAction(db, {
      securityId: sec,
      actionType: "SPLIT",
      effectiveDate: "2025-06-15",
      ratioNumerator: 2,
    });

    const txn = db.prepare(
      "SELECT quantity, price_per_share FROM transactions WHERE security_id = ? AND trade_date = '2025-06-01'",
    ).get(sec) as { quantity: number; price_per_share: number };

    expect(txn.quantity).toBe(100); // doubled
    expect(txn.price_per_share).toBe(90); // halved
  });
});

describe("addCorporateAction — 1:10 reverse split", () => {
  it("divides pre-split holdings and multiplies prices", () => {
    const acct = seedAccount("Test");
    const sec = seedSecurity("PENNY");

    seedHolding(acct, sec, 1000, "2025-06-01");
    seedPrice(sec, "2025-06-01", 0.50);

    addCorporateAction(db, {
      securityId: sec,
      actionType: "REVERSE_SPLIT",
      effectiveDate: "2025-06-15",
      ratioNumerator: 1,
      ratioDenominator: 10,
    });

    // 1:10 reverse → ratio = 0.1
    expect(getHoldingQty(sec, "2025-06-01")).toBe(100); // 1000 * 0.1
    expect(getPrice(sec, "2025-06-01")).toBe(5.0); // 0.50 / 0.1
  });
});

describe("idempotency", () => {
  it("applying same split twice creates a duplicate error", () => {
    const sec = seedSecurity("AAPL");
    seedPrice(sec, "2025-06-01", 200);

    addCorporateAction(db, {
      securityId: sec,
      actionType: "SPLIT",
      effectiveDate: "2025-06-15",
      ratioNumerator: 2,
    });

    // Second attempt with same params should fail on UNIQUE constraint
    expect(() =>
      addCorporateAction(db, {
        securityId: sec,
        actionType: "SPLIT",
        effectiveDate: "2025-06-15",
        ratioNumerator: 2,
      }),
    ).toThrow();

    // Price should have been adjusted only once
    expect(getPrice(sec, "2025-06-01")).toBe(100);
  });
});

describe("undoCorporateAction", () => {
  it("reverses a split and restores original values", () => {
    const acct = seedAccount("Test");
    const sec = seedSecurity("AAPL");

    seedHolding(acct, sec, 100, "2025-06-01");
    seedPrice(sec, "2025-06-01", 200);

    const action = addCorporateAction(db, {
      securityId: sec,
      actionType: "SPLIT",
      effectiveDate: "2025-06-15",
      ratioNumerator: 2,
    });

    // Verify split was applied
    expect(getHoldingQty(sec, "2025-06-01")).toBe(200);
    expect(getPrice(sec, "2025-06-01")).toBe(100);

    // Undo
    undoCorporateAction(db, action.id);

    // Should be back to original
    expect(getHoldingQty(sec, "2025-06-01")).toBe(100);
    expect(getPrice(sec, "2025-06-01")).toBeCloseTo(200, 5);

    // Action record should be deleted
    expect(listCorporateActions(db, sec)).toHaveLength(0);
  });
});

describe("listCorporateActions", () => {
  it("lists all actions sorted by date descending", () => {
    const sec1 = seedSecurity("AAPL");
    const sec2 = seedSecurity("MSFT");

    // Insert directly to avoid side effects
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied)
       VALUES (?, 'SPLIT', '2025-06-15', 2, 1, 1)`,
    ).run(sec1);
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied)
       VALUES (?, 'SPLIT', '2025-08-01', 4, 1, 1)`,
    ).run(sec2);

    const all = listCorporateActions(db);
    expect(all).toHaveLength(2);
    expect(all[0].effectiveDate).toBe("2025-08-01"); // most recent first

    const aaplOnly = listCorporateActions(db, sec1);
    expect(aaplOnly).toHaveLength(1);
    expect(aaplOnly[0].actionType).toBe("SPLIT");
  });
});

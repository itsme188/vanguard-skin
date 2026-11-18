/**
 * A currency-conversion leg (an IBKR Forex trade on a `BASE.QUOTE` pair) is
 * stored with `quantity` in BASE units, `price_per_share` in QUOTE per BASE
 * and `amount` in the QUOTE currency, while the security's own currency says
 * USD. The one rule (lib/queries/transaction-amount-currency.ts) reads the
 * quote off the pair, and a USD-base leg's dollar size is its own base
 * quantity, so the dashboard list, the Amount sort and the chat agree.
 * Synthetic pairs and invented round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getTransactionsByAccount } from "@/lib/queries/transactions";
import { getTransactionsBySecurity } from "@/lib/queries/security-detail";
import { getTransactionsForChat } from "@/lib/queries/chat-tools";

const ACCOUNT_ID = 1;

function security(db: Database.Database, symbol: string, type: string, currency = "USD"): number {
  return Number(
    db
      .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, ?, ?)")
      .run(symbol, symbol, type, currency).lastInsertRowid,
  );
}

function row(db: Database.Database, securityId: number, type: string, quantity: number, price: number, amount: number) {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, source_key)
     VALUES (?, ?, '2026-06-29', ?, ?, ?, ?, ?)`,
  ).run(ACCOUNT_ID, securityId, type, quantity, amount, price, `forex-test:${securityId}:${type}:${amount}`);
}

describe("currency-conversion legs are read in their quote currency", () => {
  let db: Database.Database;
  let usdBase: number;
  let usdQuote: number;
  let cross: number;
  let stock: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    usdBase = security(db, "USD.ZZZ", "Forex");
    usdQuote = security(db, "ZZZ.USD", "forex");
    cross = security(db, "ZZZ.YYY", "FOREX");
    stock = security(db, "ZZST", "Stock");
    // Sell 1,000 USD for 1,500,000 ZZZ.
    row(db, usdBase, "SELL", 1000, 1500, 1500000);
    // Buy 2,000 ZZZ for 1,000 USD.
    row(db, usdQuote, "BUY", 2000, 0.5, -1000);
    // Sell 300 ZZZ for 600 YYY.
    row(db, cross, "SELL", 300, 2, 600);
    // A plain USD stock sale of 5,000.
    row(db, stock, "SELL", 50, 100, 5000);
  });

  it("Accounts page: the USD-base sale shows its 1,000 dollars, not 1,500,000", () => {
    const rows = getTransactionsByAccount(db, ACCOUNT_ID);
    const sale = rows.find((r) => r.security_id === usdBase)!;
    expect(sale.amount).toBeCloseTo(1000, 6);
    expect(sale.price_per_share).toBeCloseTo(1, 6);
    expect(rows.find((r) => r.security_id === usdQuote)!.amount).toBe(-1000);
    expect(rows.find((r) => r.security_id === stock)!.amount).toBe(5000);
  });

  it("the dollar size takes the amount's sign, whatever sign the quantity carries", () => {
    row(db, usdBase, "BUY", -400, 1500, -600000);
    const buy = getTransactionsByAccount(db, ACCOUNT_ID).find((r) => r.security_id === usdBase && r.type === "BUY")!;
    expect(buy.amount).toBeCloseTo(-400, 6);
  });

  it("Security page: the same", () => {
    const rows = getTransactionsBySecurity(db, usdBase);
    expect(rows[0].amount).toBeCloseTo(1000, 6);
  });

  it("the Amount sort ranks the USD-base sale by its dollars", () => {
    const desc = getTransactionsByAccount(db, ACCOUNT_ID, { sort: { field: "amount", dir: "desc" } });
    const order = desc.map((r) => r.security_id);
    expect(order.indexOf(stock)).toBeLessThan(order.indexOf(usdBase));
  });

  it("chat: quote currency, dollar size, and null for a cross pair", () => {
    const chat = getTransactionsForChat(db, {});
    const sale = chat.find((r) => r.symbol === "USD.ZZZ")!;
    expect(sale.amount_currency).toBe("ZZZ");
    expect(sale.amount_usd).toBeCloseTo(1000, 6);
    const quoted = chat.find((r) => r.symbol === "ZZZ.USD")!;
    expect(quoted.amount_currency).toBe("USD");
    expect(quoted.amount_usd).toBe(-1000);
    const crossRow = chat.find((r) => r.symbol === "ZZZ.YYY")!;
    expect(crossRow.amount_currency).toBe("YYY");
    expect(crossRow.amount_usd).toBeNull();
    const stockRow = chat.find((r) => r.symbol === "ZZST")!;
    expect(stockRow.amount_currency).toBe("USD");
    expect(stockRow.amount_usd).toBe(5000);
  });

  it("the chat and the dashboard agree on every dollar-readable leg", () => {
    const chat = getTransactionsForChat(db, {});
    const page = getTransactionsByAccount(db, ACCOUNT_ID);
    for (const id of [usdBase, usdQuote, stock]) {
      const p = page.find((r) => r.security_id === id)!;
      const c = chat.find((r) => r.symbol === p.symbol)!;
      expect(c.amount_usd).toBeCloseTo(p.amount as number, 6);
    }
  });
});

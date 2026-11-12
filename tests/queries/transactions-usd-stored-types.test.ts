/**
 * The dashboard transaction readers convert a row's amount to USD only when
 * it is stored in a foreign currency (2026-11-12). A trade leg is stored in
 * the security's native currency; the IBKR cash sections (dividends,
 * interest, fees, deposits and withdrawals) are converted to USD at import
 * (`emitCurrencyBlocks`). Multiplying every security-linked amount by the
 * rate converted a USD-stored dividend on a yen stock a second time.
 * One rule for the chat and the dashboard: lib/queries/transaction-amount-currency.ts.
 * Synthetic tickers and invented round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getTransactionsByAccount } from "@/lib/queries/transactions";
import { getTransactionsBySecurity } from "@/lib/queries/security-detail";
import { getTransactionsForChat } from "@/lib/queries/chat-tools";

const ACCOUNT_ID = 1;

function row(db: Database.Database, securityId: number, type: string, amount: number, price: number | null, quantity: number | null) {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, source_key)
     VALUES (?, ?, '2026-06-29', ?, ?, ?, ?, ?)`
  ).run(ACCOUNT_ID, securityId, type, quantity, amount, price, `usd-stored:${type}:${amount}`);
}

describe("USD-stored transaction types are not converted again", () => {
  let db: Database.Database;
  let yen: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    yen = Number(db.prepare("INSERT INTO securities (symbol, name, currency) VALUES ('ZZY', 'ZZY Corp', 'JPY')").run().lastInsertRowid);
    row(db, yen, "BUY", -200000, 2000, 100);
    row(db, yen, "DIVIDEND", 40, null, null);
    upsertFxRate(db, { currency: "JPY", usdPerUnit: 0.0065, asOf: "2026-06-29", source: "test" });
  });

  it("Accounts page: a dividend of 40 stored in USD shows 40; the yen buy converts once", () => {
    const rows = getTransactionsByAccount(db, ACCOUNT_ID);
    const div = rows.find((r) => r.type === "DIVIDEND")!;
    const buy = rows.find((r) => r.type === "BUY")!;
    expect(div.amount).toBe(40);
    expect(buy.amount).toBeCloseTo(-1300, 6);
    expect(buy.price_per_share).toBeCloseTo(13, 6);
  });

  it("Security page: the same", () => {
    const rows = getTransactionsBySecurity(db, yen);
    expect(rows.find((r) => r.type === "DIVIDEND")!.amount).toBe(40);
    expect(rows.find((r) => r.type === "BUY")!.amount).toBeCloseTo(-1300, 6);
  });

  it("Accounts page sort by amount orders by the same figures", () => {
    // A yen sale of 5,000 is 32.50 dollars: below the 40 dividend, above it
    // only if the dividend is converted a second time.
    row(db, yen, "SELL", 5000, 1000, 5);
    const desc = getTransactionsByAccount(db, ACCOUNT_ID, { sort: { field: "amount", dir: "desc" } });
    expect(desc.map((r) => r.type)).toEqual(["DIVIDEND", "SELL", "BUY"]);
    const asc = getTransactionsByAccount(db, ACCOUNT_ID, { sort: { field: "amount", dir: "asc" } });
    expect(asc.map((r) => r.type)).toEqual(["BUY", "SELL", "DIVIDEND"]);
  });

  it("the chat reader agrees with both dashboard readers", () => {
    const chat = getTransactionsForChat(db, {});
    const page = getTransactionsByAccount(db, ACCOUNT_ID);
    for (const type of ["BUY", "DIVIDEND"]) {
      expect(chat.find((r) => r.type === type)!.amount_usd).toBeCloseTo(page.find((r) => r.type === type)!.amount as number, 6);
    }
  });
});

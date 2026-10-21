import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getTransactionsForChat } from "@/lib/queries/chat-tools";

describe("getTransactionsForChat never lists an engine-made close", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, currency, multiplier)
       VALUES ('AAA', 'AAA Corp', 'stock', 'equity', 'USD', 1)`
    ).run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol = 'AAA'").get() as { id: number }).id;
    const ins = db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, fees, source_key)
       VALUES (1, ?, ?, ?, ?, ?, ?, 0, ?)`
    );
    ins.run(secId, "2025-01-10", "BUY", 10, -1000, 100, "t-buy");
    ins.run(secId, "2025-01-20", "RECONCILE_CLOSE", -10, 1100, 110, "t-rc");
  });

  it("returns only the BUY with no type filter", () => {
    expect(getTransactionsForChat(db).map((t) => t.type)).toEqual(["BUY"]);
  });

  it("still omits the close when asked for the type explicitly", () => {
    expect(getTransactionsForChat(db, { type: "RECONCILE_CLOSE" })).toEqual([]);
    expect(getTransactionsForChat(db, { type: "BUY" }).map((t) => t.type)).toEqual(["BUY"]);
  });
});

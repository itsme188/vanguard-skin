import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getHoldingsForChat } from "@/lib/queries/chat-tools";

function seed(db: Database.Database, laterQty: number): void {
  db.prepare(
    `INSERT INTO securities (symbol, name, security_type, asset_class, currency, multiplier)
     VALUES ('AAA', 'AAA Corp', 'stock', 'equity', 'USD', 1)`
  ).run();
  const secId = (db.prepare("SELECT id FROM securities WHERE symbol = 'AAA'").get() as { id: number }).id;
  const ins = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (1, ?, ?, ?, ?, ?)`
  );
  ins.run(secId, 10, 1000, "2025-01-31", "canonical:stmt-AAA-2025-01-31");
  ins.run(secId, laterQty, null, "2025-02-15", "plaid:AAA-2025-02-15");
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2025-02-15', 150)").run(secId);
}

describe("getHoldingsForChat cost basis fallback", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("reads a Plaid row's missing basis from the latest earlier row of the pair", () => {
    seed(db, 10);
    const row = getHoldingsForChat(db).find((h) => h.symbol === "AAA");
    expect(row).toBeDefined();
    expect(row!.cost_basis).toBeCloseTo(1000, 2);
    expect(row!.unrealized_gain).toBeCloseTo(500, 2);
    expect(row!.unrealized_gain_pct).toBeCloseTo(50, 2);
  });

  it("scales the fallback basis by quantity when the position changed", () => {
    seed(db, 20);
    const row = getHoldingsForChat(db).find((h) => h.symbol === "AAA");
    expect(row).toBeDefined();
    expect(row!.cost_basis).toBeCloseTo(2000, 2);
    expect(row!.unrealized_gain).toBeCloseTo(1000, 2);
  });
});

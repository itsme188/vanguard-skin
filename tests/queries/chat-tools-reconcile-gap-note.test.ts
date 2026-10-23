import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getTransactionsForChat, getReconcileGapNotesForChat } from "@/lib/queries/chat-tools";

describe("a hidden synthetic close leaves a ledger-gap note", () => {
  let db: Database.Database;
  let accountName: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    accountName = (db.prepare("SELECT name FROM accounts WHERE id = 1").get() as { name: string }).name;
    for (const sym of ["AAA", "ZZZ"]) {
      db.prepare(
        `INSERT INTO securities (symbol, name, security_type, asset_class, currency, multiplier)
         VALUES (?, ?, 'stock', 'equity', 'USD', 1)`
      ).run(sym, `${sym} Corp`);
    }
    const id = (s: string) => (db.prepare("SELECT id FROM securities WHERE symbol = ?").get(s) as { id: number }).id;
    const ins = db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, fees, source_key)
       VALUES (1, ?, ?, ?, ?, ?, ?, 0, ?)`
    );
    ins.run(id("AAA"), "2025-01-10", "BUY", 10, -1000, 100, "a-buy");
    ins.run(id("AAA"), "2025-01-20", "RECONCILE_CLOSE", -10, 1100, 110, "a-rc");
    ins.run(id("ZZZ"), "2025-01-10", "BUY", 5, -500, 100, "z-buy");
  });

  it("hides the close from rows but names the gap", () => {
    expect(getTransactionsForChat(db, { symbol: "AAA" }).map((t) => t.type)).toEqual(["BUY"]);
    const notes = getReconcileGapNotesForChat(db, { symbol: "AAA" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("AAA");
    expect(notes[0]).toContain(accountName);
    expect(notes[0]).toContain("2025-01-20");
    expect(notes[0]).toContain("10");
    expect(notes[0]).toMatch(/ledger gap/i);
  });

  it("gives no note for a symbol without a synthetic close", () => {
    expect(getReconcileGapNotesForChat(db, { symbol: "ZZZ" })).toEqual([]);
  });

  it("respects the date window", () => {
    expect(getReconcileGapNotesForChat(db, { symbol: "AAA", end_date: "2025-01-15" })).toEqual([]);
  });
});

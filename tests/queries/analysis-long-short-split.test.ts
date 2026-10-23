import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllocationByDimension } from "@/lib/queries/analysis";

// Synthetic book: sector T holds a long and a short, sector F only a short.
function seeded(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run();
  const acct = (db.prepare("SELECT id FROM accounts").get() as { id: number }).id;
  const add = (symbol: string, sector: string, qty: number) => {
    const sid = db
      .prepare("INSERT INTO securities (symbol, name, security_type, sector) VALUES (?, ?, 'Stock', ?)")
      .run(symbol, symbol, sector).lastInsertRowid as number;
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, '2026-06-01', 'test:' || ?)"
    ).run(acct, sid, qty, sid);
    db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 10, '2026-06-01', 'test')").run(sid);
  };
  add("AAA", "Technology", 100); // +1000
  add("ZZZ", "Technology", -40); // -400
  add("YYY", "Financials", -10); // -100
  return db;
}

describe("sector allocation carries the long/short split", () => {
  it("long_value and short_value are summed per sector without netting", () => {
    const rows = getAllocationByDimension(seeded(), "sector");
    const t = rows.find((r) => r.group_name === "Technology")!;
    const f = rows.find((r) => r.group_name === "Financials")!;
    expect(t.total_market_value).toBe(600);
    expect(t.long_value).toBe(1000);
    expect(t.short_value).toBe(-400);
    expect(f.long_value).toBe(0);
    expect(f.short_value).toBe(-100);
  });

  it("the generic dimension path carries it too", () => {
    const rows = getAllocationByDimension(seeded(), "security_type");
    expect(rows).toHaveLength(1);
    expect(rows[0].long_value).toBe(1000);
    expect(rows[0].short_value).toBe(-500);
  });
});

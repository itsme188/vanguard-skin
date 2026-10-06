import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { getAllocationByDimension } from "@/lib/queries/analysis";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seed(symbol: string, expiration: string | null): void {
  const sid = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, fund_category, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, ?, 'Options', 'ZZZ', 'CALL', 100, ?, 100)`
    )
    .run(symbol, symbol, expiration ? "Option" : "Stock", expiration).lastInsertRowid as number;
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES ('Test')").run();
  const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'Test'").get() as { id: number }).id;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 1, '2026-06-01', 'test:' || ?)"
  ).run(acct, sid, sid);
  db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 5, '2026-06-01', 'test')").run(sid);
}

describe("allocation excludes expired options", () => {
  it("drops an option that expired yesterday (ET) from every dimension incl. sector", () => {
    seed("LIVE", addDays(todayET(), 5));
    seed("DEAD", addDays(todayET(), -1));
    for (const dim of ["fund_category", "sector"] as const) {
      const rows = getAllocationByDimension(db, dim);
      const total = rows.reduce((s, r) => s + r.total_market_value, 0);
      expect(total).toBeCloseTo(500, 0); // only LIVE: 1 * 5 * 100
    }
  });

  it("keeps an option expiring today", () => {
    seed("TODAY", todayET());
    const rows = getAllocationByDimension(db, "fund_category");
    expect(rows.reduce((s, r) => s + r.total_market_value, 0)).toBeCloseTo(500, 0);
  });
});

/**
 * The What-if baseline leaves an expired option out, as Scenario Modeling,
 * Defense and Concentration already do. Before 2026-10-24 an option that
 * expired at Friday's close still counted in "Total Value" and the weights
 * until a closing row arrived.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeExposureDelta } from "@/lib/compute/exposure-delta";

// Migration 002 seeds: 3 = IBKR.
function seed(db: Database.Database) {
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (1, 'AAA', 'Stock', 'Technology')`).run();
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector, underlying_symbol, expiration_date, option_type, strike_price, multiplier)
     VALUES (2, 'AAA   990117C00100000', 'Option', 'Technology', 'AAA', '2099-01-17', 'CALL', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector, underlying_symbol, expiration_date, option_type, strike_price, multiplier)
     VALUES (3, 'AAA   200117C00100000', 'Option', 'Technology', 'AAA', '2020-01-17', 'CALL', 100, 100)`,
  ).run();
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (1, '2026-01-02', 200, 'tws')`).run();
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (2, '2026-01-02', 5, 'tws')`).run();
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (3, '2026-01-02', 3, 'tws')`).run();
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 1, '2026-01-02', 10, 'tws-aaa')`).run();
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 2, '2026-01-02', 2, 'tws-live')`).run();
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 3, '2026-01-02', 4, 'tws-expired')`).run();
}

describe("computeExposureDelta baseline and expired options", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seed(db);
  });

  it("an expired option is left out of the baseline total and the weights; a live one stays", () => {
    const result = computeExposureDelta(db, "ibkr", [3], []);
    // 10 * 200 (stock) + 2 * 5 * 100 (live call); the expired call's 4 * 3 * 100 is not counted.
    expect(result.before.totalValue).toBe(2000 + 1000);
    const symbols = result.before.topConcentrations.map((c) => c.symbol);
    expect(symbols).toContain("AAA   990117C00100000");
    expect(symbols).not.toContain("AAA   200117C00100000");
    const stock = result.before.topConcentrations.find((c) => c.symbol === "AAA")!;
    expect(stock.weightPct).toBeCloseTo(2000 / 3000, 6); // weightPct is a fraction
  });
});

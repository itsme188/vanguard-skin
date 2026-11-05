import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAccountCashLine } from "@/lib/queries/account-cash-line";

/**
 * The footer's held-securities read (which dates the positions figure and
 * names the sweep funds) leaves out an option contract that had expired
 * before the footer's valuation date, through the one expiry reader
 * (liveOptionExpirationSql) bound to that date. A contract still live on the
 * valuation date stays in.
 *
 * Synthetic fixtures: ZZ* symbols, round figures.
 */
describe("getAccountCashLine: expired options", () => {
  let db: Database.Database;
  let accountId: number;

  function seedSecurity(symbol: string, type: string, expiration: string | null): number {
    return db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, expiration_date, multiplier, currency)
         VALUES (?, ?, ?, ?, ?, 'USD')`,
      )
      .run(symbol, `${symbol} test`, type, expiration, type === "Option" ? 100 : 1)
      .lastInsertRowid as number;
  }

  function seedHolding(securityId: number, quantity: number, asOf: string): void {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).run(accountId, securityId, quantity, asOf, `zz:${securityId}:${asOf}`);
  }

  function seedPrice(securityId: number, date: string, close: number): void {
    db.prepare(
      `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`,
    ).run(securityId, date, close);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    accountId = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Broker')").run()
      .lastInsertRowid as number;
    db.prepare(
      `INSERT INTO daily_valuations
         (account_id, valuation_date, cash_balance, holdings_value, total_value, holdings_count, priced_count)
       VALUES (?, '2026-01-12', 1000, 10000, 11000, 2, 2)`,
    ).run(accountId);
  });

  it("an option expired before the valuation date does not date the positions", () => {
    const stock = seedSecurity("ZZZ", "Stock", null);
    const expired = seedSecurity("ZZZ 260109C00100000", "Option", "2026-01-09");
    seedHolding(stock, 100, "2026-01-02");
    seedHolding(expired, 1, "2026-01-09");
    seedPrice(stock, "2026-01-02", 100);
    seedPrice(expired, "2026-01-09", 1);

    expect(getAccountCashLine(db, accountId)?.positionsPriceDate).toBe("2026-01-02");
  });

  it("the legacy compact expiration spelling reads as expired too", () => {
    const stock = seedSecurity("ZZZ", "Stock", null);
    const expired = seedSecurity("ZZZ 260109P00100000", "Option", "20260109");
    seedHolding(stock, 100, "2026-01-02");
    seedHolding(expired, 1, "2026-01-09");
    seedPrice(stock, "2026-01-02", 100);
    seedPrice(expired, "2026-01-09", 1);

    expect(getAccountCashLine(db, accountId)?.positionsPriceDate).toBe("2026-01-02");
  });

  it("an option still live on the valuation date (its expiry day or later) stays in", () => {
    const stock = seedSecurity("ZZZ", "Stock", null);
    const live = seedSecurity("ZZZ 260112C00100000", "Option", "2026-01-12");
    seedHolding(stock, 100, "2026-01-02");
    seedHolding(live, 1, "2026-01-12");
    seedPrice(stock, "2026-01-02", 100);
    seedPrice(live, "2026-01-12", 1);

    expect(getAccountCashLine(db, accountId)?.positionsPriceDate).toBe("2026-01-12");
  });
});

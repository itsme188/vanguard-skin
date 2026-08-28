import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getExpiringOptions } from "@/lib/compute/options-expirations";
import { addDays, todayET } from "@/lib/calendar/date-utils";

describe("getExpiringOptions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    // Note: accounts table is pre-seeded by migration 002 with id 1, 2, 3.
    // Use account 1 (Vanguard Taxable) for these tests.

    // Three options: <30 days, 60 days, >90 days from today
    const today = todayET();
    const in15 = addDays(today, 15);
    const in60 = addDays(today, 60);
    const in120 = addDays(today, 120);

    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (100, 'AAPL  C200', 'Option', 'CALL', 200, ?, 'AAPL', 100)`).run(in15);
    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (101, 'MSFT  C400', 'Option', 'CALL', 400, ?, 'MSFT', 100)`).run(in60);
    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (102, 'GOOG  C150', 'Option', 'CALL', 150, ?, 'GOOG', 100)`).run(in120);

    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 100, '2026-04-30', 1, 'vg-1')`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 101, '2026-04-30', 2, 'vg-2')`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 102, '2026-04-30', 3, 'vg-3')`).run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns options expiring within the default 90-day window", () => {
    const result = getExpiringOptions(db, { daysWindow: 90 });
    const symbols = result.map((r) => r.symbol).sort();
    expect(symbols).toEqual(["AAPL  C200", "MSFT  C400"]);
  });

  it("respects custom daysWindow", () => {
    const result = getExpiringOptions(db, { daysWindow: 30 });
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("AAPL  C200");
  });

  it("excludes already-expired options", () => {
    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (200, 'OLD  C100', 'Option', 'CALL', 100, '2025-01-01', 'OLD', 100)`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 200, '2026-04-30', 1, 'vg-old')`).run();

    const result = getExpiringOptions(db, { daysWindow: 90 });
    expect(result.find((r) => r.symbol.startsWith("OLD"))).toBeUndefined();
  });

  it("excludes zero-quantity holdings", () => {
    db.prepare(`UPDATE holdings SET quantity = 0 WHERE security_id = 100`).run();
    const result = getExpiringOptions(db, { daysWindow: 90 });
    expect(result.find((r) => r.symbol.startsWith("AAPL"))).toBeUndefined();
  });

  it("filters by accountIds", () => {
    // accounts 2 and 3 already exist (Roth, IBKR) — neither has options seeded
    const result = getExpiringOptions(db, { accountIds: [3] });
    expect(result).toHaveLength(0);
  });

  it("includes account name in result rows", () => {
    const result = getExpiringOptions(db);
    expect(result[0].accountName).toBe("Vanguard Taxable");
  });

  it("keeps an ET-today expiry at 0 DTE after UTC has advanced to tomorrow", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T23:30:00-04:00"));
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-08-29");

    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (300, 'SPY   260828P00600000', 'Option', 'PUT', 600, '2026-08-28', 'SPY', 100)`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 300, '2026-08-28', 1, 'et-today')`).run();

    const result = getExpiringOptions(db, { daysWindow: 0 });
    expect(result.find((row) => row.securityId === 300)?.daysToExpiry).toBe(0);
  });
});

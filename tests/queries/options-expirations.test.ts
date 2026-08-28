import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getExpiringOptions } from "@/lib/queries/options";

describe("getExpiringOptions query", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    db.prepare(`INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
                VALUES (100, 'SPY   260828P00600000', 'Option', 'PUT', 600, '2026-08-28', 'SPY', 100)`).run();
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
                VALUES (1, 100, '2026-08-28', 1, 'et-today')`).run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses an injected ET date for the expiry window and DTE", () => {
    const result = getExpiringOptions(db, 0, undefined, "2026-08-28");

    expect(result).toHaveLength(1);
    expect(result[0].daysToExpiry).toBe(0);
  });

  it("defaults to ET today after the previous UTC derivation has advanced to tomorrow", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T23:30:00-04:00"));
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-08-29");

    const result = getExpiringOptions(db, 0);
    expect(result[0].daysToExpiry).toBe(0);
  });
});

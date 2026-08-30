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

/**
 * getExpiringOptions per-pair "latest" holdings — holdings-latest-sweep
 * Task 1. Previously keyed "latest" off a fully GLOBAL MAX(as_of_date)
 * subquery (no account/security correlation) with no quantity filter.
 * `latestHoldingsPredicate({ accountFilter: "" })` fixes both: per-
 * (account, security) "latest" plus quantity != 0 (tombstone exclusion).
 */
describe("getExpiringOptions — per-pair latest holdings (holdings-latest-sweep Task 1)", () => {
  let db: Database.Database;
  const TODAY = "2026-08-28";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedOption(
    id: number,
    underlying: string,
    expiration: string
  ): void {
    db.prepare(
      `INSERT INTO securities
         (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
       VALUES (?, ?, 'Option', 'CALL', 50, ?, ?, 100)`
    ).run(id, `${underlying}  260117C00050000`, expiration, underlying);
  }

  it("fixture 1: statement-lag row survives — security A's only row is older than security B's, same account, both returned", () => {
    seedOption(500, "AAA", "2026-09-10");
    seedOption(501, "BBB", "2026-09-15");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (1, 500, 1, '2025-01-31', 'exp-a-1')`
    ).run();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (1, 501, 1, '2025-02-28', 'exp-b-1')`
    ).run();

    const result = getExpiringOptions(db, 30, undefined, TODAY);
    const underlyings = result.map((r) => r.underlying).sort();
    expect(underlyings).toEqual(["AAA", "BBB"]);
  });

  it("fixture 2: tombstone hides — security C's newest holdings row is a quantity=0 tombstone, C absent even though its expiration is in-window", () => {
    seedOption(502, "CCC", "2026-09-20");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (1, 502, 10, '2025-01-31', 'exp-c-1')`
    ).run();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (1, 502, 0, '2025-02-28', 'exp-c-2')`
    ).run();

    const result = getExpiringOptions(db, 30, undefined, TODAY);
    expect(result.find((r) => r.underlying === "CCC")).toBeUndefined();
  });

  it("fixture 3: trailing account survives — account 2's only row predates account 1's latest, both returned", () => {
    seedOption(503, "XXX", "2026-09-25");
    seedOption(504, "YYY", "2026-09-26");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (1, 503, 1, '2025-02-28', 'exp-x-1')`
    ).run();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (2, 504, 1, '2025-01-31', 'exp-y-1')`
    ).run();

    const result = getExpiringOptions(db, 30, undefined, TODAY);
    const underlyings = result.map((r) => r.underlying).sort();
    expect(underlyings).toEqual(["XXX", "YYY"]);
  });
});

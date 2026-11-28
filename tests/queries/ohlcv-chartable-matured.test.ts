import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getChartableSecurities,
  isMaturedSecurity,
} from "@/lib/queries/ohlcv";

/**
 * The Charts picker leaves a matured bond or bill out, as it does an expired
 * option: the broker serves no history for it. On the maturity day itself
 * (Eastern) it is still listed.
 */

const TODAY = "2030-06-15";
let nextConId = 9000;
let db: Database.Database;

function seed(
  symbol: string,
  securityType: string,
  maturityDate: string | null,
): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, currency, ib_con_id, security_type, maturity_date) VALUES (?, ?, 'USD', ?, ?, ?)",
    )
    .run(symbol, `${symbol} Test`, nextConId++, securityType, maturityDate)
    .lastInsertRowid as number;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getChartableSecurities with maturity", () => {
  it("leaves out a bill that matured yesterday, keeps today, null and stocks", () => {
    seed("BILLOLD", "Bond", "2030-06-14");
    seed("BILLTODAY", "Bond", "2030-06-15");
    seed("BILLFUTURE", "Bond", "2030-12-31");
    seed("BILLNULL", "Bond", null);
    seed("AAA", "Stock", null);
    const symbols = getChartableSecurities(db, TODAY).map((s) => s.symbol);
    expect(symbols).toEqual(["AAA", "BILLFUTURE", "BILLNULL", "BILLTODAY"]);
  });
});

describe("isMaturedSecurity", () => {
  it("is true only for a maturity date before today", () => {
    const old = seed("BILLOLD", "Bond", "2030-06-14");
    const today = seed("BILLTODAY", "Bond", "2030-06-15");
    const none = seed("ZZZ", "Stock", null);
    expect(isMaturedSecurity(db, old, TODAY)).toBe(true);
    expect(isMaturedSecurity(db, today, TODAY)).toBe(false);
    expect(isMaturedSecurity(db, none, TODAY)).toBe(false);
    expect(isMaturedSecurity(db, 999999, TODAY)).toBe(false);
  });
});

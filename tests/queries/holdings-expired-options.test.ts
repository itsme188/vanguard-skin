import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { getAllHoldings, getHoldingsByAccount } from "@/lib/queries/holdings";

// Regression pin: the Today IBKR day line (lib/queries/today-holdings.ts)
// drops options past their ET expiration date via the shared
// liveOptionExpirationSql helper (lib/compute/option-expiry.ts), but
// getAllHoldings/getHoldingsByAccount (this file) carried only the bond
// maturity_date guard — nothing for expiration_date — so the Accounts page
// All-Holdings table and per-account holdings table disagreed with Today by
// exactly the expired contract. Dates are derived from todayET() (never a
// hardcoded calendar date) so this pin never goes wall-clock stale.

let db: Database.Database;
const ACCOUNT_ID = 1;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedStock(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class) VALUES (?, ?, 'Stock', 'equity')",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedOption(
  symbol: string,
  underlying: string,
  expirationDate: string,
): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, underlying_symbol, option_type, strike_price, multiplier, currency, expiration_date)
       VALUES (?, ?, 'Option', 'option', ?, 'PUT', 100, 100, 'USD', ?)`,
    )
    .run(symbol, `${symbol} opt`, underlying, expirationDate).lastInsertRowid as number;
}

function seedHolding(
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, securityId, quantity, asOfDate, `hold-${accountId}-${securityId}-${asOfDate}`);
}

function seedPrice(securityId: number, date: string, close: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)",
  ).run(securityId, date, close);
}

describe("expired-option guard parity (getAllHoldings / getHoldingsByAccount)", () => {
  it("getAllHoldings drops an option expired yesterday, keeps one expiring today and a non-option row", () => {
    const today = todayET();
    const yesterday = addDays(today, -1);
    const asOf = "2026-07-30";

    const vti = seedStock("VTI");
    const expired = seedOption("EXP   270101P00100000", "EXP", yesterday);
    const liveToday = seedOption("LIV   270101P00100000", "LIV", today);
    seedHolding(ACCOUNT_ID, vti, 10, asOf);
    seedHolding(ACCOUNT_ID, expired, 2, asOf);
    seedHolding(ACCOUNT_ID, liveToday, 3, asOf);
    seedPrice(vti, asOf, 250);
    seedPrice(expired, asOf, 5);
    seedPrice(liveToday, asOf, 8);

    const holdings = getAllHoldings(db);
    const symbols = holdings.map((h) => h.symbol).sort();
    expect(symbols).toEqual(["LIV   270101P00100000", "VTI"]);
    expect(symbols).not.toContain("EXP   270101P00100000");
  });

  it("getHoldingsByAccount (default, no asOfDate) drops an option expired yesterday, keeps one expiring today and a non-option row", () => {
    const today = todayET();
    const yesterday = addDays(today, -1);
    const asOf = "2026-07-30";

    const vti = seedStock("VTI");
    const expired = seedOption("EXP   270101P00100000", "EXP", yesterday);
    const liveToday = seedOption("LIV   270101P00100000", "LIV", today);
    seedHolding(ACCOUNT_ID, vti, 10, asOf);
    seedHolding(ACCOUNT_ID, expired, 2, asOf);
    seedHolding(ACCOUNT_ID, liveToday, 3, asOf);

    const holdings = getHoldingsByAccount(db, ACCOUNT_ID);
    const symbols = holdings.map((h) => h.symbol).sort();
    expect(symbols).toEqual(["LIV   270101P00100000", "VTI"]);
    expect(symbols).not.toContain("EXP   270101P00100000");
  });

  it("getHoldingsByAccount keeps the expired option in an explicit point-in-time snapshot (parity with the matured-bond branch)", () => {
    const today = todayET();
    const yesterday = addDays(today, -1);
    const asOf = "2026-07-30";

    const vti = seedStock("VTI");
    const expired = seedOption("EXP   270101P00100000", "EXP", yesterday);
    seedHolding(ACCOUNT_ID, vti, 10, asOf);
    seedHolding(ACCOUNT_ID, expired, 2, asOf);

    const snapshot = getHoldingsByAccount(db, ACCOUNT_ID, asOf);
    const symbols = snapshot.map((h) => h.symbol).sort();
    expect(symbols).toEqual(["EXP   270101P00100000", "VTI"]);
  });

  it("does not affect a non-option row with no expiration_date", () => {
    const asOf = "2026-07-30";
    const vti = seedStock("VTI");
    seedHolding(ACCOUNT_ID, vti, 10, asOf);
    seedPrice(vti, asOf, 250);

    expect(getAllHoldings(db).map((h) => h.symbol)).toEqual(["VTI"]);
    expect(getHoldingsByAccount(db, ACCOUNT_ID).map((h) => h.symbol)).toEqual(["VTI"]);
  });
});

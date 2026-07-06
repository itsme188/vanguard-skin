import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getActiveWatchlistStockSymbols } from "@/lib/queries/watchlist";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string, type = "stock"): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class) VALUES (?, ?, ?, 'equity')",
    )
    .run(symbol, `${symbol} Corp`, type).lastInsertRowid as number;
}

function seedWatchlist(securityId: number, active = 1): void {
  db.prepare(
    "INSERT INTO watchlist (security_id, is_active) VALUES (?, ?)",
  ).run(securityId, active);
}

describe("getActiveWatchlistStockSymbols", () => {
  it("returns active watchlist stock symbols, uppercased", () => {
    const shop = seedSecurity("shop");
    seedWatchlist(shop);
    expect(getActiveWatchlistStockSymbols(db)).toEqual(["SHOP"]);
  });

  it("excludes deactivated watchlist rows", () => {
    const shop = seedSecurity("SHOP");
    seedWatchlist(shop, 0);
    expect(getActiveWatchlistStockSymbols(db)).toEqual([]);
  });

  it("excludes non-stock security types (ETFs, options, bonds)", () => {
    const etf = seedSecurity("VOO", "ETF");
    const opt = seedSecurity("TER   270115C00120000", "Option");
    seedWatchlist(etf);
    seedWatchlist(opt);
    expect(getActiveWatchlistStockSymbols(db)).toEqual([]);
  });

  it("returns empty array when watchlist is empty", () => {
    expect(getActiveWatchlistStockSymbols(db)).toEqual([]);
  });
});

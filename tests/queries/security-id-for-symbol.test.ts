import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getSecurityIdForSymbol } from "@/lib/queries/briefing-symbols";

let db: Database.Database;
function seed(symbol: string, type: string): number {
  return Number(
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)").run(symbol, symbol, type)
      .lastInsertRowid,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getSecurityIdForSymbol", () => {
  it("resolves stocks and ETFs, case-insensitively", () => {
    const stock = seed("ZZSTK", "Stock");
    const etf = seed("ZZETF", "ETF");
    expect(getSecurityIdForSymbol(db, "ZZSTK")).toBe(stock);
    expect(getSecurityIdForSymbol(db, "zzetf")).toBe(etf);
  });
  it("never matches an option row", () => {
    seed("ZZOPT", "Option");
    expect(getSecurityIdForSymbol(db, "ZZOPT")).toBeNull();
  });
  it("prefers the stock row over a case-variant ETF row, regardless of id order", () => {
    seed("zzdup", "ETF");
    const stock = seed("ZZDUP", "Common Stock");
    expect(getSecurityIdForSymbol(db, "ZZDUP")).toBe(stock);
  });
});

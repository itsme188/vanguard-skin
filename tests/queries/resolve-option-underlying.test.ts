import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { resolveOptionUnderlying } from "@/lib/queries/securities";

describe("resolveOptionUnderlying", () => {
  let db: Database.Database;
  const ins = (symbol: string, type: string, underlying: string | null) =>
    Number(
      db
        .prepare("INSERT INTO securities (symbol, name, security_type, underlying_symbol) VALUES (?, ?, ?, ?)")
        .run(symbol, symbol, type, underlying).lastInsertRowid,
    );

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("resolves the option's underlying stock row", () => {
    const stock = ins("ZZZ", "Stock", null);
    const opt = ins("ZZZ  261218C00100000", "Option", "ZZZ");
    expect(resolveOptionUnderlying(db, opt)).toEqual({ id: stock, symbol: "ZZZ" });
  });

  it("returns null when the underlying has no row in the book", () => {
    const opt = ins("QQQ  261218C00100000", "Option", "QQQ");
    expect(resolveOptionUnderlying(db, opt)).toBeNull();
  });

  it("returns null for a non-option and ignores option rows as underlyings", () => {
    const stock = ins("ZZZ", "Stock", null);
    expect(resolveOptionUnderlying(db, stock)).toBeNull();
    const opt = ins("YYY  261218C00100000", "Option", "YYY");
    ins("YYY", "option", null);
    expect(resolveOptionUnderlying(db, opt)).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  getHeldSymbolSet,
  mentionsHeldSymbol,
} from "@/lib/research/held-symbol-relevance";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE securities (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, name TEXT, security_type TEXT);
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, security_id INTEGER NOT NULL,
      quantity REAL NOT NULL, as_of_date TEXT NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO securities (id, symbol) VALUES (1,'AAA'),(2,'BBB'),(3,'GOOGL'),(4,'CCC');
    INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES
      (1,1,10,'2026-09-01'),
      (1,2,10,'2026-08-01'),(1,2,0,'2026-09-01'),
      (1,3,5,'2026-09-01');
  `);
  return db;
}

describe("held-symbol-relevance", () => {
  it("getHeldSymbolSet returns uppercase held symbols and drops closed positions", () => {
    const held = getHeldSymbolSet(makeDb());
    expect(held.has("AAA")).toBe(true);
    expect(held.has("BBB")).toBe(false); // zero-quantity tombstone supersedes
    expect(held.has("CCC")).toBe(false);
  });

  it("mentionsHeldSymbol is case-insensitive", () => {
    const held = getHeldSymbolSet(makeDb());
    expect(mentionsHeldSymbol(["aaa"], held)).toBe(true);
    expect(mentionsHeldSymbol(["ZZZ", "BBB"], held)).toBe(false);
    expect(mentionsHeldSymbol([], held)).toBe(false);
  });

  it("is share-class aware: holding GOOGL covers GOOG", () => {
    const held = getHeldSymbolSet(makeDb());
    expect(mentionsHeldSymbol(["GOOG"], held)).toBe(true);
  });
});

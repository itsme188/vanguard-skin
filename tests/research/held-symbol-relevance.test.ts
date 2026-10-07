import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  getHeldSymbolSet,
  mentionsHeldSymbol,
} from "@/lib/research/held-symbol-relevance";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE securities (
      id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, name TEXT, security_type TEXT,
      underlying_symbol TEXT, expiration_date TEXT
    );
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

  // Decided 2026-10-07: the guard also protects short positions and the
  // underlyings of held live options. Synthetic tickers, invented quantities.
  describe("short positions and option underlyings", () => {
    const TODAY = "2026-09-10";

    function seed(db: Database.Database) {
      db.exec(`
        INSERT INTO securities (id, symbol, security_type, underlying_symbol, expiration_date) VALUES
          (10,'SSS','Stock',NULL,NULL),
          (11,'TTT','Stock',NULL,NULL),
          (20,'UUU   261218C00050000','Option','UUU','2026-12-18'),
          (21,'VVV   261218P00050000','option',' vvv ','2026-12-18'),
          (22,'WWW   260905C00050000','Option','WWW','2026-09-05'),
          (23,'XXX   20260905C','Option','XXX','20260905'),
          (24,'YYY   260910C00050000','Option','YYY','2026-09-10'),
          (25,'QQQQ  261218C00050000','Option','QQQQ','2026-12-18'),
          (26,'GOOG  261218C00050000','Option','GOOG','2026-12-18'),
          (27,'NNN   261218C00050000','Option',NULL,'2026-12-18'),
          (28,'MMM 261218 P 50.00','Option','','2026-12-18'),
          (29,'LLL-NOT-A-CONTRACT','Option',NULL,'2026-12-18'),
          (30,'KKK   260905C00050000','Option',NULL,'2026-09-05');
        INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES
          (1,10,-25,'2026-09-01'),
          (1,11,-25,'2026-08-01'),(1,11,0,'2026-09-01'),
          (2,20,2,'2026-09-01'),
          (2,21,-3,'2026-09-01'),
          (2,22,1,'2026-09-01'),
          (2,23,1,'2026-09-01'),
          (2,24,1,'2026-09-01'),
          (2,25,1,'2026-08-01'),(2,25,0,'2026-09-01'),
          (2,26,1,'2026-09-01'),
          (2,27,1,'2026-09-01'),
          (2,28,-1,'2026-09-01'),
          (2,29,1,'2026-09-01'),
          (2,30,1,'2026-09-01');
      `);
    }

    it("a short stock position is held; a covered short is not", () => {
      const db = makeDb();
      seed(db);
      const held = getHeldSymbolSet(db, TODAY);
      expect(mentionsHeldSymbol(["SSS"], held)).toBe(true);
      expect(mentionsHeldSymbol(["TTT"], held)).toBe(false); // zero-quantity tombstone
    });

    it("the underlying of a held live option is held, long or short, whatever the stored case", () => {
      const db = makeDb();
      seed(db);
      const held = getHeldSymbolSet(db, TODAY);
      expect(mentionsHeldSymbol(["UUU"], held)).toBe(true); // long call
      expect(mentionsHeldSymbol(["VVV"], held)).toBe(true); // short put, padded lower-case underlying
      expect(held.has("UUU   261218C00050000")).toBe(false); // the contract symbol is not a name
    });

    it("an expired option does not protect its underlying; one expiring today still does", () => {
      const db = makeDb();
      seed(db);
      const held = getHeldSymbolSet(db, TODAY);
      expect(mentionsHeldSymbol(["WWW"], held)).toBe(false); // expired, dashed date
      expect(mentionsHeldSymbol(["XXX"], held)).toBe(false); // expired, legacy compact date
      expect(mentionsHeldSymbol(["YYY"], held)).toBe(true); // expires today: live through the day
    });

    it("a closed option position does not protect its underlying", () => {
      const db = makeDb();
      seed(db);
      expect(mentionsHeldSymbol(["QQQQ"], getHeldSymbolSet(db, TODAY))).toBe(false);
    });

    it("option-only exposure is share-class aware: an option on GOOG covers GOOGL", () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE securities (
          id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, name TEXT, security_type TEXT,
          underlying_symbol TEXT, expiration_date TEXT
        );
        CREATE TABLE holdings (
          id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, security_id INTEGER NOT NULL,
          quantity REAL NOT NULL, as_of_date TEXT NOT NULL
        );
        INSERT INTO securities (id, symbol, security_type, underlying_symbol, expiration_date)
          VALUES (1,'GOOG  261218C00050000','Option','GOOG','2026-12-18');
        INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (1,1,1,'2026-09-01');
      `);
      expect(mentionsHeldSymbol(["GOOGL"], getHeldSymbolSet(db, TODAY))).toBe(true);
    });

    // Changed 2026-10-07 (review fix): option rows whose underlying_symbol is
    // NULL exist (the ticker lives only in the contract symbol), so the
    // underlying is parsed back out of the symbol instead of being dropped.
    it("an option row with no stored underlying contributes the underlying parsed from its symbol", () => {
      const db = makeDb();
      seed(db);
      const held = getHeldSymbolSet(db, TODAY);
      expect(held.has("")).toBe(false);
      expect(mentionsHeldSymbol(["NNN"], held)).toBe(true); // OCC spelling, NULL underlying
      expect(mentionsHeldSymbol(["MMM"], held)).toBe(true); // compact spelling, blank underlying
      expect(held.has("NNN   261218C00050000")).toBe(false); // the contract symbol is not a name
    });

    it("a malformed option symbol with no stored underlying adds nothing and does not throw", () => {
      const db = makeDb();
      seed(db);
      let held = new Set<string>();
      expect(() => {
        held = getHeldSymbolSet(db, TODAY);
      }).not.toThrow();
      expect(mentionsHeldSymbol(["LLL"], held)).toBe(false);
      expect(held.has("LLL-NOT-A-CONTRACT")).toBe(false);
    });

    it("an expired option with no stored underlying still does not protect its underlying", () => {
      const db = makeDb();
      seed(db);
      expect(mentionsHeldSymbol(["KKK"], getHeldSymbolSet(db, TODAY))).toBe(false);
    });
  });
});

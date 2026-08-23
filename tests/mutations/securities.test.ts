import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";

describe("upsertSecurity", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("inserts new security and returns id", () => {
    const id = upsertSecurity(db, "VTI", "Vanguard Total Market", "etf", "US Equity");
    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare("SELECT * FROM securities WHERE id = ?")
      .get(id) as any;
    expect(row.symbol).toBe("VTI");
    expect(row.name).toBe("Vanguard Total Market");
    expect(row.security_type).toBe("ETF");
    expect(row.asset_class).toBe("US Equity");
  });

  it("returns existing id for duplicate symbol", () => {
    const id1 = upsertSecurity(db, "VTI", "Vanguard Total Market");
    const id2 = upsertSecurity(db, "VTI", "Vanguard Total Market");
    expect(id1).toBe(id2);

    // Should only have one row
    const count = (
      db.prepare("SELECT COUNT(*) as c FROM securities WHERE symbol = 'VTI'").get() as any
    ).c;
    expect(count).toBe(1);
  });

  it("enriches metadata on re-insert (COALESCE behavior)", () => {
    // First insert with just symbol
    const id1 = upsertSecurity(db, "BND");

    const row1 = db
      .prepare("SELECT * FROM securities WHERE id = ?")
      .get(id1) as any;
    expect(row1.name).toBeNull();
    expect(row1.security_type).toBeNull();

    // Second insert adds name and type
    const id2 = upsertSecurity(db, "BND", "Vanguard Total Bond", "bond");
    expect(id2).toBe(id1);

    const row2 = db
      .prepare("SELECT * FROM securities WHERE id = ?")
      .get(id2) as any;
    expect(row2.name).toBe("Vanguard Total Bond");
    expect(row2.security_type).toBe("Bond");
  });

  it("does not overwrite existing metadata with null", () => {
    upsertSecurity(db, "AAPL", "Apple Inc", "stock", "US Equity");
    // Re-insert with only symbol — should NOT clear existing data
    upsertSecurity(db, "AAPL");

    const row = db
      .prepare("SELECT * FROM securities WHERE symbol = 'AAPL'")
      .get() as any;
    expect(row.name).toBe("Apple Inc");
    expect(row.security_type).toBe("Stock");
    expect(row.asset_class).toBe("US Equity");
  });

  it("inserts option security with full metadata via params object", () => {
    const id = upsertSecurity(db, {
      symbol: "AAPL  250321C00150000",
      name: "AAPL 21MAR25 150.0 C",
      securityType: "option",
      underlyingSymbol: "AAPL",
      strikePrice: 150,
      expirationDate: "2025-03-21",
      optionType: "CALL",
      multiplier: 100,
    });
    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare("SELECT * FROM securities WHERE id = ?")
      .get(id) as any;
    expect(row.security_type).toBe("Option");
    expect(row.underlying_symbol).toBe("AAPL");
    expect(row.strike_price).toBe(150);
    expect(row.expiration_date).toBe("2025-03-21");
    expect(row.option_type).toBe("CALL");
    expect(row.multiplier).toBe(100);
  });

  it("preserves option metadata on re-insert with null", () => {
    upsertSecurity(db, {
      symbol: "AAPL  250321C00150000",
      securityType: "option",
      underlyingSymbol: "AAPL",
      strikePrice: 150,
      expirationDate: "2025-03-21",
      optionType: "CALL",
      multiplier: 100,
    });

    // Re-insert with just the symbol — option metadata should be preserved
    upsertSecurity(db, "AAPL  250321C00150000");

    const row = db
      .prepare("SELECT * FROM securities WHERE symbol = 'AAPL  250321C00150000'")
      .get() as any;
    expect(row.underlying_symbol).toBe("AAPL");
    expect(row.strike_price).toBe(150);
    expect(row.option_type).toBe("CALL");
    expect(row.multiplier).toBe(100);
  });

  it("stores null multiplier for non-option securities (queries use COALESCE)", () => {
    const id = upsertSecurity(db, "VTI", "Vanguard Total Market", "etf");
    const row = db
      .prepare("SELECT * FROM securities WHERE id = ?")
      .get(id) as any;
    // multiplier is NULL in DB; all queries use COALESCE(s.multiplier, 1)
    expect(row.multiplier).toBeNull();
  });

  it("prevents option metadata from clobbering stock security (type conflict guard)", () => {
    // First: create INTC as a stock
    const stockId = upsertSecurity(db, "INTC", "Intel Corp", "stock");
    expect(stockId).toBeGreaterThan(0);

    // Simulate what happened: an option import tries to overwrite with bare ticker
    const resultId = upsertSecurity(db, {
      symbol: "INTC",
      name: "PUT INTEL CORP $45 EXP 03/20/26",
      securityType: "option",
      underlyingSymbol: "INTC",
      strikePrice: 45,
      expirationDate: "2026-03-20",
      optionType: "PUT",
      multiplier: 100,
    });

    // Should return the SAME id (existing stock)
    expect(resultId).toBe(stockId);

    // Security should STILL be a stock — option metadata was rejected
    const row = db
      .prepare("SELECT * FROM securities WHERE id = ?")
      .get(stockId) as any;
    expect(row.security_type).toBe("Stock");
    expect(row.multiplier).toBeNull();
    expect(row.option_type).toBeNull();
    expect(row.name).toBe("Intel Corp"); // Name preserved
  });

  it("prevents stock from clobbering an option security (reverse direction)", () => {
    // Create option first
    const optionId = upsertSecurity(db, {
      symbol: "INTC  260320P00045000",
      name: "PUT INTEL CORP $45 EXP 03/20/26",
      securityType: "option",
      multiplier: 100,
      optionType: "PUT",
    });

    // Try to overwrite with stock type
    const resultId = upsertSecurity(db, "INTC  260320P00045000", "Intel Corp", "stock");

    expect(resultId).toBe(optionId);

    // Should still be option
    const row = db
      .prepare("SELECT * FROM securities WHERE id = ?")
      .get(optionId) as any;
    expect(row.security_type).toBe("Option");
    expect(row.multiplier).toBe(100);
  });

  it("defaults option multiplier to 100 when not supplied (canonical CSV path)", () => {
    // Canonical CSV has no multiplier column, so the parser supplies none.
    const id = upsertSecurity(db, {
      symbol: "AFRM  270115C00115000",
      name: "Call Affirm Holdings Cl A Exp 01/15/27",
      securityType: "option",
      optionType: "CALL",
      strikePrice: 115,
      expirationDate: "2027-01-15",
    });
    const row = db.prepare("SELECT multiplier FROM securities WHERE id = ?").get(id) as any;
    expect(row.multiplier).toBe(100);
  });

  it("corrects a bogus option multiplier <= 1 to 100", () => {
    const id = upsertSecurity(db, {
      symbol: "TER   280121C00180000",
      name: "Call Teradyne Inc Exp 01/21/28",
      securityType: "option",
      multiplier: 1,
    });
    const row = db.prepare("SELECT multiplier FROM securities WHERE id = ?").get(id) as any;
    expect(row.multiplier).toBe(100);
  });

  it("preserves an explicitly supplied non-standard option multiplier (> 1)", () => {
    // Adjusted options can carry a real non-100 multiplier — don't clobber it.
    const id = upsertSecurity(db, {
      symbol: "XYZ   270115C00050000",
      name: "Adjusted option",
      securityType: "option",
      multiplier: 50,
    });
    const row = db.prepare("SELECT multiplier FROM securities WHERE id = ?").get(id) as any;
    expect(row.multiplier).toBe(50);
  });

  it("does not assign a multiplier to non-options", () => {
    const id = upsertSecurity(db, "VTI", "Vanguard Total Market", "etf");
    const row = db.prepare("SELECT multiplier FROM securities WHERE id = ?").get(id) as any;
    expect(row.multiplier).toBeNull();
  });

  it("defaults currency to 'USD' when not provided", () => {
    const id = upsertSecurity(db, "VTI", "Vanguard Total Market", "etf");
    const row = db.prepare("SELECT currency FROM securities WHERE id = ?").get(id) as any;
    expect(row.currency).toBe("USD");
  });

  it("persists an explicit non-USD currency", () => {
    const id = upsertSecurity(db, {
      symbol: "402340",
      name: "SK Hynix",
      securityType: "stock",
      currency: "KRW",
    });
    const row = db.prepare("SELECT currency FROM securities WHERE id = ?").get(id) as any;
    expect(row.currency).toBe("KRW");
  });

  it("does not clobber a stored non-USD currency with a later default-USD upsert", () => {
    const id1 = upsertSecurity(db, { symbol: "402340", securityType: "stock", currency: "KRW" });
    // A later writer (e.g. plain TWS enrichment) that doesn't know the currency
    // re-upserts without one — must not reset the stored KRW back to USD.
    const id2 = upsertSecurity(db, { symbol: "402340", name: "SK Hynix" });
    expect(id2).toBe(id1);
    const row = db.prepare("SELECT currency FROM securities WHERE id = ?").get(id1) as any;
    expect(row.currency).toBe("KRW");
  });

  it("updates currency when a later upsert supplies a genuine non-USD value", () => {
    const id = upsertSecurity(db, { symbol: "402340", securityType: "stock" }); // defaults USD
    upsertSecurity(db, { symbol: "402340", currency: "KRW" });
    const row = db.prepare("SELECT currency FROM securities WHERE id = ?").get(id) as any;
    expect(row.currency).toBe("KRW");
  });

  // IBKR labels every STK contract 'Stock' — TWS positions and activity
  // imports cannot distinguish ETFs. An incoming 'Stock' must never downgrade
  // a row already classified into a fund-family type (the 2026-08-10 ETF
  // retype repair was silently reverted by the next TWS sync without this).
  describe("weak 'Stock' never downgrades a fund-family type", () => {
    it.each(["etf", "mutual_fund", "bond"])(
      "keeps %s when a TWS-style 'Stock' upsert arrives",
      (fundType) => {
        const id = upsertSecurity(db, "SPY", "SPDR S&P 500", fundType);
        const before = db
          .prepare("SELECT security_type FROM securities WHERE id = ?")
          .get(id) as any;

        upsertSecurity(db, "SPY", null, "stock");

        const after = db
          .prepare("SELECT security_type FROM securities WHERE id = ?")
          .get(id) as any;
        expect(after.security_type).toBe(before.security_type);
      },
    );

    it("still upgrades 'Stock' -> 'ETF' when the specific type arrives", () => {
      const id = upsertSecurity(db, "SOXX", null, "stock");
      upsertSecurity(db, "SOXX", "iShares Semiconductor ETF", "etf");
      const row = db
        .prepare("SELECT security_type FROM securities WHERE id = ?")
        .get(id) as any;
      expect(row.security_type).toBe("ETF");
    });

    it("'Stock' over 'Stock' stays 'Stock' (no behavior change)", () => {
      const id = upsertSecurity(db, "ZS", null, "stock");
      upsertSecurity(db, "ZS", "Zscaler Inc", "stock");
      const row = db
        .prepare("SELECT security_type FROM securities WHERE id = ?")
        .get(id) as any;
      expect(row.security_type).toBe("Stock");
    });
  });

  // qa:security-detail-transactions--same-option-trade-duplicated-across-
  // two-symbol-spellings — the same contract can arrive under multiple
  // human-readable spellings. upsertSecurity now canonicalizes any
  // option-shaped symbol to OCC form BEFORE the lookup, so both spellings
  // resolve to the same row forever after.
  describe("option symbol canonicalization", () => {
    it("canonicalizes a Vanguard-compact human-form symbol to OCC on first insert", () => {
      const id = upsertSecurity(db, {
        symbol: "NVDA 260618 C 175.00",
        name: "CALL NVIDIA CORP $175 EXP 06/18/26",
        securityType: "option",
      });
      const row = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(id) as any;
      expect(row.symbol).toBe("NVDA  260618C00175000");
    });

    it("both spellings of the same contract resolve to the SAME row", () => {
      const id1 = upsertSecurity(db, {
        symbol: "NVDA 260618 C 175.00",
        name: "CALL NVIDIA CORP $175 EXP 06/18/26",
        securityType: "option",
        underlyingSymbol: "NVDA",
        strikePrice: 175,
        expirationDate: "2026-06-18",
        optionType: "CALL",
      });
      const id2 = upsertSecurity(db, {
        symbol: "NVDA  260618C00175000",
        name: "CALL NVIDIA CORP $175 EXP 06/18/26",
        securityType: "option",
        underlyingSymbol: "NVDA",
        strikePrice: 175,
        expirationDate: "2026-06-18",
        optionType: "CALL",
      });

      expect(id2).toBe(id1);
      const count = (
        db.prepare("SELECT COUNT(*) as c FROM securities WHERE underlying_symbol = 'NVDA'").get() as any
      ).c;
      expect(count).toBe(1);
    });

    it("canonicalizes a human-form PUT with a fractional strike", () => {
      const id = upsertSecurity(db, {
        symbol: "APP 250321 P 175.50",
        securityType: "option",
        optionType: "PUT",
      });
      const row = db.prepare("SELECT symbol, option_type FROM securities WHERE id = ?").get(id) as any;
      expect(row.symbol).toBe("APP   250321P00175500");
      expect(row.option_type).toBe("PUT");
    });

    it("does not touch a plain equity symbol", () => {
      const id = upsertSecurity(db, "AAPL", "Apple Inc", "stock");
      const row = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(id) as any;
      expect(row.symbol).toBe("AAPL");
    });

    it("does not touch a bond symbol", () => {
      const id = upsertSecurity(db, "912828YK0", "US Treasury Note", "bond");
      const row = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(id) as any;
      expect(row.symbol).toBe("912828YK0");
    });

    it("leaves an unparseable bare-ticker option symbol unchanged (falls through, never throws) — preserves the type-conflict guard", () => {
      // Same scenario as the existing "prevents option metadata from
      // clobbering stock security" test: an option import supplies a bare
      // ticker with no embedded date/strike. It can't be parsed as an
      // option shape, so it must fall through untouched rather than being
      // built from the separate metadata fields — otherwise this would
      // silently create a NEW row instead of hitting the type-conflict
      // guard against the existing "INTC" stock.
      const stockId = upsertSecurity(db, "INTC", "Intel Corp", "stock");
      const resultId = upsertSecurity(db, {
        symbol: "INTC",
        name: "PUT INTEL CORP $45 EXP 03/20/26",
        securityType: "option",
        underlyingSymbol: "INTC",
        strikePrice: 45,
        expirationDate: "2026-03-20",
        optionType: "PUT",
      });
      expect(resultId).toBe(stockId);
      const row = db.prepare("SELECT security_type, symbol FROM securities WHERE id = ?").get(stockId) as any;
      expect(row.security_type).toBe("Stock");
      expect(row.symbol).toBe("INTC");
    });

    it("is idempotent — re-upserting an already-canonical OCC symbol is a no-op rename", () => {
      const id1 = upsertSecurity(db, {
        symbol: "AMSC  260116C00035000",
        securityType: "option",
      });
      const id2 = upsertSecurity(db, {
        symbol: "AMSC  260116C00035000",
        securityType: "option",
      });
      expect(id2).toBe(id1);
      const row = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(id1) as any;
      expect(row.symbol).toBe("AMSC  260116C00035000");
    });
  });

  // 2026-08-21 audit: a statement transcription put a name-fragment in the
  // symbol column, colliding with a held equity ticker. The incoming Bond
  // type + Treasury name + derived maturity stamped bond identity onto the
  // equity row, sending a live position through the bond ÷100 valuation path.
  // Real bonds are CUSIP-symboled — a ticker with actual equity fills being
  // retyped to Bond/Mutual Fund is effectively always a transcription defect.
  describe("bond-like metadata never lands on an equity-fill security", () => {
    function insertEquityFill(db: Database.Database, securityId: number) {
      // accounts table has no account_type column in this schema
      db.prepare(`INSERT INTO accounts (name) VALUES ('T')`).run();
      db.prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount)
         VALUES (1, ?, '2026-01-05', 'BUY', 100, -1000)`
      ).run(securityId);
    }

    it("refuses Bond type + bond-like name + maturity onto a Stock with equity fills", () => {
      const id = upsertSecurity(db, { symbol: "AAA", name: "EXAMPLE CORP", securityType: "Stock" });
      insertEquityFill(db, id);
      const again = upsertSecurity(db, {
        symbol: "AAA",
        name: "S TREASURY NOTE 0 CPN 9.999% DUE 01/15/40 DTD 01/15/25",
        securityType: "Bond",
      });
      expect(again).toBe(id);
      const row = db
        .prepare(`SELECT name, security_type, maturity_date FROM securities WHERE id = ?`)
        .get(id) as { name: string; security_type: string; maturity_date: string | null };
      expect(row.security_type).toBe("Stock");
      expect(row.name).toBe("EXAMPLE CORP");
      expect(row.maturity_date).toBeNull();
    });

    it("still allows Bond onto a Stock-typed row with NO equity fills (legit CUSIP retype)", () => {
      const id = upsertSecurity(db, { symbol: "999999ZZ9", securityType: "Stock" });
      upsertSecurity(db, { symbol: "999999ZZ9", name: "U S TREASURY BILL DUE 12/15/26", securityType: "Bond" });
      const row = db.prepare(`SELECT security_type FROM securities WHERE id = ?`).get(id) as {
        security_type: string;
      };
      expect(row.security_type).toBe("Bond");
    });

    it("refuses Mutual Fund onto a Stock with equity fills (LP-mistype inlet class)", () => {
      const id = upsertSecurity(db, { symbol: "BBB", name: "EXAMPLE PARTNERS LP", securityType: "Stock" });
      insertEquityFill(db, id);
      upsertSecurity(db, { symbol: "BBB", securityType: "Mutual Fund" });
      const row = db.prepare(`SELECT security_type FROM securities WHERE id = ?`).get(id) as {
        security_type: string;
      };
      expect(row.security_type).toBe("Stock");
    });

    it("other incoming fields still apply when the bond metadata is stripped", () => {
      const id = upsertSecurity(db, { symbol: "AAA", name: "EXAMPLE CORP", securityType: "Stock" });
      insertEquityFill(db, id);
      upsertSecurity(db, {
        symbol: "AAA", securityType: "Bond", name: "S TREASURY NOTE …", currency: "USD", multiplier: 1,
      });
      const row = db.prepare(`SELECT security_type, name FROM securities WHERE id = ?`).get(id) as {
        security_type: string; name: string;
      };
      expect(row.security_type).toBe("Stock");
      expect(row.name).toBe("EXAMPLE CORP");
    });
  });
});

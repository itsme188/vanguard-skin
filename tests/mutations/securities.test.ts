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
});

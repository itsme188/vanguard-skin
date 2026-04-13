import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { resolveDescriptionToSymbol } from "@/lib/import/resolve-description";

describe("resolveDescriptionToSymbol", () => {
  // ── Ticker-style options (no DB needed) ──────────────────────────

  it("resolves ticker + CALL + ISO date + dollar strike", () => {
    const result = resolveDescriptionToSymbol("AAPL CALL 2026-03-20 $150");
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("AAPL  260320C00150000");
    expect(result!.optionType).toBe("CALL");
    expect(result!.strikePrice).toBe(150);
    expect(result!.expirationDate).toBe("2026-03-20");
    expect(result!.underlyingSymbol).toBe("AAPL");
    expect(result!.securityType).toBe("Option");
    expect(result!.multiplier).toBe(100);
  });

  it("resolves ticker + PUT + MM/DD/YY date", () => {
    const result = resolveDescriptionToSymbol("INTC PUT 03/20/26 $45");
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("INTC  260320P00045000");
    expect(result!.optionType).toBe("PUT");
    expect(result!.strikePrice).toBe(45);
    expect(result!.expirationDate).toBe("2026-03-20");
  });

  it("resolves COVERED CALL as CALL", () => {
    const result = resolveDescriptionToSymbol(
      "MSFT COVERED CALL 2026-06-20 $420"
    );
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("MSFT  260620C00420000");
    expect(result!.optionType).toBe("CALL");
  });

  it("resolves fractional strike price", () => {
    const result = resolveDescriptionToSymbol("SPY PUT 2026-01-17 $2.50");
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("SPY   260117P00002500");
    expect(result!.strikePrice).toBe(2.5);
  });

  it("resolves MM/DD/YYYY date format", () => {
    const result = resolveDescriptionToSymbol("META CALL 02/15/2024 $600");
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("META  240215C00600000");
  });

  it("resolves strike without dollar sign", () => {
    const result = resolveDescriptionToSymbol("AAPL PUT 2026-06-19 150");
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe("AAPL  260619P00150000");
  });

  it("is case-insensitive for CALL/PUT", () => {
    const result = resolveDescriptionToSymbol("AAPL call 2026-03-20 $150");
    expect(result).not.toBeNull();
    expect(result!.optionType).toBe("CALL");
  });

  // ── Non-matching descriptions ────────────────────────────────────

  it("returns null for empty string", () => {
    expect(resolveDescriptionToSymbol("")).toBeNull();
  });

  it("returns null for plain stock name", () => {
    expect(resolveDescriptionToSymbol("Apple Inc")).toBeNull();
  });

  it("returns null for bond description", () => {
    expect(
      resolveDescriptionToSymbol("Corporate Bond, Apple Inc 2.5% due 2035")
    ).toBeNull();
  });

  it("returns null for random text", () => {
    expect(resolveDescriptionToSymbol("Some random description")).toBeNull();
  });

  // ── Company-name options (need DB) ───────────────────────────────

  describe("with DB lookup", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(":memory:");
      db.exec(`
        CREATE TABLE securities (
          id INTEGER PRIMARY KEY,
          symbol TEXT NOT NULL UNIQUE,
          name TEXT,
          security_type TEXT DEFAULT 'Stock'
        );
        INSERT INTO securities (symbol, name, security_type)
        VALUES ('INTC', 'Intel Corp', 'Stock');
        INSERT INTO securities (symbol, name, security_type)
        VALUES ('AAPL', 'Apple Inc', 'Stock');
        INSERT INTO securities (symbol, name, security_type)
        VALUES ('LYV', 'Live Nation Entertainment Inc', 'Stock');
      `);
    });

    it("returns null for company name without DB", () => {
      const result = resolveDescriptionToSymbol("INTEL CORP PUT 03/20/26 $45");
      expect(result).toBeNull();
    });

    it("resolves company name to ticker via DB exact match", () => {
      const result = resolveDescriptionToSymbol(
        "Intel Corp PUT 03/20/26 $45",
        db
      );
      expect(result).not.toBeNull();
      expect(result!.symbol).toBe("INTC  260320P00045000");
      expect(result!.underlyingSymbol).toBe("INTC");
    });

    it("resolves company name with suffix stripping via DB", () => {
      const result = resolveDescriptionToSymbol(
        "INTEL CORP PUT 03/20/26 $45",
        db
      );
      expect(result).not.toBeNull();
      expect(result!.symbol).toBe("INTC  260320P00045000");
    });

    it("resolves verbose company name via prefix match", () => {
      const result = resolveDescriptionToSymbol(
        "Live Nation Entertainment Inc CALL 2026-06-20 $120",
        db
      );
      expect(result).not.toBeNull();
      expect(result!.symbol).toBe("LYV   260620C00120000");
    });

    it("returns null for unknown company even with DB", () => {
      const result = resolveDescriptionToSymbol(
        "UNKNOWN COMPANY PUT 03/20/26 $45",
        db
      );
      expect(result).toBeNull();
    });
  });
});

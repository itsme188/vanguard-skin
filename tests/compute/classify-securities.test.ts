import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { classifySecurities } from "@/lib/compute/classify-securities";

let db: Database.Database;

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts: {
    name?: string;
    security_type?: string | null;
    asset_class?: string;
  } = {}
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, ?, ?, 1)"
    )
    .run(symbol, opts.name ?? null, opts.security_type ?? "stock", opts.asset_class ?? null);
  return result.lastInsertRowid as number;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("classifySecurities", () => {
  it("classifies ETFs from static lookup", () => {
    seedSecurity(db, "VTI", { security_type: "etf", name: "VANGUARD TOTAL STOCK MARKET ETF" });
    seedSecurity(db, "SPY", { security_type: "etf", name: "STATE STREET SPDR S&P 500 ETF" });

    const result = classifySecurities(db);
    expect(result.classified).toBe(2);
    expect(result.unresolved.length).toBe(0);

    const vti = db.prepare("SELECT fund_category, geography, market_cap_category, style, classification_source FROM securities WHERE symbol = 'VTI'").get() as Record<string, string>;
    expect(vti.fund_category).toBe("US Total Market Equity");
    expect(vti.geography).toBe("US");
    expect(vti.market_cap_category).toBe("Multi-Cap");
    expect(vti.style).toBe("Blend");
    expect(vti.classification_source).toBe("static_lookup");
  });

  it("classifies individual stocks from static lookup", () => {
    seedSecurity(db, "AAPL", { name: "APPLE INC" });
    seedSecurity(db, "JPM", { name: "JPMORGAN CHASE & CO" });

    const result = classifySecurities(db);
    expect(result.classified).toBe(2);

    const aapl = db.prepare("SELECT fund_category, style FROM securities WHERE symbol = 'AAPL'").get() as Record<string, string>;
    expect(aapl.fund_category).toBe("US Sector Equity (Technology)");
    expect(aapl.style).toBe("Growth");

    const jpm = db.prepare("SELECT fund_category, style FROM securities WHERE symbol = 'JPM'").get() as Record<string, string>;
    expect(jpm.fund_category).toBe("US Sector Equity (Financial)");
    expect(jpm.style).toBe("Value");
  });

  it("fixes money market fund security_type", () => {
    seedSecurity(db, "VMFXX", { security_type: "stock", name: "VANGUARD FEDERAL MONEY MARKET FUND" });

    classifySecurities(db);

    const row = db.prepare("SELECT security_type, fund_category FROM securities WHERE symbol = 'VMFXX'").get() as Record<string, string>;
    expect(row.security_type).toBe("money_market");
    expect(row.fund_category).toBe("Cash Equivalent");
  });

  it("auto-classifies bonds as US Treasury", () => {
    seedSecurity(db, "912797NL7", {
      security_type: "bond",
      name: "U S TREASURY BILL DUE 11/28/25",
    });

    const result = classifySecurities(db);
    expect(result.classified).toBe(1);

    const row = db.prepare("SELECT fund_category, geography, classification_source FROM securities WHERE symbol = '912797NL7'").get() as Record<string, string>;
    expect(row.fund_category).toBe("US Treasury");
    expect(row.geography).toBe("US");
    expect(row.classification_source).toBe("auto");
  });

  it("classifies options by inheriting from underlying", () => {
    seedSecurity(db, "AAPL 12SEP25 235 P", {
      security_type: "Equity and Index Options",
      name: "AAPL 12SEP25 235 P",
    });

    const result = classifySecurities(db);
    expect(result.classified).toBe(1);

    const row = db.prepare("SELECT fund_category, classification_source FROM securities WHERE symbol = 'AAPL 12SEP25 235 P'").get() as Record<string, string>;
    expect(row.fund_category).toBe("US Sector Equity (Technology)");
    expect(row.classification_source).toBe("auto_option");
  });

  it("classifies options on unknown underlyings as generic 'Options'", () => {
    seedSecurity(db, "ZZZY 12SEP25 50 C", {
      security_type: "Equity and Index Options",
      name: "ZZZY 12SEP25 50 C",
    });

    const result = classifySecurities(db);
    expect(result.classified).toBe(1);

    const row = db.prepare("SELECT fund_category FROM securities WHERE symbol = 'ZZZY 12SEP25 50 C'").get() as Record<string, string>;
    expect(row.fund_category).toBe("Options");
  });

  it("auto-classifies forex", () => {
    seedSecurity(db, "EUR.USD", { security_type: "Forex" });

    const result = classifySecurities(db);
    expect(result.classified).toBe(1);

    const row = db.prepare("SELECT fund_category FROM securities WHERE symbol = 'EUR.USD'").get() as Record<string, string>;
    expect(row.fund_category).toBe("Currency");
  });

  it("auto-classifies prediction contracts", () => {
    seedSecurity(db, "PREDICT_YES", {
      security_type: null,
      asset_class: "Forecast Contracts by ForecastEx",
    });

    const result = classifySecurities(db);
    expect(result.classified).toBe(1);

    const row = db.prepare("SELECT fund_category FROM securities WHERE symbol = 'PREDICT_YES'").get() as Record<string, string>;
    expect(row.fund_category).toBe("Prediction Market");
  });

  it("does not overwrite manual classifications", () => {
    seedSecurity(db, "AAPL", { name: "APPLE INC" });
    db.prepare(`
      UPDATE securities SET
        fund_category = 'Custom Category',
        geography = 'Custom Geo',
        classification_source = 'manual'
      WHERE symbol = 'AAPL'
    `).run();

    const result = classifySecurities(db);
    expect(result.skipped).toBe(1);

    const row = db.prepare("SELECT fund_category FROM securities WHERE symbol = 'AAPL'").get() as Record<string, string>;
    expect(row.fund_category).toBe("Custom Category");
  });

  it("does not overwrite TWS classifications", () => {
    seedSecurity(db, "GOOG", { name: "ALPHABET INC" });
    db.prepare(`
      UPDATE securities SET
        fund_category = 'TWS Category',
        classification_source = 'tws'
      WHERE symbol = 'GOOG'
    `).run();

    const result = classifySecurities(db);
    expect(result.skipped).toBe(1);

    const row = db.prepare("SELECT fund_category FROM securities WHERE symbol = 'GOOG'").get() as Record<string, string>;
    expect(row.fund_category).toBe("TWS Category");
  });

  it("is idempotent — second run skips already-classified", () => {
    seedSecurity(db, "VTI", { security_type: "etf" });
    seedSecurity(db, "AAPL");

    const first = classifySecurities(db);
    expect(first.classified).toBe(2);

    const second = classifySecurities(db);
    expect(second.classified).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it("reports unresolved securities", () => {
    seedSecurity(db, "XYZUNKNOWN", { security_type: "stock", name: "Unknown Corp" });

    const result = classifySecurities(db);
    expect(result.unresolved.length).toBe(1);
    expect(result.unresolved[0].symbol).toBe("XYZUNKNOWN");
  });

  it("returns correct totals", () => {
    seedSecurity(db, "VTI", { security_type: "etf" });
    seedSecurity(db, "912797NL7", { security_type: "bond" });
    seedSecurity(db, "EUR.USD", { security_type: "Forex" });
    seedSecurity(db, "XYZUNKNOWN", { security_type: "stock" });

    const result = classifySecurities(db);
    expect(result.total).toBe(4);
    expect(result.classified).toBe(3);
    expect(result.unresolved.length).toBe(1);
  });
});

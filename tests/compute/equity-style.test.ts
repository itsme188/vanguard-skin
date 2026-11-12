// tests/compute/equity-style.test.ts
//
// A bond, a cash fund or a bond fund carries no growth-or-value style
// (owner decision 2026-11-01). One rule, `carriesEquityStyle`, decides it for
// every Growth vs Value reader and for the classifier's write.
import { describe, it, expect } from "vitest";
import {
  carriesEquityStyle,
  equityGrowthValue,
  growthValueBucket,
  styleIdentityOf,
} from "@/lib/compute/equity-style";
import { NOT_EQUITY_STYLE_LABEL } from "@/lib/factors";

const sec = (
  security_type: string | null,
  fund_category: string | null = null,
  sector: string | null = null,
) => ({ security_type, fund_category, sector });

describe("carriesEquityStyle", () => {
  it("is false for a bond, whatever the casing", () => {
    expect(carriesEquityStyle(sec("Bond"))).toBe(false);
    expect(carriesEquityStyle(sec(" bond "))).toBe(false);
    expect(carriesEquityStyle(sec("BOND"))).toBe(false);
  });

  it("is false for a cash equivalent (by type or by category)", () => {
    expect(carriesEquityStyle(sec("Money Market"))).toBe(false);
    expect(carriesEquityStyle(sec("Mutual Fund", "Cash Equivalent"))).toBe(false);
    expect(carriesEquityStyle(sec("Stock", "Money Market"))).toBe(false);
  });

  it("is false for a fixed-income fund (bond category or Fixed Income sector)", () => {
    expect(carriesEquityStyle(sec("Mutual Fund", "US Mortgage-Backed Securities"))).toBe(false);
    expect(carriesEquityStyle(sec("ETF", null, "Fixed Income"))).toBe(false);
  });

  it("is true for a stock, an equity fund, and a leveraged or inverse bond fund", () => {
    expect(carriesEquityStyle(sec("Stock", null, "Technology"))).toBe(true);
    expect(carriesEquityStyle(sec("ETF", "US Large Cap Equity"))).toBe(true);
    expect(carriesEquityStyle(sec(null))).toBe(true);
    // isFixedIncomeFund leaves leveraged/inverse funds out; they keep a style.
    expect(carriesEquityStyle(sec("ETF", "Leveraged/Inverse", "Fixed Income"))).toBe(true);
  });

  it("does not treat a stock with a Fixed Income sector as a bond fund", () => {
    expect(carriesEquityStyle(sec("Stock", null, "Fixed Income"))).toBe(true);
  });
});

describe("styleIdentityOf (options are judged by their underlying)", () => {
  it("uses the underlying row for an option when it is at hand", () => {
    const opt = sec("Option");
    const und = sec("ETF", "US Long-Term Treasury");
    expect(styleIdentityOf(opt, und)).toBe(und);
    expect(carriesEquityStyle(styleIdentityOf(opt, und))).toBe(false);
  });

  it("keeps the option's own row when there is no underlying row", () => {
    const opt = sec("Option");
    expect(styleIdentityOf(opt, null)).toBe(opt);
    expect(carriesEquityStyle(styleIdentityOf(opt, null))).toBe(true);
  });

  it("ignores an underlying row for a non-option", () => {
    const own = sec("Stock");
    expect(styleIdentityOf(own, sec("Bond"))).toBe(own);
  });
});

describe("equityGrowthValue / growthValueBucket", () => {
  it("drops a stored style for a security the rule excludes", () => {
    expect(equityGrowthValue("Value", sec("Bond"))).toBeNull();
    expect(growthValueBucket("Value", sec("Bond"))).toBe(NOT_EQUITY_STYLE_LABEL);
    expect(growthValueBucket(null, sec("Mutual Fund", "Cash Equivalent"))).toBe("Not equity");
  });

  it("keeps the stored style (or Unknown) for an equity", () => {
    expect(equityGrowthValue("Growth", sec("Stock"))).toBe("Growth");
    expect(growthValueBucket("Value", sec("Stock"))).toBe("Value");
    expect(growthValueBucket(null, sec("Stock"))).toBe("Unknown");
  });

  it("judges an option by its underlying", () => {
    expect(equityGrowthValue("Value", sec("Option"), sec("ETF", "US Ultra-Short Bond"))).toBeNull();
    expect(equityGrowthValue("Growth", sec("Option"), sec("Stock"))).toBe("Growth");
    expect(equityGrowthValue("Growth", sec("Option"), null)).toBe("Growth");
  });
});

// ─── Hub factor profile (getFactorsForSecurity) ──────────────────────────────
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getFactorsForSecurity } from "@/lib/queries/security-detail";

describe("getFactorsForSecurity reports no growth/value for a non-equity", () => {
  function makeDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    return db;
  }
  function addSec(db: Database.Database, symbol: string, type: string, category: string | null, gv: string | null, underlying?: string) {
    const id = Number(
      db.prepare("INSERT INTO securities (symbol, security_type, fund_category, underlying_symbol) VALUES (?, ?, ?, ?)")
        .run(symbol, type, category, underlying ?? null).lastInsertRowid,
    );
    if (gv !== null) {
      db.prepare("INSERT INTO security_factors (security_id, growth_vs_value, interest_rate_sensitive, factor_source) VALUES (?, ?, 'High', 'auto_default')")
        .run(id, gv);
    }
    return id;
  }

  it("nulls growth/value for a bond and a cash fund, keeps the other factors", () => {
    const db = makeDb();
    const bond = addSec(db, "ZZB", "Bond", null, "Value");
    const cash = addSec(db, "ZZM", "Mutual Fund", "Cash Equivalent", "Value");
    for (const id of [bond, cash]) {
      const f = getFactorsForSecurity(db, id)!;
      expect(f.growth_vs_value).toBeNull();
      expect(f.interest_rate_sensitive).toBe("High");
    }
  });

  it("keeps the stored style for an equity and judges an option by its underlying", () => {
    const db = makeDb();
    const eq = addSec(db, "AAA", "Stock", null, "Growth");
    expect(getFactorsForSecurity(db, eq)!.growth_vs_value).toBe("Growth");
    addSec(db, "ZZF", "ETF", "US Aggregate Bond", "Value");
    const opt = addSec(db, "ZZF 261218C00100000", "Option", null, null, "ZZF");
    expect(getFactorsForSecurity(db, opt)!.growth_vs_value).toBeNull();
  });
});

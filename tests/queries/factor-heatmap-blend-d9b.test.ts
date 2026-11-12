import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getFactorHeatmap } from "@/lib/queries/analysis";
import { growthValueCellValue } from "@/app/dashboard/components/FactorHeatmap";

let db: Database.Database;

function seed(symbol: string, style: string | null, gv: string | null, underlying?: string) {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES ('T')").run();
  const acct = (db.prepare("SELECT id FROM accounts WHERE name='T'").get() as { id: number }).id;
  const sid = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, style, underlying_symbol, multiplier) VALUES (?, ?, ?, ?, ?, 1)"
    )
    .run(symbol, symbol, underlying ? "Option" : "Stock", style, underlying ?? null)
    .lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, 10, 1000, '2026-03-01')"
  ).run(acct, sid);
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 100, '2026-03-01', 'test')"
  ).run(sid);
  db.prepare(
    "INSERT INTO security_factors (security_id, growth_vs_value, cyclical, factor_source) VALUES (?, ?, 'Low', 'csv_import')"
  ).run(sid, gv);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getFactorHeatmap style (D9b)", () => {
  it("carries the classification style and leaves growth_vs_value untouched", () => {
    seed("ZZA", "Blend", "Value");
    seed("ZZB", "Growth", "Growth");
    seed("ZZC", "null", "Value");
    const rows = getFactorHeatmap(db);
    const a = rows.find((r) => r.symbol === "ZZA")!;
    expect(a.style).toBe("Blend");
    expect(a.growth_vs_value).toBe("Value");
    expect(rows.find((r) => r.symbol === "ZZB")!.style).toBe("Growth");
    expect(rows.find((r) => r.symbol === "ZZC")!.style).toBeNull();
  });

  it("an option inherits its underlying's style", () => {
    seed("ZZA", "Blend", "Value");
    seed("ZZA 261106C00100000", null, null, "ZZA");
    const opt = getFactorHeatmap(db).find((r) => r.is_option)!;
    expect(opt.style).toBe("Blend");
  });
});

describe("growthValueCellValue (D9b)", () => {
  it("shows Blend for a Blend-style row regardless of the stored factor", () => {
    expect(growthValueCellValue({ style: "Blend", growth_vs_value: "Value" })).toBe("Blend");
    expect(growthValueCellValue({ style: "blend", growth_vs_value: null })).toBe("Blend");
  });
  it("keeps Growth and Value names as stored", () => {
    expect(growthValueCellValue({ style: "Growth", growth_vs_value: "Growth" })).toBe("Growth");
    expect(growthValueCellValue({ style: null, growth_vs_value: "Value" })).toBe("Value");
    expect(growthValueCellValue({ style: null, growth_vs_value: null })).toBeNull();
  });
});

// ─── Non-equity securities carry no growth-or-value style (2026-11-12) ──────
// A bond, a cash fund or a bond fund stored as 'Value' (the classifier's old
// default) reports no growth/value and sits in the 'Not equity' bucket.
import { getAllocationByDimension } from "@/lib/queries/analysis";
import { getHoldingsInBucket } from "@/lib/queries/drill-down";

function seedTyped(
  symbol: string,
  type: string,
  gv: string | null,
  opts: { category?: string | null; sector?: string | null; underlying?: string } = {},
) {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES ('T')").run();
  const acct = (db.prepare("SELECT id FROM accounts WHERE name='T'").get() as { id: number }).id;
  const sid = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, fund_category, sector, underlying_symbol, multiplier) VALUES (?, ?, ?, ?, ?, ?, 1)"
    )
    .run(symbol, symbol, type, opts.category ?? null, opts.sector ?? null, opts.underlying ?? null)
    .lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, 10, 1000, '2026-03-01')"
  ).run(acct, sid);
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 100, '2026-03-01', 'test')"
  ).run(sid);
  if (gv !== undefined) {
    db.prepare(
      "INSERT INTO security_factors (security_id, growth_vs_value, interest_rate_sensitive, factor_source) VALUES (?, ?, 'High', 'auto_default')"
    ).run(sid, gv);
  }
}

function seedNonEquityBook() {
  seedTyped("AAA", "Stock", "Value", { sector: "Energy" });
  seedTyped("BBB", "Stock", "Growth", { sector: "Technology" });
  seedTyped("ZZB", "Bond", "Value");
  seedTyped("ZZM", "Mutual Fund", "Value", { category: "Cash Equivalent" });
  seedTyped("ZZF", "Mutual Fund", "Value", { category: "US Mortgage-Backed Securities" });
}

describe("non-equity securities in the Growth vs Value readers", () => {
  it("the heatmap reports no growth/value for a bond, a cash fund and a bond fund", () => {
    seedNonEquityBook();
    const rows = getFactorHeatmap(db);
    for (const sym of ["ZZB", "ZZM", "ZZF"]) {
      const r = rows.find((x) => x.symbol === sym)!;
      expect(r.growth_vs_value).toBeNull();
      expect(r.not_equity).toBe(true);
      expect(r.interest_rate_sensitive).toBe("High");
    }
    const a = rows.find((x) => x.symbol === "AAA")!;
    expect(a.growth_vs_value).toBe("Value");
    expect(a.not_equity).toBe(false);
  });

  it("an option on a bond fund is judged by its underlying", () => {
    seedTyped("ZZF", "ETF", "Value", { category: "US Long-Term Treasury" });
    seedTyped("ZZF 261218C00100000", "Option", null, { underlying: "ZZF" });
    const opt = getFactorHeatmap(db).find((r) => r.is_option)!;
    expect(opt.growth_vs_value).toBeNull();
    expect(opt.not_equity).toBe(true);
  });

  it("the heatmap cell reads 'Not equity' for such a row", () => {
    expect(growthValueCellValue({ style: null, growth_vs_value: null, not_equity: true })).toBe("Not equity");
    expect(growthValueCellValue({ style: "Blend", growth_vs_value: null, not_equity: true })).toBe("Not equity");
    expect(growthValueCellValue({ style: null, growth_vs_value: "Value", not_equity: false })).toBe("Value");
  });

  it("the breakdown puts them in a 'Not equity' bucket, not Value", () => {
    seedNonEquityBook();
    const buckets = getAllocationByDimension(db, "growth_vs_value");
    const byName = new Map(buckets.map((b) => [b.group_name, b]));
    expect(byName.get("Value")!.position_count).toBe(1);
    expect(byName.get("Growth")!.position_count).toBe(1);
    expect(byName.get("Not equity")!.position_count).toBe(3);
    // Two funds at 10 x 100, plus the bond at 10 x 100 / 100 (per-100-face price).
    expect(byName.get("Not equity")!.total_market_value).toBeCloseTo(2010, 6);
  });

  it("other factor dimensions keep their stored bucket for the same securities", () => {
    seedNonEquityBook();
    const buckets = getAllocationByDimension(db, "interest_rate_sensitive");
    expect(buckets.find((b) => b.group_name === "Not equity")).toBeUndefined();
  });

  it("the drill-down lists the same rows the breakdown counts", () => {
    seedNonEquityBook();
    const value = getHoldingsInBucket(db, "all", { kind: "factor", factor: "growth_vs_value", bucket: "Value" });
    expect(value.map((r) => r.symbol)).toEqual(["AAA"]);
    const notEq = getHoldingsInBucket(db, "all", { kind: "factor", factor: "growth_vs_value", bucket: "Not equity" });
    expect(notEq.map((r) => r.symbol).sort()).toEqual(["ZZB", "ZZF", "ZZM"]);
    expect(notEq.every((r) => r.factors.growth_vs_value === undefined)).toBe(true);
  });
});

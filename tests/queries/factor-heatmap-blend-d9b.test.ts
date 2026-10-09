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

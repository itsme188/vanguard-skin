// The fund growth/value repair touches only AI-classified fund rows whose
// style disagrees, and writes nothing without both flags.
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/ai/generate", () => ({ generateTextForFeature: vi.fn(), AIRefusalError: class extends Error {} }));

import { runFundGrowthValueRepair } from "@/scripts/repair-fund-growth-value-style";

function seed() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const add = (symbol: string, type: string, style: string | null, gv: string, source: string) => {
    const id = Number(
      db.prepare(`INSERT INTO securities (symbol, security_type, style) VALUES (?, ?, ?)`)
        .run(symbol, type, style).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO security_factors (security_id, growth_vs_value, factor_source) VALUES (?, ?, ?)`,
    ).run(id, gv, source);
  };
  add("SPYX", "ETF", "Blend", "Value", "auto");       // changes
  add("VTIX", "ETF", "Blend", "Growth", "auto");      // changes
  add("QQQX", "ETF", "Growth", "Growth", "auto");     // already right
  add("FUNDX", "Mutual Fund", "Blend", "Value", "csv_import"); // hand-imported: never touched
  add("STKX", "Stock", "Blend", "Growth", "auto");    // a stock: never touched
  return db;
}

const gv = (db: Database.Database, symbol: string) =>
  (db.prepare(
    `SELECT sf.growth_vs_value AS v FROM security_factors sf JOIN securities s ON s.id = sf.security_id WHERE s.symbol = ?`,
  ).get(symbol) as { v: string }).v;

describe("repair-fund-growth-value-style", () => {
  it("plans only the AI-classified fund rows that disagree with their style", () => {
    const db = seed();
    const { changes, applied } = runFundGrowthValueRepair(db);
    expect(applied).toBe(false);
    expect(changes.map((c) => `${c.symbol}:${c.from}->${c.to}`)).toEqual([
      "SPYX:Value->Blend",
      "VTIX:Growth->Blend",
    ]);
    expect(gv(db, "SPYX")).toBe("Value"); // dry run wrote nothing
  });

  it("refuses to write without the acknowledgement flag", () => {
    const db = seed();
    expect(() => runFundGrowthValueRepair(db, { apply: true })).toThrow(/acknowledge-repair/);
    expect(gv(db, "VTIX")).toBe("Growth");
  });

  it("applies the plan and leaves stocks and hand-imported rows alone", () => {
    const db = seed();
    runFundGrowthValueRepair(db, { apply: true, acknowledgeRepair: true });
    expect(gv(db, "SPYX")).toBe("Blend");
    expect(gv(db, "VTIX")).toBe("Blend");
    expect(gv(db, "FUNDX")).toBe("Value");
    expect(gv(db, "STKX")).toBe("Growth");
    expect(runFundGrowthValueRepair(db).changes).toEqual([]); // idempotent
  });
});

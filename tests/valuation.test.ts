import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { marketValue, adjustedMarketValueSQL } from "@/lib/valuation";

describe("valuation FX", () => {
  it("USD (default rate 1) is unchanged", () => {
    expect(marketValue(10, 150, "Stock", 1)).toBe(1500);        // no 5th arg
    expect(marketValue(10, 150, "Stock", 1, 1)).toBe(1500);     // explicit 1
    expect(marketValue(5, 3.5, "Option", 100)).toBe(1750);
  });

  it("applies usdPerUnit for a foreign price", () => {
    // 402340.KS: 10 sh * ₩1,731,000 * 0.000734 ≈ $12,705.54
    expect(marketValue(10, 1_731_000, "Stock", 1, 0.000734)).toBeCloseTo(12705.54, 1);
  });

  it("SQL: fx defaults to 1 (byte-identical) and multiplies when provided", () => {
    const noFx = adjustedMarketValueSQL("q", "p", "t", "m");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE x (q REAL, p REAL, t TEXT, m REAL, fx REAL)");
    db.prepare("INSERT INTO x VALUES (10, 1731000, 'Stock', 1, 0.000734)").run();
    const usd = adjustedMarketValueSQL("q", "p", "t", "m", "fx");
    const rowUsd = db.prepare(`SELECT ${usd} AS v FROM x`).get() as { v: number };
    expect(rowUsd.v).toBeCloseTo(12705.54, 1);
    const rowNoFx = db.prepare(`SELECT ${noFx} AS v FROM x`).get() as { v: number };
    expect(rowNoFx.v).toBe(1731000 * 10);
  });
});

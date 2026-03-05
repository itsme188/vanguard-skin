import { describe, it, expect } from "vitest";
import { marketValue, bondAdjustedMarketValueSQL } from "@/lib/valuation";

describe("marketValue", () => {
  it("calculates equity market value as quantity * price", () => {
    expect(marketValue(100, 50, "stock")).toBe(5000);
    expect(marketValue(100, 50, "etf")).toBe(5000);
    expect(marketValue(100, 50, "fund")).toBe(5000);
    expect(marketValue(100, 50, null)).toBe(5000);
  });

  it("calculates bond market value as quantity * price / 100", () => {
    // 10000 face value at 98.5% of par = $9,850
    expect(marketValue(10000, 98.5, "bond")).toBe(9850);
    // 10000 face value at par (100) = $10,000
    expect(marketValue(10000, 100, "bond")).toBe(10000);
    // 5000 face value at 101.25% = $5,062.50
    expect(marketValue(5000, 101.25, "bond")).toBe(5062.5);
  });

  it("handles zero quantity and zero price", () => {
    expect(marketValue(0, 100, "stock")).toBe(0);
    expect(marketValue(100, 0, "stock")).toBe(0);
    expect(marketValue(0, 98.5, "bond")).toBe(0);
    expect(marketValue(10000, 0, "bond")).toBe(0);
  });
});

describe("bondAdjustedMarketValueSQL", () => {
  it("generates correct SQL CASE expression", () => {
    const sql = bondAdjustedMarketValueSQL(
      "h.quantity",
      "p.close_price",
      "s.security_type"
    );
    expect(sql).toContain("WHEN s.security_type = 'bond'");
    expect(sql).toContain("h.quantity * p.close_price / 100.0");
    expect(sql).toContain("h.quantity * p.close_price");
  });
});

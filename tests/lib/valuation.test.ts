import { describe, it, expect } from "vitest";
import {
  marketValue,
  adjustedMarketValueSQL,
} from "@/lib/valuation";

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

  it("calculates option market value with multiplier", () => {
    // 5 contracts at $3.50 with multiplier 100 = $1,750
    expect(marketValue(5, 3.5, "option", 100)).toBe(1750);
    // 10 contracts at $12.00 with multiplier 100 = $12,000
    expect(marketValue(10, 12, "option", 100)).toBe(12000);
    // 1 mini option contract at $5.00 with multiplier 10 = $50
    expect(marketValue(1, 5, "option", 10)).toBe(50);
  });

  it("defaults multiplier to 1 for stocks/ETFs", () => {
    // Explicit multiplier of 1 should match default behavior
    expect(marketValue(100, 50, "stock", 1)).toBe(5000);
    // Default (no multiplier arg) should also be 5000
    expect(marketValue(100, 50, "stock")).toBe(5000);
  });

  it("bond pricing ignores multiplier (bonds use /100 rule)", () => {
    // Bond pricing is always qty * price / 100, regardless of multiplier
    expect(marketValue(10000, 98.5, "bond", 1)).toBe(9850);
    expect(marketValue(10000, 98.5, "bond", 100)).toBe(9850);
  });

  it("handles zero quantity and zero price", () => {
    expect(marketValue(0, 100, "stock")).toBe(0);
    expect(marketValue(100, 0, "stock")).toBe(0);
    expect(marketValue(0, 98.5, "bond")).toBe(0);
    expect(marketValue(10000, 0, "bond")).toBe(0);
    expect(marketValue(0, 3.5, "option", 100)).toBe(0);
  });
});

describe("adjustedMarketValueSQL", () => {
  it("generates SQL with multiplier expression", () => {
    const sql = adjustedMarketValueSQL(
      "h.quantity",
      "p.close_price",
      "s.security_type",
      "s.multiplier"
    );
    expect(sql).toContain("WHEN s.security_type = 'bond'");
    expect(sql).toContain("h.quantity * p.close_price / 100.0");
    expect(sql).toContain("COALESCE(s.multiplier, 1)");
  });

  it("defaults multiplier to 1 when not provided", () => {
    const sql = adjustedMarketValueSQL(
      "h.quantity",
      "p.close_price",
      "s.security_type"
    );
    expect(sql).toContain("COALESCE(1, 1)");
  });
});

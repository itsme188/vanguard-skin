import { describe, it, expect } from "vitest";
import { formatCurrency } from "@/app/dashboard/components/EquityCurveChart";

describe("EquityCurveChart formatCurrency (compact axis-tick formatter)", () => {
  it("formats millions with up to two decimals, trailing zeros trimmed", () => {
    expect(formatCurrency(1_000_000)).toBe("$1M");
    expect(formatCurrency(1_350_000)).toBe("$1.35M");
    expect(formatCurrency(1_500_000)).toBe("$1.5M");
    expect(formatCurrency(2_000_000)).toBe("$2M");
    expect(formatCurrency(10_000_000)).toBe("$10M");
    expect(formatCurrency(100_000_000)).toBe("$100M");
  });

  it("formats thousands with up to two decimals, trailing zeros trimmed (same rule as millions)", () => {
    expect(formatCurrency(12_500)).toBe("$12.5K");
    expect(formatCurrency(137_500)).toBe("$137.5K");
    expect(formatCurrency(100_000)).toBe("$100K");
  });

  it("formats sub-thousand values as plain whole dollars", () => {
    expect(formatCurrency(999)).toBe("$999");
  });

  it("pins current behavior for a negative value (drawdown series can go below zero)", () => {
    // Both magnitude branches gate on `value >= threshold`, which a negative
    // number never satisfies regardless of its size — so any negative value
    // falls through to the final plain-dollar branch today. This test pins
    // that existing behavior; it is not asserting it is the ideal UX.
    expect(formatCurrency(-1_500_000)).toBe("$-1500000");
  });
});
